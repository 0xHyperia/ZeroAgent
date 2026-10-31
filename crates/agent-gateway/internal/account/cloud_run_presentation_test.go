package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCloudPresentationAlternatingSegmentsKeepOrderAndRoundBudget(t *testing.T) {
	run := &CloudRun{Model: "synthetic", State: CloudRunRunning, CreatedAt: time.Now().UTC()}
	values := []struct{ kind, text string }{{"reasoning.delta", "先核对"}, {"message.delta", "第一段"}, {"reasoning.delta", "补充核对"}, {"message.delta", "第二段"}}
	for i, value := range values {
		commit := CloudRunCommit{EventType: value.kind, Payload: cloudJSON(map[string]any{"round": 0, "delta": value.text})}
		if value.kind == "message.delta" {
			commit.Delta = value.text
			run.Output += value.text
		}
		if err := applyCloudPresentation(run, &commit, run.CreatedAt.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	var p CloudPresentation
	if json.Unmarshal(run.Presentation, &p) != nil || len(p.Blocks) != 4 {
		t.Fatal("content alternation collapsed")
	}
	wantIDs := []string{"reasoning:0", "text:0", "reasoning:0:2", "text:0:2"}
	for i, block := range p.Blocks {
		if block.ID != wantIDs[i] || block.Text != values[i].text {
			t.Fatal("same-round content reordered")
		}
		if i < 3 && (block.CompletedAt == nil || !block.CompletedAt.Equal(p.Blocks[i+1].StartedAt)) {
			t.Fatal("segment interval includes later content")
		}
	}
	if run.Output != "第一段第二段" {
		t.Fatal("segment split changed canonical output")
	}
	p.Blocks[0].Text = strings.Repeat("a", cloudModelMaxReasoningBytes-len(p.Blocks[2].Text))
	run.Presentation = cloudJSON(p)
	commit := CloudRunCommit{EventType: "reasoning.delta", Payload: cloudJSON(map[string]any{"round": 0, "delta": "x"})}
	if !errors.Is(applyCloudPresentation(run, &commit, time.Now()), ErrCloudRunLimit) {
		t.Fatal("new segment bypassed per-round reasoning limit")
	}
}

func TestCloudPresentationMemoryContract(t *testing.T) {
	runCloudPresentationContract(t, cloudRunMemoryFixture)
}
func TestCloudPresentationPostgresContract(t *testing.T) {
	runCloudPresentationContract(t, cloudRunPostgresFixture)
}

func presentationRun(t *testing.T, f cloudRunTestFixture) *CloudRun {
	t.Helper()
	input := cloudRunTestInput(t, f, 71, "", uuid.NewString(), "公开验收问题")
	input.Presentation = cloudJSON(map[string]any{"forged": true})
	run, _, err := f.runs.CreateCloudRun(context.Background(), input)
	if err != nil || len(run.Presentation) != 0 {
		t.Fatalf("run creation accepted supplied projection: %v", err)
	}
	run, err = f.runs.ClaimCloudRun(context.Background(), "presentation-test", time.Minute)
	if err != nil || run == nil {
		t.Fatalf("claim isolated fixture: %v", err)
	}
	return run
}

func runCloudPresentationContract(t *testing.T, factory func(*testing.T) cloudRunTestFixture) {
	t.Run("atomic public events terminal history budget branch and owner", func(t *testing.T) {
		f := factory(t)
		ctx := context.Background()
		run := presentationRun(t, f)
		commit := func(update CloudRunCommit) *CloudRun {
			t.Helper()
			if update.OperationID == "" {
				update.OperationID = uuid.NewString()
			}
			result, err := f.runs.CommitCloudRun(ctx, run.UserID, run.ID, "presentation-test", run.Attempt, update)
			if err != nil {
				t.Fatalf("commit %s: %v", update.EventType, err)
			}
			return result
		}
		commit(CloudRunCommit{EventType: "model.started", Payload: cloudJSON(map[string]any{"round": 0})})
		reasoning := CloudRunCommit{OperationID: "reasoning-once", EventType: "reasoning.delta", Payload: cloudJSON(map[string]any{"round": 0, "delta": "先核对资料。"})}
		first := commit(reasoning)
		replay := commit(reasoning)
		var firstProjection, replayProjection CloudPresentation
		_ = json.Unmarshal(first.Presentation, &firstProjection)
		_ = json.Unmarshal(replay.Presentation, &replayProjection)
		if replay.LastSeq != first.LastSeq || string(cloudJSON(firstProjection)) != string(cloudJSON(replayProjection)) {
			t.Fatal("idempotent reasoning appended twice")
		}
		toolID := uuid.NewString()
		toolPayload := cloudJSON(map[string]any{"tool_id": toolID, "name": "execute_code", "round": 0, "input": "private-arguments", "status": "private-result", "result": "private-result"})
		commit(CloudRunCommit{EventType: "tool.started", Payload: toolPayload})
		commit(CloudRunCommit{EventType: "tool.completed", Payload: toolPayload})
		commit(CloudRunCommit{EventType: "model.completed", Payload: cloudJSON(map[string]any{"round": 0, "usage": map[string]any{"total_tokens": 11, "private": "private-usage"}})})
		commit(CloudRunCommit{EventType: "model.started", Payload: cloudJSON(map[string]any{"round": 1})})
		commit(CloudRunCommit{Delta: "最终正文", EventType: "message.delta", Payload: cloudJSON(map[string]any{"round": 1})})
		commit(CloudRunCommit{EventType: "model.completed", Payload: cloudJSON(map[string]any{"round": 1, "usage": map[string]any{"total_tokens": 7}})})
		finished := commit(CloudRunCommit{OperationID: "terminal-once", State: CloudRunCompleted, Usage: cloudJSON(map[string]int{"total_tokens": 18})})
		var p CloudPresentation
		if json.Unmarshal(finished.Presentation, &p) != nil || len(p.Blocks) != 3 || len(p.Rounds) != 2 || p.Blocks[0].Type != "reasoning" || p.Blocks[1].State != CloudToolSucceeded || p.Blocks[2].Text != finished.Output || p.State != CloudRunCompleted || p.CompletedAt == nil || p.Rounds[0].CompletedAt == nil || string(p.Rounds[0].Usage) != `{"total_tokens":11}` {
			t.Fatalf("invalid persisted projection: %s", finished.Presentation)
		}
		events, err := f.runs.ListCloudRunEvents(ctx, run.UserID, run.ID, 0, 100)
		if err != nil {
			t.Fatal(err)
		}
		encoded := string(cloudJSON(events)) + string(finished.Presentation)
		for _, secret := range []string{"private-arguments", "private-result", "private-usage"} {
			if strings.Contains(encoded, secret) {
				t.Fatal("private tool data entered public projection or replay")
			}
		}
		if !strings.Contains(string(events[len(events)-1].Payload), "completed_at") {
			t.Fatal("live terminal projection cannot match stored finalization")
		}
		messages, err := f.store.ListCloudMessages(ctx, run.UserID, run.ConversationID)
		if err != nil || len(messages) != 2 || string(messages[1].Content) != `"最终正文"` {
			t.Fatalf("terminal history: %v", err)
		}
		var saved CloudPresentation
		if json.Unmarshal(messages[1].Presentation, &saved) != nil || string(cloudJSON(saved)) != string(cloudJSON(p)) {
			t.Fatal("canonical message and run disagree")
		}
		history := f.store.(CloudHistoryStore)
		heads, err := history.ListCloudMessageHeads(ctx, run.UserID, run.ConversationID, "", 100)
		if err != nil {
			t.Fatal(err)
		}
		bodyBudget := int64(0)
		ids := []string{}
		for _, head := range heads.Items {
			bodyBudget += head.ContentBytes + head.UsageBytes
			ids = append(ids, head.ID)
		}
		page, err := history.GetCloudHistoryMessages(ctx, run.UserID, run.ConversationID, ids, bodyBudget)
		if err != nil || page[0].ContentOmitted || page[1].ContentOmitted || !page[1].PresentationOmitted || len(page[1].Presentation) != 0 {
			t.Fatal("presentation displaced canonical body budget")
		}
		views := f.store.(cloudRunViewStore)
		head, err := views.GetCloudRunHead(ctx, run.UserID, run.ID)
		if err != nil || len(head.Presentation) != 0 || head.Output != "" {
			t.Fatal("head fetched large projection")
		}
		list, err := views.ListCloudRunViews(ctx, run.UserID, run.ConversationID, false, "")
		if err != nil || len(list) != 1 || len(list[0].Presentation) != 0 {
			t.Fatal("history run list fetched large projection")
		}
		if _, err := views.GetCloudRunView(ctx, run.UserID+1, run.ID); !errors.Is(err, ErrNotFound) {
			t.Fatal("cross-account projection read")
		}
		if _, err := history.GetCloudHistoryMessages(ctx, run.UserID+1, run.ConversationID, ids, CloudRunMaxInputBytes); !errors.Is(err, ErrNotFound) {
			t.Fatal("cross-account history read")
		}
		if persistent, ok := f.store.(*PersistentStore); ok {
			if _, err := persistent.db.Exec(CloudProjectSchema + CloudBranchSchema); err != nil {
				t.Fatal(err)
			}
		}
		branch, _, err := f.store.(CloudBranchStore).CreateCloudBranch(ctx, run.UserID, run.ConversationID, CloudBranchInput{ClientRequestID: "presentation-fork", MessageID: run.AssistantMessageID, Action: "fork"})
		if err != nil {
			t.Fatal(err)
		}
		clones, err := f.store.ListCloudMessages(ctx, run.UserID, branch.Conversation.ID)
		if err != nil || len(clones) != 2 || clones[1].ID == messages[1].ID || string(clones[1].Presentation) != string(messages[1].Presentation) {
			t.Fatal("fork lost structured process")
		}
		var markdown strings.Builder
		writeCloudPresentationMarkdown(&markdown, messages[1].Presentation)
		if !strings.Contains(markdown.String(), "先核对资料。") || !strings.Contains(markdown.String(), "execute_code") {
			t.Fatal("Markdown export lost work record")
		}
	})
	t.Run("legacy output and expired work preserve partial unknown outcome", func(t *testing.T) {
		f := factory(t)
		ctx := context.Background()
		run := presentationRun(t, f)
		f.setOutput(run.ID, "已有前缀。")
		commit := CloudRunCommit{OperationID: "legacy-tail", Delta: "新增正文", Payload: cloudJSON(map[string]any{"round": 1})}
		updated, err := f.runs.CommitCloudRun(ctx, run.UserID, run.ID, "presentation-test", run.Attempt, commit)
		if err != nil {
			t.Fatal(err)
		}
		var p CloudPresentation
		if json.Unmarshal(updated.Presentation, &p) != nil || len(p.Blocks) != 2 || p.Blocks[0].ID != "legacy:text" || p.Blocks[0].Text+p.Blocks[1].Text != updated.Output {
			t.Fatal("structured upgrade lost legacy output prefix")
		}
		_, err = f.runs.CommitCloudRun(ctx, run.UserID, run.ID, "presentation-test", run.Attempt, CloudRunCommit{OperationID: "active-tool", EventType: "tool.started", Payload: cloudJSON(map[string]any{"round": 1, "tool_id": uuid.NewString(), "name": "execute_command"})})
		if err != nil {
			t.Fatal(err)
		}
		f.expire(run.ID)
		if count, err := f.runs.InterruptExpiredCloudRuns(ctx); err != nil || count != 1 {
			t.Fatalf("recover expired: %d %v", count, err)
		}
		ended, err := f.runs.GetCloudRun(ctx, run.UserID, run.ID)
		if err != nil || json.Unmarshal(ended.Presentation, &p) != nil || ended.State != CloudRunInterrupted || p.Blocks[2].State != CloudToolUnknown || p.Blocks[2].CompletedAt == nil {
			t.Fatal("recovery invented tool success or cancellation")
		}
		if _, err = f.runs.CommitCloudRun(ctx, run.UserID, run.ID, "presentation-test", run.Attempt, CloudRunCommit{OperationID: "late", Delta: "late"}); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatal("expired worker changed process")
		}
		messages, err := f.store.ListCloudMessages(ctx, run.UserID, run.ConversationID)
		if err != nil || len(messages) != 2 || len(messages[1].Presentation) == 0 {
			t.Fatal("recovery lost canonical process history")
		}
	})
	t.Run("bounded reasoning cancellation and rejected writes are atomic", func(t *testing.T) {
		f := factory(t)
		ctx := context.Background()
		run := presentationRun(t, f)
		var latest *CloudRun
		for index := 0; index < 16; index++ {
			var err error
			latest, err = f.runs.CommitCloudRun(ctx, run.UserID, run.ID, "presentation-test", run.Attempt, CloudRunCommit{OperationID: fmt.Sprint("bounded-", index), EventType: "reasoning.delta", Payload: cloudJSON(map[string]any{"delta": strings.Repeat("r", 64<<10)})})
			if err != nil {
				t.Fatal(err)
			}
		}
		_, err := f.runs.CommitCloudRun(ctx, run.UserID, run.ID, "presentation-test", run.Attempt, CloudRunCommit{OperationID: "over-limit", EventType: "reasoning.delta", Payload: cloudJSON(map[string]any{"delta": "overflow"})})
		if !errors.Is(err, ErrCloudRunLimit) {
			t.Fatal("unbounded reasoning accepted")
		}
		unchanged, err := f.runs.GetCloudRun(ctx, run.UserID, run.ID)
		if err != nil || unchanged.LastSeq != latest.LastSeq || strings.Contains(string(unchanged.Presentation), "overflow") {
			t.Fatal("rejected projection write changed durable state")
		}
		_, err = f.runs.CommitCloudRun(ctx, run.UserID, run.ID, "stale-worker", run.Attempt, CloudRunCommit{OperationID: "bad-lease", Delta: "bad"})
		if !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatal("projection bypassed execution lease")
		}
		_, err = f.runs.CommitCloudRun(ctx, run.UserID, run.ID, "presentation-test", run.Attempt, CloudRunCommit{OperationID: "executing", EventType: "tool.started", Payload: cloudJSON(map[string]any{"tool_id": uuid.NewString(), "name": "execute_code"})})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.CancelCloudRun(ctx, run.UserID, run.ID); err != nil {
			t.Fatal(err)
		}
		ended, err := f.runs.CommitCloudRun(ctx, run.UserID, run.ID, "presentation-test", run.Attempt, CloudRunCommit{OperationID: "cancelled", State: CloudRunCancelled})
		var p CloudPresentation
		if err != nil || json.Unmarshal(ended.Presentation, &p) != nil || p.Blocks[len(p.Blocks)-1].State != CloudToolUnknown {
			t.Fatal("cancellation fabricated external stop certainty")
		}
	})
}

func TestCloudPresentationTransitionTimingAndToolMonotonicity(t *testing.T) {
	t0 := time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)
	run := &CloudRun{State: CloudRunRunning, Model: "fixture", CreatedAt: t0}
	apply := func(kind string, payload map[string]any, delta string, seconds int) error {
		update := CloudRunCommit{EventType: kind, Payload: cloudJSON(payload), Delta: delta}
		run.Output += delta
		return applyCloudPresentation(run, &update, t0.Add(time.Duration(seconds)*time.Second))
	}
	if err := apply("reasoning.delta", map[string]any{"delta": "思考"}, "", 1); err != nil {
		t.Fatal(err)
	}
	if err := apply("message.delta", map[string]any{}, "正文", 3); err != nil {
		t.Fatal(err)
	}
	if err := apply("model.completed", map[string]any{}, "", 9); err != nil {
		t.Fatal(err)
	}
	tool := map[string]any{"tool_id": uuid.NewString(), "name": "read_file"}
	if err := apply("tool.started", tool, "", 10); err != nil {
		t.Fatal(err)
	}
	if err := apply("tool.prepared", tool, "", 11); !errors.Is(err, ErrCloudRunConflict) {
		t.Fatal("tool process regressed to prepared")
	}
	run.State = CloudRunCompleted
	finishCloudPresentation(run, t0.Add(15*time.Second))
	var p CloudPresentation
	_ = json.Unmarshal(run.Presentation, &p)
	if p.Blocks[0].CompletedAt == nil || !p.Blocks[0].CompletedAt.Equal(t0.Add(3*time.Second)) || p.Blocks[1].CompletedAt == nil || !p.Blocks[1].CompletedAt.Equal(t0.Add(9*time.Second)) {
		t.Fatal("model or run completion extended reasoning duration into body generation")
	}
}

func TestCloudModelStreamReasoningIndependentRedactionAndLimits(t *testing.T) {
	stream := newCloudModelStream([]string{"synthetic-private-key"})
	var reasoning, text strings.Builder
	for _, frame := range [][]byte{
		cloudModelChunk(map[string]any{"reasoning_content": "核对 synthetic-pri"}, nil, nil),
		cloudModelChunk(map[string]any{"content": "正文"}, nil, nil),
		cloudModelChunk(map[string]any{"reasoning_content": "vate-key 后继续。", "reasoning": "ignored duplicate"}, nil, nil),
		cloudModelChunk(map[string]any{}, "stop", map[string]int{"total_tokens": 9}), []byte("[DONE]"),
	} {
		update, err := stream.FeedSSE(frame)
		if err != nil {
			t.Fatal(err)
		}
		reasoning.WriteString(update.ReasoningDelta)
		text.WriteString(update.Delta)
	}
	result, err := stream.Finish()
	if err != nil || result.Text != text.String() || result.Reasoning != reasoning.String() || result.Text != "正文" || strings.Contains(result.Reasoning, "synthetic-private-key") || strings.Contains(result.Reasoning, "ignored duplicate") || !strings.Contains(result.Reasoning, "后继续") {
		t.Fatal("reasoning mixed with content or bypassed secret filtering")
	}
	stream = newCloudModelStream(nil)
	for i := 0; i < 16; i++ {
		if _, err := stream.FeedSSE(cloudModelChunk(map[string]any{"reasoning": strings.Repeat("r", 64<<10)}, nil, nil)); err != nil {
			t.Fatal(err)
		}
	}
	_, err = stream.FeedSSE(cloudModelChunk(map[string]any{"reasoning": "overflow"}, nil, nil))
	requireModelCode(t, err, "model_output_limit")
	stream = newCloudModelStream(nil)
	if _, err := stream.FeedSSE(cloudModelChunk(map[string]any{"content": "正文仍可读", "reasoning": map[string]any{"private_metadata": "ignored"}}, "stop", nil)); err != nil {
		t.Fatal("provider's structured metadata broke ordinary content")
	}
	result, err = stream.Finish()
	if err != nil || result.Text != "正文仍可读" || result.Reasoning != "" {
		t.Fatal("non-text reasoning metadata was exposed")
	}
}

func TestCloudPresentationHTTPStreamReplayHistoryExport(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, frame := range [][]byte{
			cloudModelChunk(map[string]any{"reasoning_content": "先分析 synthetic-model-"}, nil, nil),
			cloudModelChunk(map[string]any{"reasoning_content": "key；再核对。"}, nil, nil),
			cloudModelChunk(map[string]any{"content": "最终回答"}, "stop", map[string]int{"total_tokens": 12}), []byte("[DONE]"),
		} {
			_, _ = fmt.Fprintf(w, "data: %s\n\n", frame)
		}
	})
	run, _ := f.create(t, "presentation-http", "问题")
	ended := f.wait(t, run.ID, func(r *CloudRun) bool { return r.Terminal() })
	var p CloudPresentation
	if ended.State != CloudRunCompleted || ended.Output != "最终回答" || json.Unmarshal(ended.Presentation, &p) != nil || len(p.Blocks) != 2 || p.Blocks[0].Type != "reasoning" || p.Blocks[1].Type != "text" || len(p.Rounds) != 1 || p.Rounds[0].CompletedAt == nil {
		t.Fatalf("runtime structured projection failed: %s", ended.Presentation)
	}
	for _, path := range []string{
		"/api/web-chat/runs/" + run.ID + "/events?after_seq=1",
		"/api/web-chat/conversations/" + run.ConversationID + "/export?format=json",
		"/api/web-chat/conversations/" + run.ConversationID + "/export?format=markdown",
	} {
		status, body := f.request(t, "GET", path, "synthetic-browser-cookie", "")
		if status != 200 || !strings.Contains(body, "再核对") || strings.Contains(body, "synthetic-model-key") {
			t.Fatalf("unsafe/incomplete history or replay: status %d", status)
		}
	}
	if f.calls.Load() != 1 {
		t.Fatal("history/replay/export reran model")
	}
}
