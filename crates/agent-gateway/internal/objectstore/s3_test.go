package objectstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const fakeSecret = "test-secret-reflection-marker"

func config(endpoint string) Config {
	return Config{Endpoint: endpoint, Bucket: "zeroagent-fixture", Region: "test-region",
		AccessKeyID: "explicit-test-key", SecretAccessKey: fakeSecret, AllowLoopbackHTTP: true}
}

func newTestStore(t *testing.T, handler http.HandlerFunc) (*S3Store, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	store, err := New(config(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	return store, server
}

func digest(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}

func checkSigned(t *testing.T, r *http.Request) {
	t.Helper()
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "AWS4-HMAC-SHA256 Credential=explicit-test-key/") || r.Header.Get("X-Amz-Date") == "" {
		t.Error("request was not signed with the explicitly configured key")
	}
	if strings.Contains(auth, "ambient") || strings.Contains(auth, fakeSecret) {
		t.Error("request used an ambient or disclosed credential")
	}
}

func infoHeaders(w http.ResponseWriter, data []byte) {
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("ETag", `"opaque-etag"`)
	w.Header().Set("X-Amz-Meta-Sha256", digest(data))
	w.Header().Set("X-Amz-Meta-Owner", "opaque-owner")
}

func TestConfigurationIsExplicitDisabledAndRedacted(t *testing.T) {
	var names []string
	cfg, err := ConfigFromEnv(func(name string) string {
		names = append(names, name)
		if name == "ZEROAGENT_OBJECT_STORAGE_ACCESS_KEY_ID" {
			return "isolated-key"
		}
		return ""
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range names {
		if !strings.HasPrefix(name, "ZEROAGENT_OBJECT_STORAGE_") {
			t.Fatal("read ambient configuration")
		}
	}
	store, err := New(cfg)
	if err != nil || store.Status().Enabled || len(store.Status().Missing) != 4 {
		t.Fatalf("incomplete configuration was not disabled: %v", err)
	}
	if _, err := store.Head(context.Background(), "owner/file"); !errors.Is(err, ErrDisabled) {
		t.Fatal(err)
	}
	status := store.Status()
	status.Missing[0] = "changed"
	if store.Status().Missing[0] == "changed" {
		t.Fatal("status exposed mutable configuration")
	}
	secretConfig := config("https://objects.example.test")
	encoded, err := json.Marshal(secretConfig)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{fmt.Sprint(secretConfig), fmt.Sprintf("%#v", secretConfig), string(encoded), fmt.Sprint(store)} {
		if strings.Contains(value, fakeSecret) || strings.Contains(value, "explicit-test-key") {
			t.Fatal("credentials were serialized or formatted")
		}
	}
}

func TestEndpointValidationDoesNotAllowInsecureOrAmbiguousOrigins(t *testing.T) {
	for _, endpoint := range []string{
		"http://objects.example.test", "http://localhost:1234", "http://127.0.0.1:0",
		"https://user:password@objects.example.test", "https://objects.example.test?key=secret",
		"https://objects.example.test#fragment", "https://objects.example.test?",
		"https://objects.example.test/base", "https://:443", "file:///tmp/storage", "ftp://objects.example.test",
	} {
		t.Run(endpoint, func(t *testing.T) {
			if _, err := New(config(endpoint)); !errors.Is(err, ErrInvalidConfig) {
				t.Fatal("unsafe origin was accepted")
			}
		})
	}
	for _, endpoint := range []string{"http://127.0.0.1:12345", "http://[::1]:12345", "https://objects.example.test"} {
		store, err := New(config(endpoint))
		if err != nil || !store.Status().Enabled {
			t.Fatalf("explicit origin was rejected: %v", err)
		}
		store.Close()
	}
	cfg := config("http://127.0.0.1:12345")
	cfg.AllowLoopbackHTTP = false
	if _, err := New(cfg); !errors.Is(err, ErrInvalidConfig) {
		t.Fatal("HTTP did not require explicit test opt-in")
	}
	for _, bucket := range []string{"../bucket", "UPPER", "a", "127.0.0.1", "a..b", "a--x-s3"} {
		cfg := config("https://objects.example.test")
		cfg.Bucket = bucket
		if _, err := New(cfg); !errors.Is(err, ErrInvalidConfig) {
			t.Fatalf("invalid bucket was accepted: %q", bucket)
		}
	}
}

func TestPutHeadGetVerifyDeleteUseBoundedSignedPathStyleRequests(t *testing.T) {
	data := []byte("hello, ZeroAgent\n你好")
	var saved []byte
	var calls atomic.Int64
	store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		checkSigned(t, r)
		if r.URL.Path != "/zeroagent-fixture/accounts/opaque/files/file-1" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		switch r.Method {
		case http.MethodPut:
			if r.ContentLength != int64(len(data)) || r.Header.Get("X-Amz-Meta-Sha256") != digest(data) ||
				r.Header.Get("X-Amz-Checksum-Sha256") != checksumBase64(digest(data)) {
				t.Error("upload omitted its size or integrity constraints")
			}
			body, err := io.ReadAll(r.Body)
			if err != nil || !bytes.Equal(body, data) {
				t.Error("uploaded bytes changed")
			}
			saved = body
			w.Header().Set("ETag", `"opaque-etag"`)
		case http.MethodHead, http.MethodGet:
			if saved == nil {
				w.WriteHeader(http.StatusNotFound)
				return
			}
			infoHeaders(w, saved)
			if r.Method == http.MethodGet {
				_, _ = w.Write(saved)
			}
		case http.MethodDelete:
			saved = nil
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Error("unexpected operation")
		}
	})
	ctx := context.Background()
	key := "accounts/opaque/files/file-1"
	put, err := store.Put(ctx, key, bytes.NewReader(data), int64(len(data)), PutOptions{ContentType: "text/plain; charset=utf-8", Metadata: map[string]string{"owner": "opaque-owner"}})
	if err != nil || put.SHA256 != digest(data) || put.ETag != `"opaque-etag"` {
		t.Fatalf("put failed: %v", err)
	}
	head, err := store.Head(ctx, key)
	if err != nil || head.Size != int64(len(data)) || head.SHA256 != digest(data) || head.Metadata["owner"] != "opaque-owner" {
		t.Fatalf("head failed: %v", err)
	}
	object, err := store.Get(ctx, key)
	if err != nil {
		t.Fatal(err)
	}
	read, err := io.ReadAll(object.Body)
	if closeErr := object.Body.Close(); err != nil || closeErr != nil || !bytes.Equal(read, data) {
		t.Fatalf("get failed: %v %v", err, closeErr)
	}
	if _, err := store.Verify(ctx, key, int64(len(data)), digest(data)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Verify(ctx, key, int64(len(data)), strings.Repeat("0", 64)); !errors.Is(err, ErrIntegrity) {
		t.Fatal("verification trusted metadata rather than the expected digest")
	}
	if err := store.Delete(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Head(ctx, key); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted object did not return not-found: %v", err)
	}
	if calls.Load() != 7 {
		t.Fatalf("unexpected request count: %d", calls.Load())
	}
}

func TestPutValidatesBeforeNetworkAndCleansPrivateStagingFiles(t *testing.T) {
	var calls atomic.Int64
	store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) { calls.Add(1); _, _ = io.Copy(io.Discard, r.Body) })
	store.cfg.MaxObjectBytes = 16
	store.cfg.TempDir = t.TempDir()
	ctx := context.Background()
	for _, tc := range []struct {
		name, key, data string
		size            int64
		options         PutOptions
		want            error
	}{
		{"large", "owner/file", "x", 17, PutOptions{}, ErrTooLarge},
		{"short", "owner/file", "a", 2, PutOptions{}, ErrLengthMismatch},
		{"long", "owner/file", "abc", 2, PutOptions{}, ErrLengthMismatch},
		{"digest", "owner/file", "abc", 3, PutOptions{SHA256: strings.Repeat("0", 64)}, ErrIntegrity},
		{"metadata", "owner/file", "abc", 3, PutOptions{Metadata: map[string]string{"owner": "bad\nvalue"}}, ErrInvalidMetadata},
		{"type", "owner/file", "abc", 3, PutOptions{ContentType: "bad\ntype"}, ErrInvalidMetadata},
		{"key", "owner/../file", "abc", 3, PutOptions{}, ErrInvalidKey},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := store.Put(ctx, tc.key, io.NopCloser(strings.NewReader(tc.data)), tc.size, tc.options)
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatal("invalid input reached the storage endpoint")
	}
	if _, err := store.Put(ctx, "owner/file", io.NopCloser(strings.NewReader("abc")), 3, PutOptions{}); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(store.cfg.TempDir)
	if err != nil || len(files) != 0 {
		t.Fatal("upload staging files leaked")
	}
	for _, key := range []string{"", "/absolute", "a//b", "a/", "a/./b", "a\\b", "a/%2e%2e/b", "a/\n", "a/中文"} {
		if _, err := store.Head(ctx, key); !errors.Is(err, ErrInvalidKey) {
			t.Fatalf("unsafe key accepted: %q", key)
		}
	}
}

func TestPresignBindsObjectLengthDigestMetadataAndShortTTLWithoutNetwork(t *testing.T) {
	var calls atomic.Int64
	store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != http.MethodPut || r.ContentLength != 3 || r.Header.Get("X-Amz-Meta-Owner") != "opaque-owner" {
			t.Error("presigned upload constraints changed")
		}
		if r.Header.Get("X-Amz-Checksum-Sha256") != checksumBase64(digest([]byte("abc"))) {
			t.Error("presigned upload omitted its checksum header")
		}
	})
	ctx := context.Background()
	options := PutOptions{ContentType: "text/plain", SHA256: digest([]byte("abc")), Metadata: map[string]string{"owner": "opaque-owner"}}
	signed, err := store.PresignUpload(ctx, "owner/file", 3, options, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 0 {
		t.Fatal("presigning unexpectedly contacted the storage endpoint")
	}
	parsed, _ := url.Parse(signed.URL)
	query := parsed.Query()
	if query.Get("X-Amz-Algorithm") != "AWS4-HMAC-SHA256" || query.Get("X-Amz-Expires") != "60" || query.Get("X-Amz-Signature") == "" {
		t.Fatal("invalid presigned capability")
	}
	for _, header := range []string{"content-length", "content-type", "x-amz-checksum-sha256", "x-amz-meta-owner", "x-amz-meta-sha256"} {
		if !strings.Contains(";"+query.Get("X-Amz-SignedHeaders")+";", ";"+header+";") {
			t.Fatalf("missing signed constraint %s", header)
		}
	}
	if strings.Contains(signed.URL, fakeSecret) || strings.Contains(fmt.Sprintf("%+v", signed), "X-Amz-Signature") {
		t.Fatal("presigned capability leaked through diagnostic formatting")
	}
	req, _ := http.NewRequestWithContext(ctx, signed.Method, signed.URL, strings.NewReader("abc"))
	for key, values := range signed.Headers {
		req.Header[key] = values
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || calls.Load() != 1 {
		t.Fatal("presigned upload failed against the isolated protocol server")
	}
	download, err := store.PresignDownload(ctx, "owner/file", "报告.pdf", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	downloadURL, _ := url.Parse(download.URL)
	mediaType, parameters, err := mime.ParseMediaType(downloadURL.Query().Get("response-content-disposition"))
	if err != nil || mediaType != "attachment" || parameters["filename"] != "报告.pdf" {
		t.Fatal("download did not enforce a safe attachment disposition")
	}
	for _, ttl := range []time.Duration{-time.Second, time.Hour, time.Millisecond} {
		if _, err := store.PresignUpload(ctx, "owner/file", 3, options, ttl); !errors.Is(err, ErrInvalidInput) {
			t.Fatal("invalid TTL was accepted")
		}
	}
	if _, err := store.PresignUpload(ctx, "owner/file", 3, PutOptions{}, time.Minute); !errors.Is(err, ErrInvalidInput) {
		t.Fatal("unsigned upload checksum was accepted")
	}
	if _, err := store.PresignDownload(ctx, "owner/file", "bad\r\nheader", time.Minute); !errors.Is(err, ErrInvalidInput) {
		t.Fatal("invalid download filename was accepted")
	}
}

func TestProviderErrorsAreClassifiedWithoutReflectingSecrets(t *testing.T) {
	for _, tc := range []struct {
		status int
		code   string
		want   error
	}{
		{404, "NoSuchKey", ErrNotFound}, {403, "AccessDenied", ErrAccessDenied},
		{429, "SlowDown", ErrThrottled}, {503, "ServiceUnavailable", ErrUnavailable},
		{400, "BadDigest", ErrIntegrity},
	} {
		t.Run(tc.code, func(t *testing.T) {
			store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/xml")
				w.WriteHeader(tc.status)
				_, _ = fmt.Fprintf(w, "<Error><Code>%s</Code><Message>%s signed-url-reflection</Message></Error>", tc.code, fakeSecret)
			})
			_, err := store.Get(context.Background(), "owner/file")
			if !errors.Is(err, tc.want) || strings.Contains(fmt.Sprint(err), fakeSecret) || strings.Contains(fmt.Sprint(err), "signed-url-reflection") {
				t.Fatalf("unsafe or incorrect error: %v", err)
			}
		})
	}
}

func TestOversizedTruncatedAndCorruptDownloadsFail(t *testing.T) {
	for _, tc := range []struct {
		name      string
		length    int
		data, sha string
		max       int64
		want      error
	}{
		{"oversized", 100, "", "", 8, ErrTooLarge},
		{"truncated", 10, "abc", "", 64, ErrLengthMismatch},
		{"checksum", 3, "abc", strings.Repeat("0", 64), 64, ErrIntegrity},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Length", strconv.Itoa(tc.length))
				if tc.sha != "" {
					w.Header().Set("X-Amz-Meta-Sha256", tc.sha)
				}
				_, _ = io.WriteString(w, tc.data)
			})
			store.cfg.MaxObjectBytes = tc.max
			object, err := store.Get(context.Background(), "owner/file")
			if err == nil {
				_, err = io.ReadAll(object.Body)
				_ = object.Body.Close()
			}
			if !errors.Is(err, tc.want) {
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

func TestNoAmbientProfilesAndNoRedirectCredentialForwarding(t *testing.T) {
	profile := filepath.Join(t.TempDir(), "credentials")
	if err := os.WriteFile(profile, []byte("[default]\naws_access_key_id=ambient-key\naws_secret_access_key=ambient-secret\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("AWS_SHARED_CREDENTIALS_FILE", profile)
	t.Setenv("AWS_ACCESS_KEY_ID", "ambient-env-key")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "ambient-env-secret")
	var redirected atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer target.Close()
	store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
		checkSigned(t, r)
		w.Header().Set("Location", target.URL+"/capture")
		w.WriteHeader(http.StatusTemporaryRedirect)
	})
	if _, err := store.Head(context.Background(), "owner/file"); !errors.Is(err, ErrUnavailable) {
		t.Fatal(err)
	}
	if redirected.Load() != 0 {
		t.Fatal("signed request followed a redirect")
	}
}

func TestContextCancellationAndSpoolReaderFailuresStayBounded(t *testing.T) {
	store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) { t.Error("cancelled input reached the network") })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Get(ctx, "owner/file"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled context was lost: %v", err)
	}
	store.cfg.TempDir = t.TempDir()
	_, err := store.Put(context.Background(), "owner/file", errorReader{}, 3, PutOptions{})
	if !errors.Is(err, ErrUnavailable) || strings.Contains(fmt.Sprint(err), fakeSecret) {
		t.Fatal("reader failure was not sanitized")
	}
	files, _ := os.ReadDir(store.cfg.TempDir)
	if len(files) != 0 {
		t.Fatal("failed upload leaked staging files")
	}
}

func TestEmptyAndOffsetUploadsPreserveExactObjectBytes(t *testing.T) {
	for _, data := range []string{"", "content"} {
		t.Run(strconv.Itoa(len(data)), func(t *testing.T) {
			store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
				body, err := io.ReadAll(r.Body)
				if err != nil || string(body) != data || r.ContentLength != int64(len(data)) {
					t.Error("seek offset or empty-object length changed")
				}
			})
			reader := strings.NewReader("prefix" + data)
			_, _ = reader.Seek(int64(len("prefix")), io.SeekStart)
			if _, err := store.Put(context.Background(), "owner/file", reader, int64(len(data)), PutOptions{}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestResponseMetadataAndMissingContentLengthAreRejected(t *testing.T) {
	for _, tc := range []struct {
		name    string
		handler http.HandlerFunc
		want    error
	}{
		{"metadata", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Amz-Meta-Owner", strings.Repeat("x", 513))
			w.Header().Set("Content-Length", "3")
			_, _ = io.WriteString(w, "abc")
		}, ErrInvalidMetadata},
		{"unknown-length", func(w http.ResponseWriter, r *http.Request) {
			w.(http.Flusher).Flush()
			_, _ = io.WriteString(w, "abc")
		}, ErrLengthMismatch},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store, _ := newTestStore(t, tc.handler)
			if object, err := store.Get(context.Background(), "owner/file"); !errors.Is(err, tc.want) {
				if object != nil {
					_ = object.Body.Close()
				}
				t.Fatalf("got %v, want %v", err, tc.want)
			}
		})
	}
}

type errorReader struct{}

func (errorReader) Read([]byte) (int, error) { return 0, errors.New(fakeSecret) }

func TestChecksumEncoding(t *testing.T) {
	value := []byte("data")
	got, err := base64.StdEncoding.DecodeString(checksumBase64(digest(value)))
	if err != nil || hex.EncodeToString(got) != digest(value) {
		t.Fatal("checksum encoding changed")
	}
}
