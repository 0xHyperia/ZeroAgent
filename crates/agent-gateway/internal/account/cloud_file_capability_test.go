package account

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

func cloudFileHealthFixture(t *testing.T, service *Service) (*atomic.Bool, *atomic.Int32) {
	t.Helper()
	enabled, calls := &atomic.Bool{}, &atomic.Int32{}
	enabled.Store(true)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/health" || r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer synthetic-file-health-token-0123456789abcdef" {
			t.Error("capability probe performed a mutation or lost internal auth")
			w.WriteHeader(400)
			return
		}
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"service": "zeroagent-cloud-executor", "protocol": 1, "enabled": enabled.Load()})
	}))
	t.Cleanup(server.Close)
	client, err := cloudexecutor.New(cloudexecutor.Config{BaseURL: server.URL, Token: "synthetic-file-health-token-0123456789abcdef"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseIdleConnections)
	if err = service.SetCloudExecutor(client); err != nil {
		t.Fatal(err)
	}
	return enabled, calls
}

func TestCloudFileLargeOriginalReferenceUsesMetadataAndReadOnlyCapability(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	enabled, calls := cloudFileHealthFixture(t, f.service)
	for _, size := range []int{cloudFileContextBytes + 1024, CloudFileMaxTextBytes + 1024} {
		t.Run(fmt.Sprintf("bytes_%d", size), func(t *testing.T) {
			pattern := []byte("sensitive-row,value\n")
			original := bytes.Repeat(pattern, size/len(pattern)+1)[:size]
			file := f.upload(t, "large.csv", original)
			if !file.WorkspaceLoadable || file.UploadedAt == nil {
				t.Fatal("verified original lacks workspace capability")
			}
			raw := cloudJSON([]any{map[string]any{"type": "file_reference", "file_id": file.ID, "text": "forged text", "object_key": "forged key"}})
			canonical, err := f.service.canonicalCloudFileReferences(context.Background(), 1, raw)
			if err != nil || strings.Contains(string(canonical), "forged") {
				t.Fatalf("reference canonicalization failed: %v", err)
			}
			messages, code := f.service.cloudModelMessages(context.Background(), 1, []CloudMessage{{Role: "user", Content: canonical}})
			encoded := string(cloudJSON(messages))
			if code != "" || !strings.Contains(encoded, "load_uploaded_file") || !strings.Contains(encoded, file.ID) || strings.Contains(encoded, "sensitive-row") || strings.Contains(encoded, "L1:") || strings.Contains(encoded, "object_key") || len(encoded) > 8<<10 {
				t.Fatalf("raw original was treated as parsed text, code=%s", code)
			}
			status, body, _ := f.request(t, "GET", "/api/web-chat/files/"+file.ID, "file-owner", nil, nil)
			if status != 200 || !strings.Contains(string(body), `"workspace_loadable":true`) {
				t.Fatal("GET lacks response-only capability")
			}
			status, body, _ = f.request(t, "GET", "/api/web-chat/files?limit=10", "file-owner", nil, nil)
			if status != 200 || !strings.Contains(string(body), `"workspace_loadable":true`) {
				t.Fatal("list lacks response-only capability")
			}
			if _, err = f.service.canonicalCloudFileReferences(context.Background(), 2, raw); err == nil {
				t.Fatal("foreign original reference accepted")
			}
			enabled.Store(false)
			if _, err = f.service.canonicalCloudFileReferences(context.Background(), 1, raw); err == nil {
				t.Fatal("disabled executor accepted raw reference")
			}
			if _, code = f.service.cloudModelMessages(context.Background(), 1, []CloudMessage{{Role: "user", Content: canonical}}); code == "" {
				t.Fatal("stale capability silently claimed usable context")
			}
			enabled.Store(true)
			status, _, _ = f.request(t, "DELETE", "/api/web-chat/files/"+file.ID, "file-owner", nil, nil)
			if status != 200 {
				t.Fatalf("delete status=%d", status)
			}
			if _, err = f.service.canonicalCloudFileReferences(context.Background(), 1, raw); err == nil {
				t.Fatal("deleted raw original accepted")
			}
		})
	}
	if calls.Load() == 0 {
		t.Fatal("capability was not verified against adapter")
	}
}

func TestCloudFileReferenceCapabilityDoesNotPersistOrFakeTextReady(t *testing.T) {
	f := newCloudFileHTTPFixture(t)
	cloudFileHealthFixture(t, f.service)
	file := f.upload(t, "pending.pdf", []byte("%PDF-1.7\nuntrusted original fixture"))
	if file.State != CloudFileUploaded || !file.WorkspaceLoadable || file.TextBytes != 0 {
		t.Fatal("upload changed parser state or text")
	}
	stored, err := f.store.GetCloudFile(context.Background(), 1, file.ID)
	if err != nil || stored.WorkspaceLoadable || stored.Text != "" || len(stored.Segments) != 0 {
		t.Fatal("derived capability entered persistent source state")
	}
	status, _, _ := f.request(t, "GET", "/api/web-chat/files/"+file.ID+"/content", "file-owner", nil, nil)
	if status != 409 {
		t.Fatalf("raw file pretended to have extracted text: %d", status)
	}
}
