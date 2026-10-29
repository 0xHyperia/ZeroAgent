package cloudchat_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

const browserFixtureBucket = "cloudchat-browser-fixture"
const browserFixtureText = "项目：ZeroAgent CloudChat 本地资料验收\n目标：用户通过 Web 上传和引用文件。\n存储：账户元数据与 S3 兼容原件分离。\n说明：本资料为合成内容，仅验证文件和引用交互。\n"

type browserFixtureStoredObject struct {
	data        []byte
	metadata    map[string]string
	contentType string
	sha256      string
}

type browserFixtureObjectEvidence struct {
	FileID string `json:"file_id"`
	SHA256 string `json:"sha256"`
	Size   int    `json:"size"`
}

type browserFixtureSourceEvidence struct {
	FileID string `json:"file_id"`
	SHA256 string `json:"sha256"`
	Lines  int    `json:"lines"`
}
type browserFixtureImageEvidence struct {
	SHA256 string `json:"sha256"`
	Bytes  int    `json:"bytes"`
}

type browserFixtureS3Status struct {
	Puts           int                            `json:"puts"`
	Gets           int                            `json:"gets"`
	Heads          int                            `json:"heads"`
	Deletes        int                            `json:"deletes"`
	SignedRequests int                            `json:"signed_requests"`
	Objects        []browserFixtureObjectEvidence `json:"objects"`
}

type browserFixtureEvidence struct {
	mu            sync.Mutex
	objects       map[string]browserFixtureStoredObject
	s3            browserFixtureS3Status
	modelRequests int
	sources       []browserFixtureSourceEvidence
	images        []browserFixtureImageEvidence
}

func newBrowserFixtureEvidence() *browserFixtureEvidence {
	return &browserFixtureEvidence{objects: make(map[string]browserFixtureStoredObject)}
}

func (f *browserFixtureEvidence) snapshot() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	status := f.s3
	status.Objects = make([]browserFixtureObjectEvidence, 0, len(f.objects))
	for _, object := range f.objects {
		status.Objects = append(status.Objects, browserFixtureObjectEvidence{FileID: object.metadata["file-id"], SHA256: object.sha256, Size: len(object.data)})
	}
	sort.Slice(status.Objects, func(i, j int) bool { return status.Objects[i].FileID < status.Objects[j].FileID })
	sources := append([]browserFixtureSourceEvidence{}, f.sources...)
	return map[string]any{"synthetic": true, "s3": status, "model_requests": f.modelRequests, "model_sources": sources, "model_images": append([]browserFixtureImageEvidence{}, f.images...), "real_external_services": false}
}

func browserFixtureS3Error(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Content-Type", "application/xml")
	w.WriteHeader(status)
	io.WriteString(w, "<Error><Code>"+code+"</Code></Error>")
}

// This is an isolated protocol peer, not a signature verifier or production S3
// emulator. It checks official SDK signing is present and enforces byte/checksum
// invariants. It never stores or reports Authorization headers or secret keys.
func (f *browserFixtureEvidence) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "AWS4-HMAC-SHA256 ") {
		browserFixtureS3Error(w, 403, "AccessDenied")
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	isFile := len(parts) == 6 && parts[3] == "files" && parts[5] == "original"
	isArtifact := len(parts) == 7 && parts[3] == "artifacts" && parts[6] == "content"
	if (!isFile && !isArtifact) || parts[0] != browserFixtureBucket || parts[1] != "accounts" || len(parts[2]) != 32 {
		browserFixtureS3Error(w, 400, "InvalidArgument")
		return
	}
	if _, err := hex.DecodeString(parts[2]); err != nil {
		browserFixtureS3Error(w, 400, "InvalidArgument")
		return
	}
	if _, err := uuid.Parse(parts[4]); err != nil {
		browserFixtureS3Error(w, 400, "InvalidArgument")
		return
	}
	if isArtifact {
		if _, err := uuid.Parse(parts[5]); err != nil {
			browserFixtureS3Error(w, 400, "InvalidArgument")
			return
		}
	}
	f.mu.Lock()
	f.s3.SignedRequests++
	f.mu.Unlock()
	switch r.Method {
	case http.MethodPut:
		data, err := io.ReadAll(io.LimitReader(r.Body, (32<<20)+1))
		if err != nil || len(data) > 32<<20 || r.ContentLength != int64(len(data)) {
			browserFixtureS3Error(w, 400, "InvalidRequest")
			return
		}
		digest := sha256.Sum256(data)
		ownerScope := parts[2]
		if isArtifact {
			ownerScope = "account-" + ownerScope
		}
		if r.Header.Get("X-Amz-Checksum-Sha256") != base64.StdEncoding.EncodeToString(digest[:]) || r.Header.Get("X-Amz-Meta-Sha256") != hex.EncodeToString(digest[:]) || r.Header.Get("X-Amz-Meta-Owner-Scope") != ownerScope || (isFile && r.Header.Get("X-Amz-Meta-File-Id") != parts[4]) || (isArtifact && (r.Header.Get("X-Amz-Meta-Artifact-Family") != parts[4] || r.Header.Get("X-Amz-Meta-Artifact-Version") != parts[5])) {
			browserFixtureS3Error(w, 400, "BadDigest")
			return
		}
		metadata := map[string]string{"sha256": hex.EncodeToString(digest[:]), "owner-scope": ownerScope}
		if isFile {
			metadata["file-id"] = parts[4]
		} else {
			metadata["artifact-family"], metadata["artifact-version"] = parts[4], parts[5]
		}
		object := browserFixtureStoredObject{data: append([]byte(nil), data...), metadata: metadata, contentType: r.Header.Get("Content-Type"), sha256: hex.EncodeToString(digest[:])}
		f.mu.Lock()
		f.s3.Puts++
		f.objects[r.URL.Path] = object
		f.mu.Unlock()
		w.Header().Set("X-Amz-Checksum-Sha256", base64.StdEncoding.EncodeToString(digest[:]))
		w.Header().Set("ETag", "\""+object.sha256+"\"")
		w.WriteHeader(200)
	case http.MethodGet, http.MethodHead:
		f.mu.Lock()
		object, ok := f.objects[r.URL.Path]
		if r.Method == http.MethodGet {
			f.s3.Gets++
		} else {
			f.s3.Heads++
		}
		f.mu.Unlock()
		if !ok {
			browserFixtureS3Error(w, 404, "NoSuchKey")
			return
		}
		for key, value := range object.metadata {
			w.Header().Set("X-Amz-Meta-"+key, value)
		}
		digest, _ := hex.DecodeString(object.sha256)
		w.Header().Set("X-Amz-Checksum-Sha256", base64.StdEncoding.EncodeToString(digest))
		w.Header().Set("Content-Length", strconv.Itoa(len(object.data)))
		w.Header().Set("Content-Type", object.contentType)
		w.Header().Set("ETag", "\""+object.sha256+"\"")
		if r.Method == http.MethodGet {
			w.Write(object.data)
		} else {
			w.WriteHeader(200)
		}
	case http.MethodDelete:
		f.mu.Lock()
		f.s3.Deletes++
		delete(f.objects, r.URL.Path)
		f.mu.Unlock()
		w.WriteHeader(204)
	default:
		browserFixtureS3Error(w, 405, "MethodNotAllowed")
	}
}

func newBrowserFixtureS3(t *testing.T, evidence *browserFixtureEvidence) *objectstore.S3Store {
	t.Helper()
	peer := httptest.NewServer(evidence)
	t.Cleanup(peer.Close)
	provider, err := objectstore.New(objectstore.Config{Endpoint: peer.URL, Bucket: browserFixtureBucket, Region: "fixture-region", AccessKeyID: "fixture-s3-access-only", SecretAccessKey: "fixture-s3-secret-only", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal("construct local S3 protocol client")
	}
	t.Cleanup(provider.Close)
	return provider
}

var browserFixtureSourcePattern = regexp.MustCompile(`<source_file id="([0-9a-f-]{36})" [^\n]*sha256="([0-9a-f]{64})">\n([\s\S]*?)</source_file>`)
var browserFixtureLinePattern = regexp.MustCompile(`(?m)^L[1-9][0-9]*: `)

func (f *browserFixtureEvidence) recordModelRequest(raw []byte) (string, error) {
	var request struct {
		Messages []struct {
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		return "", err
	}
	sources := make([]browserFixtureSourceEvidence, 0)
	images := make([]browserFixtureImageEvidence, 0)
	for _, message := range request.Messages {
		var text string
		if len(message.Content) > 0 && message.Content[0] == '"' {
			_ = json.Unmarshal(message.Content, &text)
		} else {
			var parts []struct {
				Type     string `json:"type"`
				Text     string `json:"text"`
				ImageURL struct {
					URL string `json:"url"`
				} `json:"image_url"`
			}
			if err := json.Unmarshal(message.Content, &parts); err != nil {
				return "", err
			}
			for _, part := range parts {
				if part.Type == "text" {
					text += part.Text
				}
				if part.Type == "image_url" {
					_, encoded, ok := strings.Cut(part.ImageURL.URL, ",")
					if !ok {
						continue
					}
					data, err := base64.StdEncoding.Strict().DecodeString(encoded)
					if err != nil {
						continue
					}
					digest := sha256.Sum256(data)
					images = append(images, browserFixtureImageEvidence{SHA256: hex.EncodeToString(digest[:]), Bytes: len(data)})
				}
			}
		}
		for _, match := range browserFixtureSourcePattern.FindAllStringSubmatch(text, -1) {
			if _, err := uuid.Parse(match[1]); err != nil {
				continue
			}
			lines := len(browserFixtureLinePattern.FindAllStringIndex(match[3], -1))
			if lines > 0 {
				sources = append(sources, browserFixtureSourceEvidence{FileID: match[1], SHA256: match[2], Lines: lines})
			}
		}
	}
	f.mu.Lock()
	f.modelRequests++
	f.sources = append(f.sources, sources...)
	f.images = append(f.images, images...)
	f.mu.Unlock()
	if len(sources) == 0 {
		return "", nil
	}
	last := 3
	if sources[0].Lines < last {
		last = sources[0].Lines
	}
	return "\n\n合成来源引用（仅验证文件交互）：【文件:" + sources[0].FileID + ":L1-L" + strconv.Itoa(last) + "】", nil
}

func TestBrowserSyntheticSourceReferences(t *testing.T) {
	f := newBrowserFixtureEvidence()
	id := "11111111-1111-4111-8111-111111111111"
	text := "<source_file id=\"" + id + "\" name=\"synthetic.txt\" sha256=\"" + strings.Repeat("a", 64) + "\">\nL1: A\nL2: B\nL3: C\n</source_file>"
	raw, _ := json.Marshal(map[string]any{"messages": []any{map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": text}}}}})
	citation, err := f.recordModelRequest(raw)
	if err != nil || !strings.Contains(citation, "【文件:"+id+":L1-L3】") {
		t.Fatal("synthetic source reference was not parsed from the actual model payload")
	}
	status, _ := json.Marshal(f.snapshot())
	if bytes.Contains(status, []byte("L1: A")) || bytes.Contains(status, []byte("source_file")) {
		t.Fatal("fixture evidence exposed document body")
	}
}

func TestBrowserS3ProtocolHandler(t *testing.T) {
	evidence := newBrowserFixtureEvidence()
	id := "11111111-1111-4111-8111-111111111111"
	scope := strings.Repeat("a", 32)
	objectPath := "/" + browserFixtureBucket + "/accounts/" + scope + "/files/" + id + "/original"
	digest := sha256.Sum256([]byte(browserFixtureText))
	put := httptest.NewRequest(http.MethodPut, objectPath, strings.NewReader(browserFixtureText))
	put.Header.Set("Authorization", "AWS4-HMAC-SHA256 synthetic-test-only")
	put.Header.Set("Content-Type", "text/plain")
	put.Header.Set("X-Amz-Checksum-Sha256", base64.StdEncoding.EncodeToString(digest[:]))
	put.Header.Set("X-Amz-Meta-Sha256", hex.EncodeToString(digest[:]))
	put.Header.Set("X-Amz-Meta-File-Id", id)
	put.Header.Set("X-Amz-Meta-Owner-Scope", scope)
	recorder := httptest.NewRecorder()
	evidence.ServeHTTP(recorder, put)
	if recorder.Code != 200 {
		t.Fatal("protocol peer rejected an integrity-bound original")
	}
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodDelete} {
		request := httptest.NewRequest(method, objectPath, nil)
		request.Header.Set("Authorization", "AWS4-HMAC-SHA256 synthetic-test-only")
		recorder = httptest.NewRecorder()
		evidence.ServeHTTP(recorder, request)
		if method == http.MethodGet && (recorder.Code != 200 || recorder.Body.String() != browserFixtureText) {
			t.Fatal("protocol original readback differed")
		}
		if method == http.MethodHead && (recorder.Code != 200 || recorder.Body.Len() != 0 || recorder.Header().Get("Content-Length") != strconv.Itoa(len(browserFixtureText))) {
			t.Fatal("protocol original HEAD differed")
		}
		if method == http.MethodDelete && recorder.Code != 204 {
			t.Fatal("protocol original deletion failed")
		}
	}
	status, _ := json.Marshal(evidence.snapshot())
	for _, private := range []string{browserFixtureText, "AWS4-HMAC-SHA256", "accounts/", "owner-scope", "synthetic-test-only"} {
		if bytes.Contains(status, []byte(private)) {
			t.Fatal("status exposed private protocol details")
		}
	}
	if !bytes.Contains(status, []byte(`"objects":[]`)) {
		t.Fatal("deleted object still visible in protocol evidence")
	}
}
