package cloudchat_test

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

// Explicitly opt into the disposable runner's real storage only. Normal browser
// fixtures remain local protocol peers and never inspect application secrets.
func browserPreviewStorage(t *testing.T, evidence *browserFixtureEvidence) objectstore.Store {
	path := os.Getenv("ZEROAGENT_CLOUDCHAT_BROWSER_SEAWEEDFS_CONFIG_FILE")
	if path == "" {
		return newBrowserFixtureS3(t, evidence)
	}
	private, err := os.ReadFile(path)
	if err != nil || len(private) > 16<<10 {
		t.Fatal("read disposable preview storage configuration")
	}
	var cfg s3AcceptanceConfig
	if json.Unmarshal(private, &cfg) != nil {
		t.Fatal("decode disposable preview storage configuration")
	}
	u, err := url.Parse(cfg.Endpoint)
	if err != nil || u.Scheme != "http" || u.User != nil || net.ParseIP(u.Hostname()) == nil || !net.ParseIP(u.Hostname()).IsLoopback() || !regexp.MustCompile(`^[a-f0-9]{16}$`).MatchString(cfg.TaskID) || cfg.Bucket != "za-seaweed-test-"+cfg.TaskID {
		t.Fatal("preview fixture must use its explicitly isolated loopback storage")
	}
	objects, err := objectstore.New(objectstore.Config{Endpoint: cfg.Endpoint, Bucket: cfg.Bucket, Region: cfg.Region, AccessKeyID: cfg.AccessKeyID, SecretAccessKey: cfg.SecretAccessKey, AllowLoopbackHTTP: true, MaxObjectBytes: 32 << 20, TempDir: t.TempDir()})
	if err != nil {
		t.Fatal("create disposable preview storage")
	}
	t.Cleanup(objects.Close)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if objects.Ready(ctx) != nil {
		t.Fatal("disposable preview bucket is not ready")
	}
	return objects
}

func seedBrowserPreviewFiles(t *testing.T, server *httptest.Server, cookie, output string) {
	directory := os.Getenv("ZEROAGENT_CLOUDCHAT_PREVIEW_FIXTURES_DIR")
	if directory == "" {
		return
	}
	manifest, err := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if err != nil || len(manifest) > 16<<10 {
		t.Fatal("read explicitly generated preview fixtures")
	}
	type sample struct {
		Name, SHA256 string
		Size         int
		Data         []byte `json:"-"`
	}
	var fixture struct {
		Format string   `json:"format"`
		Files  []sample `json:"files"`
	}
	if json.Unmarshal(manifest, &fixture) != nil || fixture.Format != "zeroagent-preview-fixtures-v1" || len(fixture.Files) > 20 {
		t.Fatal("invalid synthetic preview manifest")
	}
	files := make([]*account.CloudFile, 0, len(fixture.Files))
	if os.Getenv("ZEROAGENT_CLOUDCHAT_SPACE_PAGINATION_FIXTURE") == "1" {
		for i := range 65 {
			data := []byte("Synthetic pagination resource. No user content.\n")
			fixture.Files = append(fixture.Files, sample{fmt.Sprintf("分页资料-%02d.txt", i), acceptanceDigest(data), len(data), data})
		}
	}
	for _, file := range fixture.Files {
		if filepath.Base(file.Name) != file.Name || file.Size < 0 || file.Size > 32<<20 {
			t.Fatal("invalid synthetic preview file")
		}
		data := file.Data
		var err error
		if data == nil {
			data, err = os.ReadFile(filepath.Join(directory, file.Name))
		}
		if err != nil || len(data) != file.Size || acceptanceDigest(data) != file.SHA256 {
			t.Fatal("synthetic preview bytes do not match manifest")
		}
		body := &bytes.Buffer{}
		writer := multipart.NewWriter(body)
		part, err := writer.CreateFormFile("file", file.Name)
		if err != nil {
			t.Fatal("create preview multipart")
		}
		if _, err = part.Write(data); err != nil {
			t.Fatal("write preview multipart")
		}
		if writer.Close() != nil {
			t.Fatal("finish preview multipart")
		}
		request, err := http.NewRequest(http.MethodPost, server.URL+"/api/web-chat/files", body)
		if err != nil {
			t.Fatal("create preview upload")
		}
		request.Header.Set("Origin", server.URL)
		request.Header.Set("Content-Type", writer.FormDataContentType())
		request.AddCookie(&http.Cookie{Name: account.SessionCookieName, Value: cookie})
		response, err := server.Client().Do(request)
		if err != nil {
			t.Fatal("upload synthetic preview")
		}
		encoded, readErr := io.ReadAll(io.LimitReader(response.Body, 32<<10))
		response.Body.Close()
		var result struct {
			File *account.CloudFile `json:"file"`
		}
		if readErr != nil || response.StatusCode != http.StatusCreated || json.Unmarshal(encoded, &result) != nil || result.File == nil || result.File.SHA256 != file.SHA256 {
			t.Fatalf("upload synthetic preview %s status=%d", file.Name, response.StatusCode)
		}
		files = append(files, result.File)
	}
	encoded, err := json.MarshalIndent(files, "", "  ")
	if err != nil || os.WriteFile(filepath.Join(filepath.Dir(output), "preview-files.json"), encoded, 0600) != nil {
		t.Fatal("write synthetic preview IDs")
	}
}
