package server

import (
	"io/fs"
	"mime"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	gateway "github.com/liveagent/agent-gateway"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/session"
)

func TestPackagedPDFWorkerIgnoresHostMIMERegistry(t *testing.T) {
	workers, err := fs.Glob(gateway.WebUIAssets, "web/dist/assets/pdf.worker*.mjs")
	if err != nil {
		t.Fatal(err)
	}
	if len(workers) == 0 {
		t.Skip("requires the production WebUI build, not the Go-only placeholder")
	}
	previous := mime.TypeByExtension(".mjs")
	if previous == "" {
		previous = "application/octet-stream"
	}
	t.Cleanup(func() { _ = mime.AddExtensionType(".mjs", previous) })
	// A Windows registry entry actually caused the browser to reject this worker.
	if err := mime.AddExtensionType(".mjs", "text/plain"); err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPServer(&config.Config{Token: "dev-token"}, session.NewManager(), nil)
	for _, worker := range workers {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/"+strings.TrimPrefix(worker, "web/dist/"), nil))
		if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/javascript") || rec.Body.Len() < 1024 {
			t.Fatalf("module worker status=%d MIME=%q bytes=%d", rec.Code, rec.Header().Get("Content-Type"), rec.Body.Len())
		}
	}
	cmaps, err := fs.Glob(gateway.WebUIAssets, "web/dist/resource-preview/pdf/*/cmaps/UniGB-UCS2-H.bcmap")
	if err != nil || len(cmaps) != 1 {
		t.Fatal("the worker build must include its versioned Chinese CMap")
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/"+strings.TrimPrefix(cmaps[0], "web/dist/"), nil))
	if rec.Code != http.StatusOK || rec.Body.Len() < 1000 || !strings.Contains(rec.Header().Get("Cache-Control"), "immutable") {
		t.Fatalf("CMap status=%d cache=%q bytes=%d", rec.Code, rec.Header().Get("Cache-Control"), rec.Body.Len())
	}
}
