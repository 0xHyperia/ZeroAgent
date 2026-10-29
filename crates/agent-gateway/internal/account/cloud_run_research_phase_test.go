package account

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/google/uuid"
)

func TestCloudRunPublicResearchPhaseSeparatesPrivateContextAndOutput(t *testing.T) {
	const topic = "public astronomy topic"
	canaries := []string{"PRIVATE_PROJECT_ZEBRA", "PRIVATE_MEMORY_HERON", "PRIVATE_ATTACHMENT_IBIS", "PRIVATE_HISTORY_OTTER", "PRIVATE_CURRENT_USER_CRANE"}
	var rounds atomic.Int32
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var request map[string]any
		_ = json.Unmarshal(body, &request)
		schemas := string(cloudJSON(request["tools"]))
		round := rounds.Add(1)
		if round < 3 {
			for _, canary := range canaries {
				if strings.Contains(string(body), canary) {
					t.Errorf("private %s entered public phase", canary)
				}
			}
			if !strings.Contains(string(body), topic) || strings.Contains(schemas, "read_history") || strings.Contains(schemas, "execute_code") || !strings.Contains(schemas, "web_search") {
				t.Error("public phase mixed private tools or lost approved topic")
			}
		} else {
			for _, canary := range canaries {
				if !strings.Contains(string(body), canary) {
					t.Errorf("private synthesis lost %s", canary)
				}
			}
			if strings.Contains(schemas, "web_search") || strings.Contains(schemas, "fetch_page") || !strings.Contains(string(body), "Search summary only") {
				t.Error("private synthesis retained network permission or lost public evidence")
			}
		}
		switch round {
		case 1:
			emitCloudDelta(w, "PUBLIC_DRAFT_MUST_NOT_BE_CANONICAL")
			emitToolCalls(w, map[string]any{"index": 0, "id": "public-search", "type": "function", "function": map[string]any{"name": "web_search", "arguments": `{"query":"public astronomy topic"}`}})
			emitModelFinish(w, "tool_calls", 1)
		case 2:
			emitCloudDelta(w, "PUBLIC_SUMMARY_MUST_NOT_BE_CANONICAL")
			emitModelFinish(w, "stop", 2)
		default:
			emitCloudDelta(w, "PRIVATE_FINAL_ONLY")
			emitModelFinish(w, "stop", 3)
		}
	})
	research := configureCloudResearchFixture(t, f)
	ctx := context.Background()
	project, err := f.store.CreateCloudProject(ctx, &CloudProject{UserID: 1, Name: "private", Instructions: canaries[0]})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.SetCloudConversationProject(ctx, 1, f.conversation.ID, project.ID, 0); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.CreateCloudMemory(ctx, &CloudMemory{UserID: 1, Content: canaries[1], Enabled: true}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.SetCloudMemorySettings(ctx, 1, 0, true); err != nil {
		t.Fatal(err)
	}
	file := projectReadyFile(t, cloudProjectFixture{store: f.store, files: f.store}, 1, f.conversation.ID)
	if file, err = f.store.UpdateCloudFile(ctx, 1, file.ID, file.Version, CloudFileUpdate{State: CloudFileReady, Text: &canaries[2]}); err != nil {
		t.Fatal(err)
	}
	if _, err = f.store.SetCloudProjectFile(ctx, 1, project.ID, file.ID, project.Version, true); err != nil {
		t.Fatal(err)
	}
	if err = f.store.AddCloudMessage(ctx, &CloudMessage{ID: uuid.NewString(), UserID: 1, ConversationID: f.conversation.ID, Role: "user", Content: cloudJSON(canaries[3])}); err != nil {
		t.Fatal(err)
	}
	run, _ := f.createResearch(t, "isolated-public-then-private", canaries[4], topic)
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || finished.Output != "PRIVATE_FINAL_ONLY" || rounds.Load() != 3 || research.searches.Load() != 1 || research.pages.Load() != 0 {
		t.Fatalf("phase result: state=%s code=%s rounds=%d output=%q", finished.State, finished.ErrorCode, rounds.Load(), finished.Output)
	}
	var usage map[string]int64
	if json.Unmarshal(finished.Usage, &usage) != nil || usage["total_tokens"] != 6 {
		t.Fatal("public phase usage was lost or counted twice")
	}
	events, _ := f.store.ListCloudRunEvents(ctx, 1, run.ID, 0, 100)
	for _, event := range events {
		if strings.Contains(string(event.Payload), "MUST_NOT_BE_CANONICAL") {
			t.Fatal("public draft leaked into public Run events")
		}
	}
	messages, _ := f.store.ListCloudMessages(ctx, 1, f.conversation.ID)
	if len(messages) != 3 || string(messages[2].Content) != `"PRIVATE_FINAL_ONLY"` {
		t.Fatal("public draft became an extra canonical assistant")
	}
}

func TestCloudRunPrivateSynthesisCannotForgePublicNetworkCalls(t *testing.T) {
	for _, name := range []string{"web_search", "fetch_page"} {
		t.Run(name, func(t *testing.T) {
			var rounds atomic.Int32
			f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if rounds.Add(1) == 1 {
					emitCloudDelta(w, "public phase done")
					emitModelFinish(w, "stop", 1)
					return
				}
				args := `{"query":"private synthesis text must not leave"}`
				if name == "fetch_page" {
					args = `{"url":"http://example.com/?report=private-text"}`
				}
				emitToolCalls(w, map[string]any{"index": 0, "id": "forged-network", "type": "function", "function": map[string]any{"name": name, "arguments": args}})
				emitModelFinish(w, "tool_calls", 1)
			})
			research := configureCloudResearchFixture(t, f)
			run, _ := f.createResearch(t, "deny-private-network-"+name, "private analysis", "public topic")
			finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
			ops, _ := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 128)
			if finished.State != CloudRunFailed || finished.ErrorCode != "cloud_tool_unavailable" || research.searches.Load() != 0 || research.pages.Load() != 0 || len(ops) != 0 {
				t.Fatalf("private network call escaped: state=%s code=%s", finished.State, finished.ErrorCode)
			}
		})
	}
}

func TestCloudRunPublicCapabilityRejectsPrivateToolsBeforeLedger(t *testing.T) {
	f, peer, execution := newCloudResearchScopeFixture(t, &CloudRunPublicResearch{Topic: "approved public topic"})
	execution.runtime.config = DefaultCloudRuntimeConfig()
	execution.executorEnabled = true
	public, err := execution.beginPublicResearch(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, call := range []cloudModelToolCall{
		{ID: "history", Name: "read_history", Arguments: `{}`},
		{ID: "file", Name: "read_file", Arguments: `{"path":"private.txt"}`},
		{ID: "code", Name: "execute_code", Arguments: `{"code":"print('no')"}`},
	} {
		if _, err := execution.execute(public, 0, call); err == nil || err.Error() != "model_tool_invalid" {
			t.Fatal("public capability permitted a private-data tool")
		}
	}
	if execution.calls != 0 || f.store.cloudTools != nil || peer.searches.Load() != 0 || peer.pages.Load() != 0 {
		t.Fatal("private tool guard ran after ledger, budget or HTTP")
	}
	execution.endPublicResearch()
	if _, err := execution.execute(public, 1, cloudModelToolCall{ID: "stale", Name: "read_history", Arguments: `{}`}); err == nil || execution.calls != 0 {
		t.Fatal("revoked public context was reused for private execution")
	}
}

func TestCloudRunPublicResearchReservesFinalSynthesisRound(t *testing.T) {
	var rounds atomic.Int32
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if rounds.Add(1) == 1 {
			emitToolCalls(w, map[string]any{"index": 0, "id": "bounded-search", "type": "function", "function": map[string]any{"name": "web_search", "arguments": `{"query":"bounded topic"}`}})
			emitModelFinish(w, "tool_calls", 1)
			return
		}
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "private current user") || !strings.Contains(string(body), "Search summary only") {
			t.Error("reserved final round did not synthesize private request and public evidence")
		}
		emitCloudDelta(w, "final within shared budget")
		emitModelFinish(w, "stop", 1)
	})
	research := configureCloudResearchFixture(t, f)
	config := DefaultCloudRuntimeConfig()
	config.MaxModelRounds, config.MaxToolCalls = 2, 1
	if err := f.service.SetCloudRuntimeConfig(config); err != nil {
		t.Fatal(err)
	}
	run, _ := f.createResearch(t, "two-round-total-budget", "private current user", "bounded topic")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || finished.Output != "final within shared budget" || rounds.Load() != 2 || research.searches.Load() != 1 {
		t.Fatal("public phase consumed private synthesis budget or repeated search")
	}
}

func TestCloudRunPublicResearchHTTPFingerprintAndValidation(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) { emitCloudDelta(w, "done"); emitModelFinish(w, "stop", 1) })
	configureCloudResearchFixture(t, f)
	run, body := f.createResearch(t, "public-snapshot-hash", "private request", "  public topic  ")
	f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	var input CreateCloudRunInput
	_ = json.Unmarshal([]byte(body), &input)
	input.PublicResearch.Topic = "public topic"
	status, _ := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	if status != 200 || f.calls.Load() != 2 {
		t.Fatal("normalized public topic replay duplicated model calls")
	}
	input.PublicResearch.Topic = "different topic"
	status, _ = f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	if status != 409 || f.calls.Load() != 2 {
		t.Fatal("changed public authorization reused accepted request identity")
	}
	for _, topic := range []string{" ", strings.Repeat("a", 8193)} {
		input.ClientRequestID = uuid.NewString()
		input.PublicResearch.Topic = topic
		status, _ = f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
		if status != 400 || f.calls.Load() != 2 {
			t.Fatal("invalid public authorization reached model")
		}
	}
}

func TestCloudRunPublicResearchSnapshotMemory(t *testing.T) {
	testCloudRunPublicResearchSnapshot(t, cloudRunMemoryFixture)
}
func TestCloudRunPublicResearchSnapshotPostgres(t *testing.T) {
	testCloudRunPublicResearchSnapshot(t, cloudRunPostgresFixture)
}
func testCloudRunPublicResearchSnapshot(t *testing.T, factory func(*testing.T) cloudRunTestFixture) {
	f := factory(t)
	input := cloudRunTestInput(t, f, 7, "", uuid.NewString(), "private")
	input.PublicResearch = &CloudRunPublicResearch{Topic: "  approved public topic  "}
	run, _, err := f.runs.CreateCloudRun(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	input.PublicResearch.Topic = "mutated caller"
	run.PublicResearch.Topic = "mutated return"
	read, err := f.runs.GetCloudRun(context.Background(), 7, run.ID)
	if err != nil || read.PublicResearch == nil || read.PublicResearch.Topic != "approved public topic" {
		t.Fatal("research authorization snapshot mutated or lost")
	}
	view, err := f.runs.(cloudRunViewStore).GetCloudRunHead(context.Background(), 7, run.ID)
	if err != nil || view.PublicResearch == nil || view.PublicResearch.Topic != "approved public topic" {
		t.Fatal("public projection lost normalized authorization snapshot")
	}
	read.PublicResearch.Topic = "mutated read"
	again, err := f.runs.GetCloudRun(context.Background(), 7, run.ID)
	if err != nil || again.PublicResearch.Topic != "approved public topic" {
		t.Fatal("read-side pointer changed accepted authorization")
	}
}
