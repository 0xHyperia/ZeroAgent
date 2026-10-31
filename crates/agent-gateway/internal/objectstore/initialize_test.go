package objectstore

import (
	"context"
	"errors"
	"net/http"
	"testing"
)

func TestInitializeBucketNeverOverwritesOrRetriesUnknownWrites(t *testing.T) {
	for _, mode := range []string{"exists", "new", "denied", "unknown"} {
		t.Run(mode, func(t *testing.T) {
			puts, heads := 0, 0
			store, _ := newTestStore(t, func(w http.ResponseWriter, r *http.Request) {
				checkSigned(t, r)
				if r.URL.Path != "/zeroagent-fixture" {
					t.Errorf("unexpected target %s", r.URL.Path)
				}
				if r.Method == http.MethodHead {
					heads++
					if mode == "denied" {
						w.WriteHeader(403)
					} else if mode == "exists" || puts > 0 {
						w.WriteHeader(200)
					} else {
						w.WriteHeader(404)
					}
					return
				}
				if r.Method != http.MethodPut {
					t.Fatalf("unexpected storage mutation %s", r.Method)
				}
				puts++
				if mode == "unknown" {
					w.WriteHeader(503)
					return
				}
				w.WriteHeader(200)
			})
			err := store.InitializeBucket(context.Background())
			switch mode {
			case "exists":
				if err != nil || puts != 0 || heads != 1 {
					t.Fatal("existing bucket was changed")
				}
			case "new":
				if err != nil || puts != 1 || heads != 2 {
					t.Fatal("explicit new bucket was not confirmed")
				}
			case "denied":
				if !errors.Is(err, ErrAccessDenied) || puts != 0 {
					t.Fatal("access rejection triggered a mutation")
				}
			case "unknown":
				if err == nil || puts != 1 {
					t.Fatal("unknown bucket creation was retried or hidden")
				}
			}
		})
	}
}
