package objectstore

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestReadinessVerifiesBucketWithoutWritingOrLeakingError(t *testing.T) {
	var status atomic.Int32
	status.Store(200)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "HEAD" || r.URL.Path != "/synthetic-bucket" || r.Header.Get("Authorization") == "" {
			t.Error("readiness was not an authenticated bucket HEAD")
		}
		w.WriteHeader(int(status.Load()))
	}))
	defer server.Close()
	store, err := New(Config{Endpoint: server.URL, Bucket: "synthetic-bucket", Region: "test-region", AccessKeyID: "synthetic-access", SecretAccessKey: "synthetic-secret", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if err = store.Ready(context.Background()); err != nil {
		t.Fatalf("bucket HEAD failed: %v", err)
	}
	status.Store(403)
	if err = store.Ready(context.Background()); !errors.Is(err, ErrAccessDenied) {
		t.Fatalf("bucket denial was not sanitized: %v", err)
	}
	disabled, _ := New(Config{})
	if !errors.Is(disabled.Ready(context.Background()), ErrDisabled) {
		t.Fatal("disabled storage claimed ready")
	}
}
