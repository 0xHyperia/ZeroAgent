package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func diagnosticEvent(t *testing.T, store CloudRunStore, run *CloudRun, status int, phase, kind string) {
	t.Helper()
	events, err := store.ListCloudRunEvents(context.Background(), run.UserID, run.ID, 0, 256)
	if err != nil {
		t.Fatal(err)
	}
	count := 0
	for _, event := range events {
		if event.Type != "model.request_failed" {
			continue
		}
		count++
		var value map[string]any
		if json.Unmarshal(event.Payload, &value) != nil || len(value) != 4 || value["http_status"] != float64(status) || value["round"] != float64(0) || value["phase"] != phase || value["failure_kind"] != kind {
			t.Fatalf("unsafe or incorrect diagnostic metadata: %s", event.Payload)
		}
	}
	if count != 1 {
		t.Fatalf("expected one durable model failure event, got %d", count)
	}
	for _, forbidden := range []string{"diagnostic-private-body", "diagnostic-private-header", "synthetic-model-key", "synthetic-access-token", "synthetic-browser-cookie"} {
		if strings.Contains(string(cloudJSON(events)), forbidden) {
			t.Fatal("private upstream content entered diagnostic events")
		}
	}
}

func TestCloudModelDiagnosticsHTTPFailure(t *testing.T) {
	for _, status := range []int{400, 401, 429, 502} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v1/chat/completions" {
					t.Error("model failure changed route")
				}
				w.Header().Set("X-Private-Upstream", "diagnostic-private-header")
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"error":{"message":"diagnostic-private-body synthetic-model-key synthetic-access-token","code":"private-provider-code"}}`)
			})
			run, body := f.create(t, "http-diagnostic", "work")
			finished := f.wait(t, run.ID, func(r *CloudRun) bool { return r.Terminal() })
			if finished.State != CloudRunFailed || finished.ErrorCode != "model_request_failed" || finished.Output != "" || len(finished.Usage) != 0 || f.calls.Load() != 1 {
				t.Fatal("diagnostic changed task outcome, usage or request count")
			}
			diagnosticEvent(t, f.store, finished, status, "private_synthesis", "http_status")
			response, _ := f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", body)
			if response != 200 || f.calls.Load() != 1 {
				t.Fatal("failed request replay caused another model attempt")
			}
			if _, err := f.store.GetSession(context.Background(), "synthetic-browser-cookie"); err != nil {
				t.Fatal("model HTTP failure revoked account authentication")
			}
			messages, err := f.store.ListCloudMessages(context.Background(), 1, run.ConversationID)
			if err != nil || len(messages) != 1 || messages[0].Role != "user" {
				t.Fatal("diagnostic created an empty canonical answer")
			}
		})
	}
}

func TestCloudModelDiagnosticsStreamErrorPreservesPartial(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		emitCloudDelta(w, "已生成片段")
		_, _ = io.WriteString(w, "data: {\"error\":{\"code\":\"diagnostic-private-header\",\"message\":\"diagnostic-private-body synthetic-model-key\"}}\n\n")
	})
	run, _ := f.create(t, "stream-diagnostic", "work")
	finished := f.wait(t, run.ID, func(r *CloudRun) bool { return r.Terminal() })
	if finished.State != CloudRunInterrupted || finished.ErrorCode != "model_request_failed" || finished.Output != "已生成片段" || f.calls.Load() != 1 {
		t.Fatalf("stream diagnostic changed partial outcome: %s/%s", finished.State, finished.ErrorCode)
	}
	diagnosticEvent(t, f.store, finished, 200, "private_synthesis", "stream_error")
}

func TestCloudModelDiagnosticsPublicPhaseDisclosesNoDraft(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		emitCloudDelta(w, "diagnostic-private-body")
		_, _ = io.WriteString(w, "data: {\"error\":{\"message\":\"diagnostic-private-header\"}}\n\n")
	})
	configureCloudResearchFixture(t, f)
	run, _ := f.createResearch(t, "public-diagnostic", "private user work", "approved public topic")
	finished := f.wait(t, run.ID, func(r *CloudRun) bool { return r.Terminal() })
	if finished.State != CloudRunInterrupted || finished.ErrorCode != "model_request_failed" || finished.Output != "" || f.calls.Load() != 1 {
		t.Fatal("public-phase failure exposed draft or retried model")
	}
	diagnosticEvent(t, f.store, finished, 200, "public_research", "stream_error")
}

type diagnosticWriteFailureStore struct {
	*MemoryStore
	failures atomic.Int32
}

func (s *diagnosticWriteFailureStore) CommitCloudRun(ctx context.Context, uid int64, id, owner string, attempt int64, commit CloudRunCommit) (*CloudRun, error) {
	if commit.EventType == "model.request_failed" {
		s.failures.Add(1)
		return nil, errors.New("diagnostic-private-body")
	}
	return s.MemoryStore.CommitCloudRun(ctx, uid, id, owner, attempt, commit)
}

func TestCloudModelDiagnosticsPersistenceFailureNeverRetriesModel(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(429) })
	fault := &diagnosticWriteFailureStore{MemoryStore: f.store}
	f.service.store = fault
	run, _ := f.create(t, "diagnostic-store-failure", "work")
	finished := f.wait(t, run.ID, func(r *CloudRun) bool { return r.Terminal() })
	if finished.State != CloudRunFailed || finished.ErrorCode != "model_request_failed" || f.calls.Load() != 1 || fault.failures.Load() != 1 {
		t.Fatal("diagnostic persistence failure changed outcome or repeated external request")
	}
}

func TestCloudModelDiagnosticsFencedStoreContract(t *testing.T) {
	for _, backend := range []struct {
		name string
		make func(*testing.T) cloudRunTestFixture
	}{{"memory", cloudRunMemoryFixture}, {"postgres", cloudRunPostgresFixture}} {
		t.Run(backend.name, func(t *testing.T) {
			f := backend.make(t)
			input := cloudRunTestInput(t, f, 7, "", "fenced-diagnostic", "work")
			if _, _, err := f.runs.CreateCloudRun(context.Background(), input); err != nil {
				t.Fatal(err)
			}
			run, err := f.runs.ClaimCloudRun(context.Background(), "diagnostic-worker", time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			runtime := &cloudRunRuntime{store: f.runs}
			stale := *run
			stale.Attempt++
			runtime.recordCloudModelFailure(context.Background(), &stale, run.LeaseOwner, 0, 502, false, "http_status")
			events, err := f.runs.ListCloudRunEvents(context.Background(), 7, run.ID, 0, 256)
			if err != nil {
				t.Fatal(err)
			}
			for _, event := range events {
				if event.Type == "model.request_failed" {
					t.Fatal("stale attempt wrote model diagnostics")
				}
			}
			runtime.recordCloudModelFailure(context.Background(), run, run.LeaseOwner, 0, 502, false, "http_status")
			runtime.recordCloudModelFailure(context.Background(), run, run.LeaseOwner, 0, 502, false, "http_status")
			diagnosticEvent(t, f.runs, run, 502, "private_synthesis", "http_status")
			current, err := f.runs.GetCloudRun(context.Background(), 7, run.ID)
			if err != nil || current.State != CloudRunRunning || current.Output != "" || len(current.Usage) != 0 {
				t.Fatal("metadata-only event changed output, usage or lifecycle")
			}
			if _, err = f.runs.ListCloudRunEvents(context.Background(), 8, run.ID, 0, 256); !errors.Is(err, ErrNotFound) {
				t.Fatal("model diagnostic crossed account scope")
			}
		})
	}
}
