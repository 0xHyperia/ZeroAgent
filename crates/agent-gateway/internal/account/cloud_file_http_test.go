package account

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/objectstore"
)

type cloudFileTestObject struct {
	data    []byte
	headers http.Header
}
type cloudFileHTTPFixture struct {
	store        *MemoryStore
	service      *Service
	objects      *objectstore.S3Store
	server       *httptest.Server
	conversation *CloudConversation
	mu           sync.Mutex
	data         map[string]cloudFileTestObject
	calls        int
	deleteFails  bool
	corruptGet   bool
	putEntered   chan struct{}
	putRelease   chan struct{}
}

func newCloudFileHTTPFixture(t *testing.T) *cloudFileHTTPFixture {
	t.Helper()
	f := &cloudFileHTTPFixture{store: NewMemoryStore(), data: make(map[string]cloudFileTestObject)}
	s3 := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
			t.Error("S3 request lacks official SDK signing")
		}
		if !strings.HasPrefix(r.URL.Path, "/synthetic-bucket/accounts/") {
			t.Error("S3 key is not server scoped")
		}
		f.mu.Lock()
		f.calls++
		f.mu.Unlock()
		if r.Method == http.MethodPut {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			if f.putEntered != nil {
				close(f.putEntered)
				<-f.putRelease
			}
			f.mu.Lock()
			f.data[r.URL.Path] = cloudFileTestObject{data: body, headers: r.Header.Clone()}
			f.mu.Unlock()
			w.Header().Set("X-Amz-Checksum-Sha256", r.Header.Get("X-Amz-Checksum-Sha256"))
			w.WriteHeader(200)
			return
		}
		f.mu.Lock()
		object, exists := f.data[r.URL.Path]
		deleteFails, corrupt := f.deleteFails, f.corruptGet
		if r.Method == http.MethodDelete && !deleteFails {
			delete(f.data, r.URL.Path)
		}
		f.mu.Unlock()
		if r.Method == http.MethodDelete {
			if deleteFails {
				w.WriteHeader(503)
				io.WriteString(w, "<Error><Code>ServiceUnavailable</Code><Message>synthetic-private-storage-error</Message></Error>")
				return
			}
			w.WriteHeader(204)
			return
		}
		if !exists {
			w.WriteHeader(404)
			io.WriteString(w, "<Error><Code>NoSuchKey</Code></Error>")
			return
		}
		for key, values := range object.headers {
			if strings.HasPrefix(strings.ToLower(key), "x-amz-meta-") {
				w.Header()[key] = values
			}
		}
		w.Header().Set("Content-Type", object.headers.Get("Content-Type"))
		w.Header().Set("Content-Length", strconv.Itoa(len(object.data)))
		w.Header().Set("X-Amz-Checksum-Sha256", object.headers.Get("X-Amz-Checksum-Sha256"))
		if r.Method == http.MethodHead {
			w.WriteHeader(200)
			return
		}
		body := append([]byte(nil), object.data...)
		if corrupt && len(body) > 0 {
			body[0] ^= 1
		}
		w.Write(body)
	}))
	t.Cleanup(s3.Close)
	var err error
	f.objects, err = objectstore.New(objectstore.Config{Endpoint: s3.URL, Bucket: "synthetic-bucket", Region: "test-region", AccessKeyID: "synthetic-access-id", SecretAccessKey: "synthetic-secret-key", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.objects.Close)
	usa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("file API called account/model upstream: %s", r.URL.Path)
		w.WriteHeader(500)
	}))
	t.Cleanup(usa.Close)
	f.service = NewService(f.store, NewUSAClientWithHTTPClient(usa.URL, usa.Client()), time.Hour, time.Hour)
	if err = f.service.SetCloudObjectStore(f.objects); err != nil {
		t.Fatal(err)
	}
	for _, session := range []*Session{{ID: "file-owner", UserID: 1, AccessToken: "synthetic-account-token", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}, {ID: "file-other", UserID: 2, AccessToken: "synthetic-account-other", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}} {
		if err = f.store.PutSession(context.Background(), session); err != nil {
			t.Fatal(err)
		}
	}
	f.conversation, err = f.service.CreateCloudConversation(context.Background(), 1, "test-model")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, false).registerCloudFiles(mux)
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	return f
}

func (f *cloudFileHTTPFixture) request(t *testing.T, method, path, cookie string, body io.Reader, headers http.Header) (int, []byte, http.Header) {
	t.Helper()
	req, err := http.NewRequest(method, f.server.URL+path, body)
	if err != nil {
		t.Fatal(err)
	}
	req.Header = headers.Clone()
	if req.Header == nil {
		req.Header = make(http.Header)
	}
	if cookie != "" {
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: cookie})
	}
	response, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"accounts/", "synthetic-secret-key", "synthetic-account-token", "synthetic-private-storage-error", "object_key"} {
		if strings.Contains(string(data), secret) {
			t.Fatalf("private file detail leaked: %s", secret)
		}
	}
	return response.StatusCode, data, response.Header
}

func cloudFileMultipart(t *testing.T, conversationID, name string, data []byte) (*bytes.Buffer, http.Header) {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if err := writer.WriteField("conversation_id", conversationID); err != nil {
		t.Fatal(err)
	}
	part, err := writer.CreateFormFile("file", name)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = part.Write(data); err != nil {
		t.Fatal(err)
	}
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	return body, http.Header{"Content-Type": []string{writer.FormDataContentType()}}
}

func (f *cloudFileHTTPFixture) upload(t *testing.T, name string, data []byte) *CloudFile {
	t.Helper()
	body, headers := cloudFileMultipart(t, f.conversation.ID, name, data)
	status, response, _ := f.request(t, "POST", "/api/web-chat/files", "file-owner", body, headers)
	if status != 201 {
		t.Fatalf("upload status=%d body=%s", status, response)
	}
	var result struct {
		File *CloudFile `json:"file"`
	}
	if err := json.Unmarshal(response, &result); err != nil || result.File == nil {
		t.Fatalf("upload response: %v", err)
	}
	return result.File
}

func TestCloudFileHTTPOriginalLifecycle(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	original := []byte("# Notes\n你好 CloudChat\n")
	file := f.upload(t, "工作笔记.md", original)
	if file.State != CloudFileReady || file.TextBytes != len(original) || file.UploadedAt == nil {
		t.Fatalf("not extracted and persisted: %+v", file)
	}
	stored, err := f.store.GetCloudFile(context.Background(), 1, file.ID)
	if err != nil || stored.Text != string(original) {
		t.Fatalf("extracted text: %v", err)
	}
	status, data, headers := f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/download", "file-owner", nil, nil)
	if status != 200 || !bytes.Equal(data, original) || !strings.HasPrefix(headers.Get("Content-Disposition"), "attachment;") || headers.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("download status=%d headers=%v", status, headers)
	}
	for _, path := range []string{"/api/web-chat/files/" + file.ID, "/api/web-chat/files/" + file.ID + "/download", "/api/web-chat/files?conversation_id=" + file.ConversationID} {
		status, _, _ = f.request(t, "GET", path, "file-other", nil, nil)
		if status != 404 {
			t.Fatalf("foreign read %s status %d", path, status)
		}
	}
	status, _, _ = f.request(t, "DELETE", "/api/web-chat/files/"+file.ID, "file-other", nil, nil)
	if status != 404 {
		t.Fatalf("foreign delete=%d", status)
	}
	if err = f.store.DeleteCloudConversation(context.Background(), 1, file.ConversationID); err != nil {
		t.Fatal(err)
	}
	status, data, _ = f.request(t, "GET", "/api/web-chat/files", "file-owner", nil, nil)
	if status != 200 || !bytes.Contains(data, []byte(file.ID)) {
		t.Fatal("conversation removal lost file library")
	}
	status, _, _ = f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/download", "file-owner", nil, nil)
	if status != 200 {
		t.Fatal("orphaned conversation original unavailable")
	}
	status, _, _ = f.request(t, "DELETE", "/api/web-chat/files/"+file.ID, "file-owner", nil, http.Header{"If-Match": []string{"\"1\""}})
	if status != 409 {
		t.Fatal("stale delete version accepted")
	}
	status, _, _ = f.request(t, "DELETE", "/api/web-chat/files/"+file.ID, "file-owner", nil, nil)
	if status != 200 {
		t.Fatal("delete failed")
	}
	status, _, _ = f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/download", "file-owner", nil, nil)
	if status != 404 {
		t.Fatal("deleted file downloadable")
	}
	stored, err = f.store.GetCloudFile(context.Background(), 1, file.ID)
	if err != nil || stored.State != CloudFileDeleted || stored.DeletedAt == nil {
		t.Fatal("delete tombstone not preserved")
	}
	f.mu.Lock()
	remaining := len(f.data)
	f.mu.Unlock()
	if remaining != 0 {
		t.Fatal("original object survived confirmed delete")
	}
}

func TestCloudFileHTTPFormatsRemainHonest(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	for _, input := range []struct {
		name string
		data []byte
	}{{"reference.pdf", []byte("%PDF-1.7\nsynthetic unparsed bytes")}, {"reference.docx", []byte{'P', 'K', 3, 4, 0, 0, 0, 0}}} {
		file := f.upload(t, input.name, input.data)
		if file.State != CloudFileUploaded || file.ProcessingStage != "awaiting_isolated_parser" || file.TextBytes != 0 {
			t.Fatal("binary document pretended to be parsed")
		}
	}
	file := f.upload(t, "bad-encoding.txt", []byte{0xff, 0xfe, 0, 1})
	if file.State != CloudFileFailed || file.ErrorCode != "unsupported_text_encoding" || file.UploadedAt == nil {
		t.Fatal("invalid UTF-8 was not separated from original upload")
	}
	status, data, _ := f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/download", "file-owner", nil, nil)
	if status != 200 || !bytes.Equal(data, []byte{0xff, 0xfe, 0, 1}) {
		t.Fatal("extraction failure lost original")
	}
	large := f.upload(t, "large.txt", bytes.Repeat([]byte("a"), CloudFileMaxTextBytes+1))
	if large.State != CloudFileUploaded || large.ProcessingStage != "awaiting_isolated_parser" {
		t.Fatal("large text parsed without bounded extraction")
	}
	f.mu.Lock()
	before := f.calls
	f.mu.Unlock()
	for _, input := range []struct {
		name string
		data []byte
	}{{"pretend.pdf", []byte("text")}, {"program.exe", []byte("MZ")}, {"spoof.png", []byte("not an image")}} {
		body, headers := cloudFileMultipart(t, f.conversation.ID, input.name, input.data)
		status, _, _ = f.request(t, "POST", "/api/web-chat/files", "file-owner", body, headers)
		if status != 400 {
			t.Fatalf("invalid format accepted: %s", input.name)
		}
	}
	f.mu.Lock()
	after := f.calls
	f.mu.Unlock()
	if after != before {
		t.Fatal("invalid format reached object store")
	}
}

func TestCloudFileHTTPDeleteRetryAndRecovery(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	file := f.upload(t, "delete.txt", []byte("original"))
	f.mu.Lock()
	f.deleteFails = true
	f.mu.Unlock()
	status, _, _ := f.request(t, "DELETE", "/api/web-chat/files/"+file.ID, "file-owner", nil, nil)
	if status != 503 {
		t.Fatalf("delete failure=%d", status)
	}
	stored, _ := f.store.GetCloudFile(context.Background(), 1, file.ID)
	if stored.State != CloudFileDeleting || stored.ErrorCode != "delete_failed" || stored.DeletedAt == nil {
		t.Fatal("delete failure discarded intent")
	}
	status, _, _ = f.request(t, "GET", "/api/web-chat/files/"+file.ID, "file-owner", nil, nil)
	if status != 404 {
		t.Fatal("pending deletion remained readable")
	}
	f.mu.Lock()
	f.deleteFails = false
	f.mu.Unlock()
	// A new service instance retries the durable metadata, with no in-memory queue.
	restarted := NewService(f.store, f.service.usa, time.Hour, time.Hour)
	if err := restarted.SetCloudObjectStore(f.objects); err != nil {
		t.Fatal(err)
	}
	if err := restarted.ReconcileCloudFiles(context.Background(), 50); err != nil {
		t.Fatal(err)
	}
	stored, _ = f.store.GetCloudFile(context.Background(), 1, file.ID)
	if stored.State != CloudFileDeleted {
		t.Fatal("durable delete did not recover")
	}
	stale, err := f.store.CreateCloudFile(context.Background(), newCloudFileRecord(1, f.conversation.ID))
	if err != nil {
		t.Fatal(err)
	}
	f.store.mu.Lock()
	copy := f.store.cloudFiles[stale.ID]
	copy.UpdatedAt = time.Now().Add(-20 * time.Minute)
	f.store.cloudFiles[stale.ID] = copy
	f.store.mu.Unlock()
	if err = restarted.ReconcileCloudFiles(context.Background(), 50); err != nil {
		t.Fatal(err)
	}
	stale, _ = f.store.GetCloudFile(context.Background(), 1, stale.ID)
	if stale.State != CloudFileFailed || stale.UploadedAt != nil {
		t.Fatal("abandoned upload remained stuck or falsely ready")
	}
}

func TestCloudFileHTTPIntegrityRejectsBeforeDownload(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	file := f.upload(t, "integrity.txt", []byte("original"))
	f.mu.Lock()
	f.corruptGet = true
	f.mu.Unlock()
	status, data, _ := f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/download", "file-owner", nil, nil)
	if status != 502 || bytes.Equal(data, []byte("original")) {
		t.Fatalf("corrupt download accepted status=%d", status)
	}
	body, headers := cloudFileMultipart(t, f.conversation.ID, "corrupt-upload.txt", []byte("content"))
	status, _, _ = f.request(t, "POST", "/api/web-chat/files", "file-owner", body, headers)
	if status != 502 {
		t.Fatalf("corrupt uploaded original accepted status=%d", status)
	}
	files, _ := f.store.ListCloudFiles(context.Background(), 1, "", "", 50)
	found := false
	for _, item := range files {
		if item.Name == "corrupt-upload.txt" {
			found = true
			if item.State != CloudFileFailed || item.UploadedAt != nil {
				t.Fatal("verification failure became downloadable")
			}
		}
	}
	if !found {
		t.Fatal("failed upload metadata disappeared")
	}
}

func TestCloudFileHTTPLatePutCannotResurrectDeletedFile(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	f.putEntered = make(chan struct{})
	f.putRelease = make(chan struct{})
	body, headers := cloudFileMultipart(t, f.conversation.ID, "race.txt", []byte("late original"))
	result := make(chan int, 1)
	go func() {
		status, _, _ := f.request(t, "POST", "/api/web-chat/files", "file-owner", body, headers)
		result <- status
	}()
	select {
	case <-f.putEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("PUT did not start")
	}
	files, err := f.store.ListCloudFiles(context.Background(), 1, "", "", 10)
	if err != nil || len(files) != 1 {
		t.Fatal("upload intent not persisted before PUT")
	}
	file := files[0]
	status, _, _ := f.request(t, "DELETE", "/api/web-chat/files/"+file.ID, "file-owner", nil, nil)
	if status != 200 {
		t.Fatal("delete pending PUT failed")
	}
	close(f.putRelease)
	select {
	case status = <-result:
		if status != 409 {
			t.Fatalf("late upload status=%d", status)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("late upload stuck")
	}
	stored, _ := f.store.GetCloudFile(context.Background(), 1, file.ID)
	if stored.State != CloudFileDeleted || stored.DeletedAt == nil {
		t.Fatal("late PUT cleared tombstone")
	}
	f.mu.Lock()
	remaining := len(f.data)
	f.mu.Unlock()
	if remaining != 0 {
		t.Fatal("late object escaped cleanup")
	}
}

func TestCloudFileHTTPDisabledAuthCSRFAndLimits(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	body, headers := cloudFileMultipart(t, f.conversation.ID, "notes.txt", []byte("x"))
	status, _, _ := f.request(t, "POST", "/api/web-chat/files", "", body, headers)
	if status != 401 {
		t.Fatal("upload did not require session")
	}
	body, headers = cloudFileMultipart(t, f.conversation.ID, "notes.txt", []byte("x"))
	headers.Set("Origin", "https://other.example")
	status, _, _ = f.request(t, "POST", "/api/web-chat/files", "file-owner", body, headers)
	if status != 403 {
		t.Fatal("cross-origin upload accepted")
	}
	body, headers = cloudFileMultipart(t, f.conversation.ID, "notes.txt", []byte("x"))
	status, _, _ = f.request(t, "POST", "/api/web-chat/files", "file-other", body, headers)
	if status != 404 {
		t.Fatal("foreign conversation accepted")
	}
	provider, _ := f.service.cloudFileProvider()
	for range 4 {
		provider.uploads <- struct{}{}
	}
	body, headers = cloudFileMultipart(t, f.conversation.ID, "notes.txt", []byte("x"))
	status, _, _ = f.request(t, "POST", "/api/web-chat/files", "file-owner", body, headers)
	if status != 429 {
		t.Fatal("upload concurrency unbounded")
	}
	for range 4 {
		<-provider.uploads
	}
	body, headers = cloudFileMultipart(t, f.conversation.ID, "large.txt", bytes.Repeat([]byte("a"), CloudFileMaxBytes+1))
	status, _, _ = f.request(t, "POST", "/api/web-chat/files", "file-owner", body, headers)
	if status != 413 {
		t.Fatalf("oversized upload=%d", status)
	}
	disabled, _ := objectstore.New(objectstore.Config{})
	f.service.cloudFileMu.Lock()
	f.service.cloudFiles = nil
	f.service.cloudFileMu.Unlock()
	if err := f.service.SetCloudObjectStore(disabled); err != nil {
		t.Fatal(err)
	}
	body, headers = cloudFileMultipart(t, f.conversation.ID, "notes.txt", []byte("x"))
	status, _, _ = f.request(t, "POST", "/api/web-chat/files", "file-owner", body, headers)
	if status != 503 {
		t.Fatal("unconfigured storage pretended available")
	}
	if err := f.service.SetCloudObjectStore(f.objects); err != ErrCloudFileConflict {
		t.Fatal("active storage provider replacement allowed")
	}
	f.mu.Lock()
	calls := f.calls
	f.mu.Unlock()
	if calls != 0 {
		t.Fatalf("rejected upload reached S3 %d times", calls)
	}
}
