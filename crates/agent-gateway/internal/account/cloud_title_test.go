package account

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func TestCloudGenerationSettingsHTTPAuthority(t *testing.T) {
	f, _ := imageExecutionFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("settings invoked generation") })
	mux := http.NewServeMux()
	NewHTTPHandler(f.service, false).registerWebChat(mux)
	f.server.Close()
	f.server = httptest.NewServer(mux)
	t.Cleanup(f.server.Close)
	path := "/api/web-chat/generation-settings"
	status, body, headers := f.request(t, "GET", path, "file-owner", nil, nil)
	if status != 200 || headers.Get("Cache-Control") != "no-store" || !strings.Contains(string(body), `"enabled":false`) {
		t.Fatal(status, string(body))
	}
	update := `{"expected_version":0,"title":{"enabled":true,"provider_key_id":41,"model":"gpt-image-test","reasoning_effort":"low","max_output_tokens":1024,"prompt":"中文"}}`
	status, _, _ = f.request(t, "PUT", path, "file-owner", strings.NewReader(update), http.Header{"Origin": {"https://evil.invalid"}})
	if status != 403 {
		t.Fatal("CSRF", status)
	}
	status, _, _ = f.request(t, "PUT", path, "file-owner", strings.NewReader(strings.Replace(update, "gpt-image-test", "not-in-catalog", 1)), nil)
	if status != 400 {
		t.Fatal("invalid catalog model accepted", status)
	}
	status, _, _ = f.request(t, "PUT", path, "file-owner", strings.NewReader(update), nil)
	if status != 200 {
		t.Fatal(status)
	}
	status, _, _ = f.request(t, "PUT", path, "file-owner", strings.NewReader(update), nil)
	if status != 409 {
		t.Fatal("stale writer", status)
	}
	// A removed model must never prevent switching the auxiliary feature off.
	disabled := strings.Replace(strings.Replace(strings.Replace(update, `"expected_version":0`, `"expected_version":1`, 1), `"enabled":true`, `"enabled":false`, 1), "gpt-image-test", "not-in-catalog", 1)
	status, _, _ = f.request(t, "PUT", path, "file-owner", strings.NewReader(disabled), nil)
	if status != 200 {
		t.Fatal("unavailable model blocked disabling titles", status)
	}
	status, body, _ = f.request(t, "GET", path, "file-other", nil, nil)
	if status != 200 || !strings.Contains(string(body), `"version":0`) || strings.Contains(string(body), "gpt-image-test") {
		t.Fatal("cross-account preference", status, string(body))
	}
	status, _, _ = f.request(t, "GET", path, "", nil, nil)
	if status != 401 {
		t.Fatal("anonymous read", status)
	}
}

func TestCloudGenerationSettingsCAS(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(map[bool]string{false: "memory", true: "postgres"}[postgres], func(t *testing.T) {
			var store cloudGenerationSettingsStore = NewMemoryStore()
			if postgres {
				f := cloudRunPostgresFixture(t)
				p := f.store.(*PersistentStore)
				if _, err := p.db.Exec(CloudGenerationSettingsSchema); err != nil {
					t.Fatal(err)
				}
				store = p
			}
			ctx := context.Background()
			initial, err := store.GetCloudGenerationSettings(ctx, 7)
			if err != nil || initial.Version != 0 || initial.Title.Enabled {
				t.Fatal(initial, err)
			}
			pref := CloudTitlePreferences{Enabled: true, ProviderKeyID: 41, Model: "title-model", MaxOutputTokens: 2048, Prompt: "使用中文"}
			saved, err := store.SetCloudGenerationSettings(ctx, 7, 0, pref)
			if err != nil || saved.Version != 1 {
				t.Fatal(saved, err)
			}
			if _, err = store.SetCloudGenerationSettings(ctx, 7, 0, pref); !errors.Is(err, errCloudGenerationSettingsConflict) {
				t.Fatal("stale writer accepted", err)
			}
			other, _ := store.GetCloudGenerationSettings(ctx, 8)
			if other.Version != 0 || other.Title.Enabled {
				t.Fatal("cross-account preference")
			}
			for _, bad := range []CloudTitlePreferences{{ProviderKeyID: 41}, {Model: "no-key"}, {MaxOutputTokens: 255}, {MaxOutputTokens: 8193}, {Prompt: strings.Repeat("x", 4001)}, {ReasoningEffort: "arbitrary"}} {
				if _, err = store.SetCloudGenerationSettings(ctx, 7, 1, bad); !errors.Is(err, ErrCloudRunInvalid) {
					t.Fatal("invalid setting accepted", bad, err)
				}
			}
		})
	}
}

func TestCloudTitleModelConsumerAndGuardedApply(t *testing.T) {
	for _, scenario := range []string{"success", "disabled", "manual-before", "manual-during", "new-message", "settings-changed", "deleted", "logout", "failure", "secret", "truncated"} {
		t.Run(scenario, func(t *testing.T) {
			var calls atomic.Int64
			var mutate func()
			f, e := imageExecutionFixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.URL.Path != "/v1/chat/completions" {
					t.Error("unexpected auxiliary endpoint", r.URL.Path)
				}
				var payload map[string]any
				if json.NewDecoder(r.Body).Decode(&payload) != nil {
					t.Error("payload")
				}
				if payload["model"] != "gpt-image-test" || payload["max_completion_tokens"] != float64(1024) || payload["tools"] != nil || payload["reasoning_effort"] != "low" {
					t.Error("task preference not consumed", payload)
				}
				messages := payload["messages"].([]any)
				if len(messages) != 2 || messages[1].(map[string]any)["content"] != "create illustration" || !strings.Contains(messages[0].(map[string]any)["content"].(string), "中文") {
					t.Error("title input was not minimal")
				}
				if mutate != nil {
					mutate()
				}
				if scenario == "failure" {
					w.WriteHeader(503)
					return
				}
				if scenario == "truncated" {
					io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
					return
				}
				title := "图像创作计划"
				if scenario == "secret" {
					title = "synthetic-image-key"
				}
				io.WriteString(w, "data: "+string(cloudJSON(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": title}, "finish_reason": "stop"}}}))+"\n\ndata: [DONE]\n\n")
			})
			ctx := context.Background()
			e.runtime.ctx = ctx
			if _, err := f.store.CommitCloudRun(ctx, 1, e.run.ID, e.owner, e.run.Attempt, CloudRunCommit{OperationID: "title-fixture-complete", State: CloudRunCompleted, Delta: "answer"}); err != nil {
				t.Fatal(err)
			}
			pref := CloudTitlePreferences{Enabled: scenario != "disabled", ProviderKeyID: 41, Model: "gpt-image-test", ReasoningEffort: "low", MaxOutputTokens: 1024, Prompt: "使用中文"}
			if _, err := f.store.SetCloudGenerationSettings(ctx, 1, 0, pref); err != nil {
				t.Fatal(err)
			}
			original, _ := f.store.GetCloudConversation(ctx, 1, e.run.ConversationID)
			rename := func() {
				if _, err := f.service.RenameCloudConversation(ctx, 1, e.run.ConversationID, original.Title); err != nil {
					t.Error(err)
				}
			}
			switch scenario {
			case "manual-before":
				rename()
			case "manual-during":
				mutate = rename
			case "new-message":
				mutate = func() {
					_ = f.store.AddCloudMessage(ctx, &CloudMessage{ID: uuid.NewString(), ConversationID: e.run.ConversationID, UserID: 1, Role: "user", Content: cloudJSON("new task")})
				}
			case "settings-changed":
				mutate = func() { pref.Enabled = false; _, _ = f.store.SetCloudGenerationSettings(ctx, 1, 1, pref) }
			case "deleted":
				mutate = func() { _ = f.store.DeleteCloudConversation(ctx, 1, e.run.ConversationID) }
			case "logout":
				mutate = func() { _ = f.store.DeleteSession(ctx, "file-owner") }
			}
			e.runtime.generateCloudTitle(e.run)
			conversation, err := f.store.GetCloudConversation(ctx, 1, e.run.ConversationID)
			if scenario == "deleted" {
				if !errors.Is(err, ErrNotFound) {
					t.Fatal(err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "success" {
				if conversation.Title != "图像创作计划" || !conversation.UpdatedAt.Equal(original.UpdatedAt) {
					t.Fatal("title or list ordering changed incorrectly", conversation)
				}
				e.runtime.generateCloudTitle(e.run)
				if calls.Load() != 1 {
					t.Fatal("completed title replayed")
				}
			} else if conversation.Title != original.Title {
				t.Fatal("guarded title was overwritten", conversation.Title)
			}
			if (scenario == "disabled" || scenario == "manual-before") && calls.Load() != 0 {
				t.Fatal("ineligible title invoked a provider")
			}
		})
	}
}

func TestCloudTitleEligibilityAndCASAcrossStores(t *testing.T) {
	for _, postgres := range []bool{false, true} {
		t.Run(map[bool]string{false: "memory", true: "postgres"}[postgres], func(t *testing.T) {
			f := cloudRunMemoryFixture(t)
			if postgres {
				f = cloudRunPostgresFixture(t)
				p := f.store.(*PersistentStore)
				if _, err := p.db.Exec(CloudProjectSchema + CloudBranchSchema + CloudGenerationSettingsSchema); err != nil {
					t.Fatal(err)
				}
			}
			ctx := context.Background()
			prefStore := f.store.(cloudGenerationSettingsStore)
			titleStore := f.store.(cloudTitleStore)
			input := cloudRunTestInput(t, f, 7, "", uuid.NewString(), "user's first task")
			if _, _, err := f.runs.CreateCloudRun(ctx, input); err != nil {
				t.Fatal(err)
			}
			run, err := f.runs.ClaimCloudRun(ctx, "title-worker", cloudRunLease)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = titleStore.CloudTitleCandidate(ctx, run); !errors.Is(err, ErrNotFound) {
				t.Fatal("unfinished run eligible", err)
			}
			if _, err = f.runs.CommitCloudRun(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, CloudRunCommit{OperationID: "finished", State: CloudRunCompleted, Delta: "answer"}); err != nil {
				t.Fatal(err)
			}
			candidate, err := titleStore.CloudTitleCandidate(ctx, run)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = prefStore.SetCloudGenerationSettings(ctx, 7, 0, CloudTitlePreferences{Enabled: true}); err != nil {
				t.Fatal(err)
			}
			if err = titleStore.ApplyCloudTitle(ctx, run, candidate, 2, "wrong version"); !errors.Is(err, ErrCloudRunConflict) {
				t.Fatal("preference CAS bypassed", err)
			}
			if err = titleStore.ApplyCloudTitle(ctx, run, candidate, 1, "完成的标题"); err != nil {
				t.Fatal(err)
			}
			if err = titleStore.ApplyCloudTitle(ctx, run, candidate, 1, "overwritten"); !errors.Is(err, ErrCloudRunConflict) {
				t.Fatal("duplicate title applied", err)
			}
			forged := *run
			forged.UserID = 8
			if _, err = titleStore.CloudTitleCandidate(ctx, &forged); !errors.Is(err, ErrNotFound) {
				t.Fatal("cross-account eligibility", err)
			}
		})
	}
}

func TestCloudTitleAuxiliaryRequestsAreBounded(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int64
	f, execution := imageExecutionFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"A short title\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
	})
	ctx := context.Background()
	execution.runtime.ctx = ctx
	execution.runtime.config.WorkerCount = 1
	if _, err := f.store.CommitCloudRun(ctx, 1, execution.run.ID, execution.owner, execution.run.Attempt, CloudRunCommit{OperationID: "finish-title-limit", State: CloudRunCompleted, Delta: "answer"}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.store.SetCloudGenerationSettings(ctx, 1, 0, CloudTitlePreferences{Enabled: true, ProviderKeyID: 41, Model: "gpt-image-test"}); err != nil {
		t.Fatal(err)
	}
	execution.runtime.startCloudTitle(execution.run)
	<-started
	execution.runtime.startCloudTitle(execution.run)
	close(release)
	execution.runtime.wg.Wait()
	if calls.Load() != 1 {
		t.Fatal("overlapping auxiliary requests invoked the provider repeatedly", calls.Load())
	}
}
