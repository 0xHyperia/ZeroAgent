package cloudchat_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

type s3AcceptanceConfig struct {
	Endpoint, Bucket, Region, AccessKeyID, SecretAccessKey, TaskID string
}

type s3AcceptanceEvidence struct {
	Phase                 string   `json:"phase"`
	Passed                []string `json:"passed"`
	ObjectBytes           int      `json:"object_bytes"`
	ObjectSHA256          string   `json:"object_sha256"`
	OwnerAKeySHA256       string   `json:"owner_a_key_sha256"`
	OwnerBKeySHA256       string   `json:"owner_b_key_sha256"`
	ChineseFilenameSHA256 string   `json:"chinese_filename_sha256"`
}

func acceptanceDigest(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

// Opt-in real-service acceptance. The companion script starts one disposable
// official Garage container and calls prepare -> restart -> verify. Ordinary
// go test never loads credentials, contacts S3, starts Docker, or pays a vendor.
func TestGarageS3Compatibility(t *testing.T) {
	privateFile := os.Getenv("ZEROAGENT_GARAGE_TEST_CONFIG_FILE")
	if privateFile == "" {
		t.Skip("explicit disposable Garage service not requested")
	}
	data, err := os.ReadFile(privateFile)
	if err != nil || len(data) > 16<<10 {
		t.Fatal("read private Garage test configuration")
	}
	var cfg s3AcceptanceConfig
	if json.Unmarshal(data, &cfg) != nil {
		t.Fatal("invalid private Garage test configuration")
	}
	endpoint, err := url.Parse(cfg.Endpoint)
	if err != nil || endpoint.Scheme != "http" || net.ParseIP(endpoint.Hostname()) == nil || !net.ParseIP(endpoint.Hostname()).IsLoopback() || !strings.HasPrefix(cfg.Bucket, "za-garage-test-") || !regexp.MustCompile(`^[a-f0-9]{16}$`).MatchString(cfg.TaskID) {
		t.Fatal("real Garage acceptance requires an isolated numeric loopback test target")
	}
	phase := os.Getenv("ZEROAGENT_GARAGE_TEST_PHASE")
	if phase != "prepare" && phase != "verify" {
		t.Fatal("Garage test phase must be prepare or verify")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	options := objectstore.Config{Endpoint: cfg.Endpoint, Bucket: cfg.Bucket, Region: cfg.Region, AccessKeyID: cfg.AccessKeyID, SecretAccessKey: cfg.SecretAccessKey, AllowLoopbackHTTP: true, MaxObjectBytes: 32 << 20, TempDir: t.TempDir()}
	store, err := objectstore.New(options)
	if err != nil || !store.Status().Enabled {
		t.Fatal("construct explicitly configured real S3 adapter")
	}
	defer store.Close()
	// Readiness is signed and remains bounded even while the real server starts.
	for deadline := time.Now().Add(30 * time.Second); ; {
		if err = store.Ready(ctx); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("real S3 readiness failed: %v", err)
		}
		select {
		case <-ctx.Done():
			t.Fatal("real S3 readiness timed out")
		case <-time.After(100 * time.Millisecond):
		}
	}
	big := make([]byte, 32<<20)
	for index := range big {
		big[index] = byte((index*31 + 17) % 251)
	}
	ownerA := acceptanceDigest([]byte(cfg.TaskID + ":owner-a"))[:32]
	ownerB := acceptanceDigest([]byte(cfg.TaskID + ":owner-b"))[:32]
	keyA := "accounts/" + ownerA + "/acceptance/immutable-original"
	keyB := "accounts/" + ownerB + "/acceptance/immutable-original"
	filename := "中文资料-互通验收.txt"
	encodedName := base64.StdEncoding.EncodeToString([]byte(filename))
	evidence := s3AcceptanceEvidence{Phase: phase, Passed: []string{"explicit_configuration", "signed_bucket_readiness"}, ObjectBytes: len(big), ObjectSHA256: acceptanceDigest(big), OwnerAKeySHA256: acceptanceDigest([]byte(keyA)), OwnerBKeySHA256: acceptanceDigest([]byte(keyB)), ChineseFilenameSHA256: acceptanceDigest([]byte(filename))}
	if phase == "prepare" {
		_, err := store.Put(ctx, keyA, bytes.NewReader(big), int64(len(big)), objectstore.PutOptions{ContentType: "application/octet-stream", SHA256: evidence.ObjectSHA256, Metadata: map[string]string{"display-name-utf8-base64": encodedName, "owner-scope": ownerA}})
		if err != nil {
			t.Fatalf("real S3 32 MiB upload failed: %v", err)
		}
		evidence.Passed = append(evidence.Passed, "signed_put_32mib")
		other := []byte("synthetic isolated owner B bytes")
		if _, err = store.Put(ctx, keyB, bytes.NewReader(other), int64(len(other)), objectstore.PutOptions{Metadata: map[string]string{"owner-scope": ownerB}}); err != nil {
			t.Fatalf("real S3 second owner upload failed: %v", err)
		}
		// S3 metadata headers are intentionally ASCII. Unicode display names
		// remain canonical DB values; an explicitly encoded descriptive header
		// can safely preserve their UTF-8 without changing production policy.
		if _, err = store.Put(ctx, keyA+"-invalid-metadata", strings.NewReader("x"), 1, objectstore.PutOptions{Metadata: map[string]string{"display-name": filename}}); !errors.Is(err, objectstore.ErrInvalidMetadata) {
			t.Fatal("direct Unicode S3 metadata unexpectedly accepted")
		}
		evidence.Passed = append(evidence.Passed, "unicode_header_rejected_before_transport")
		badOptions := options
		badOptions.SecretAccessKey = strings.Repeat("0", 64)
		badStore, err := objectstore.New(badOptions)
		if err != nil {
			t.Fatal("construct invalid-signature test client")
		}
		defer badStore.Close()
		if _, err = badStore.Head(ctx, keyA); !errors.Is(err, objectstore.ErrAccessDenied) {
			t.Fatalf("real service failed to reject an incorrect signature: %v", err)
		}
		evidence.Passed = append(evidence.Passed, "real_service_rejects_incorrect_signature")
	} else {
		evidence.Passed = append(evidence.Passed, "same_keys_after_container_restart")
	}
	info, err := store.Head(ctx, keyA)
	if err != nil || info.Size != int64(len(big)) || info.SHA256 != evidence.ObjectSHA256 || info.Metadata["display-name-utf8-base64"] != encodedName || info.Metadata["owner-scope"] != ownerA {
		t.Fatalf("real S3 head or encoded metadata mismatch: %v", err)
	}
	decodedName, err := base64.StdEncoding.Strict().DecodeString(info.Metadata["display-name-utf8-base64"])
	if err != nil || string(decodedName) != filename {
		t.Fatal("Chinese filename metadata did not survive UTF-8 encoding")
	}
	object, err := store.Get(ctx, keyA)
	if err != nil {
		t.Fatalf("real S3 download failed: %v", err)
	}
	hasher := sha256.New()
	count, readErr := io.Copy(hasher, object.Body)
	closeErr := object.Body.Close()
	if readErr != nil || closeErr != nil || count != int64(len(big)) || hex.EncodeToString(hasher.Sum(nil)) != evidence.ObjectSHA256 {
		t.Fatal("real S3 download was not complete and integrity verified")
	}
	evidence.Passed = append(evidence.Passed, "head_size_sha_and_encoded_chinese_metadata", "get_32mib_through_verified_eof")
	if phase == "verify" {
		if err = store.Delete(ctx, keyA); err != nil {
			t.Fatalf("real S3 delete failed: %v", err)
		}
		if _, err = store.Head(ctx, keyA); !errors.Is(err, objectstore.ErrNotFound) {
			t.Fatal("deleted owner A key remained available")
		}
		other, err := store.Get(ctx, keyB)
		if err != nil {
			t.Fatal("owner A deletion affected owner B key")
		}
		body, readErr := io.ReadAll(other.Body)
		closeErr := other.Body.Close()
		if readErr != nil || closeErr != nil || string(body) != "synthetic isolated owner B bytes" || other.Metadata["owner-scope"] != ownerB {
			t.Fatal("distinct owner object was overwritten or corrupted")
		}
		if err = store.Delete(ctx, keyB); err != nil {
			t.Fatal("delete second test object")
		}
		evidence.Passed = append(evidence.Passed, "delete_and_404", "distinct_owner_keys_survive_other_deletion")
		cloudFileHTTPStorageContract(t, store, cfg, &evidence)
	}
	output := os.Getenv("ZEROAGENT_GARAGE_TEST_EVIDENCE_FILE")
	if output == "" {
		t.Fatal("explicit Garage evidence output required")
	}
	encoded, err := json.MarshalIndent(evidence, "", "  ")
	if err != nil || strings.Contains(string(encoded), cfg.SecretAccessKey) || strings.Contains(string(encoded), cfg.AccessKeyID) {
		t.Fatal("unsafe Garage evidence")
	}
	if os.WriteFile(output, append(encoded, '\n'), 0600) != nil {
		t.Fatal("write safe Garage evidence")
	}
	t.Logf("real Garage phase=%s verified_bytes=%d sha256=%s", phase, len(big), evidence.ObjectSHA256)
}

func cloudFileHTTPStorageContract(t *testing.T, objects *objectstore.S3Store, cfg s3AcceptanceConfig, evidence *s3AcceptanceEvidence) {
	t.Helper()
	ctx := context.Background()
	metadata := account.NewMemoryStore()
	service := account.NewService(metadata, nil, time.Hour, time.Hour)
	service.EnableCloudWorkspace()
	t.Cleanup(service.CloseCloudRuns)
	if service.SetCloudObjectStore(objects) != nil {
		t.Fatal("configure real storage for production file HTTP handler")
	}
	var ownerCookie, otherCookie string
	for _, uid := range []int64{901, 902} {
		session := &account.Session{ID: uuid.NewString(), UserID: uid, AccessToken: "synthetic-garage-account-only", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
		if metadata.PutSession(ctx, session) != nil {
			t.Fatal("store synthetic authenticated account")
		}
		if uid == 901 {
			ownerCookie = session.ID
		} else {
			otherCookie = session.ID
		}
	}
	conversation, err := service.CreateCloudConversation(ctx, 901, "synthetic-model")
	if err != nil {
		t.Fatal("create canonical file conversation")
	}
	mux := http.NewServeMux()
	account.NewHTTPHandler(service, false).Register(mux)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	request := func(method, path, cookie string, body io.Reader, headers http.Header) (int, []byte, http.Header) {
		t.Helper()
		req, err := http.NewRequest(method, server.URL+path, body)
		if err != nil {
			t.Fatal("create real file handler request")
		}
		req.Header = headers.Clone()
		if req.Header == nil {
			req.Header = make(http.Header)
		}
		req.Header.Set("Origin", server.URL)
		req.AddCookie(&http.Cookie{Name: account.SessionCookieName, Value: cookie})
		response, err := server.Client().Do(req)
		if err != nil {
			t.Fatal("perform real file handler request")
		}
		defer response.Body.Close()
		result, err := io.ReadAll(io.LimitReader(response.Body, 128<<10))
		if err != nil {
			t.Fatal("read file handler response")
		}
		for _, forbidden := range []string{cfg.SecretAccessKey, cfg.AccessKeyID, "object_key", "accounts/", ownerCookie, otherCookie, "synthetic-garage-account-only"} {
			if strings.Contains(string(result), forbidden) {
				t.Fatal("private storage or account authority leaked into file response")
			}
		}
		return response.StatusCode, result, response.Header
	}
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	if writer.WriteField("conversation_id", conversation.ID) != nil {
		t.Fatal("construct file form")
	}
	filename := "中文原件-真实互通.txt"
	part, err := writer.CreateFormFile("file", filename)
	if err != nil {
		t.Fatal("construct Unicode display filename")
	}
	original := []byte("合成原件，仅验收真实 S3 与账户文件 HTTP 链条。\n")
	if _, err := part.Write(original); err != nil {
		t.Fatal("write synthetic upload bytes")
	}
	if writer.Close() != nil {
		t.Fatal("finish synthetic form")
	}
	status, data, _ := request("POST", "/api/web-chat/files", ownerCookie, body, http.Header{"Content-Type": []string{writer.FormDataContentType()}})
	if status != http.StatusCreated {
		t.Fatalf("production file upload with real S3 status=%d", status)
	}
	var result struct {
		File *account.CloudFile `json:"file"`
	}
	if json.Unmarshal(data, &result) != nil || result.File == nil || result.File.Name != filename || result.File.State != account.CloudFileReady || result.File.SHA256 != acceptanceDigest(original) {
		t.Fatal("real S3 canonical file response lost name, ready state, or digest")
	}
	file := result.File
	for _, path := range []string{"/api/web-chat/files/" + file.ID, "/api/web-chat/files/" + file.ID + "/download"} {
		if status, _, _ := request("GET", path, otherCookie, nil, nil); status != http.StatusNotFound {
			t.Fatal("foreign account could read a file")
		}
	}
	if status, _, _ := request("DELETE", "/api/web-chat/files/"+file.ID, otherCookie, nil, nil); status != http.StatusNotFound {
		t.Fatal("foreign account could delete a file")
	}
	status, data, headers := request("GET", "/api/web-chat/files/"+file.ID+"/download", ownerCookie, nil, http.Header{"Accept": []string{"application/octet-stream"}})
	if status != http.StatusOK || !bytes.Equal(data, original) || !strings.HasPrefix(headers.Get("Content-Disposition"), "attachment;") || headers.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatal("owned binary download did not safely preserve original bytes")
	}
	stored, err := metadata.GetCloudFile(ctx, 901, file.ID)
	if err != nil || stored.ObjectKey == "" {
		t.Fatal("canonical file has no server-owned object key")
	}
	if status, _, _ := request("DELETE", "/api/web-chat/files/"+file.ID, ownerCookie, nil, nil); status != http.StatusOK {
		t.Fatal("explicit owned file deletion was not confirmed")
	}
	if _, err := objects.Head(ctx, stored.ObjectKey); !errors.Is(err, objectstore.ErrNotFound) {
		t.Fatal("explicit file deletion left its original object readable")
	}
	evidence.Passed = append(evidence.Passed, "production_file_http_upload_and_ready", "canonical_chinese_display_name", "account_foreign_read_delete_denied", "owned_octet_download_sha_and_attachment", "canonical_delete_removes_real_object")
}
