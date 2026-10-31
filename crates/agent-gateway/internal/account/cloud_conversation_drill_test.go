package account

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// This opt-in focused drill uses the production routes, auth/session guard,
// runner, durable in-memory store and SSE protocol. Model/SDK/object endpoints
// are separate loopback fixtures; no development database or real queue is used.
// Run: go test ./internal/account -run '^TestCloudConversationLocalDrill$' -count=1 -v -timeout=60s
func TestCloudConversationLocalDrill(t *testing.T) {
	t.Run("disconnect_replay_history_and_idempotency", func(t *testing.T) {
		release := make(chan struct{})
		var releaseOnce sync.Once
		t.Cleanup(func() { releaseOnce.Do(func() { close(release) }) })
		aborted := make(chan struct{}, 1)
		const first = "合成验收第一段。"
		const last = "合成验收第二段。"
		f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
			emitDrillReasoning(w, "合成思考：先核对输入，再组织答复。")
			emitCloudDelta(w, first)
			select {
			case <-release:
			case <-r.Context().Done():
				aborted <- struct{}{}
				return
			}
			emitCloudDelta(w, last)
			emitModelFinish(w, "stop", 7)
		})
		f.server.Client().Timeout = 6 * time.Second
		run, originalRequest := f.create(t, "local-drill-replay", "合成验收数据：核对流式重连")
		var before strings.Builder
		cursor := int64(0)
		initialFrames := drillSSE(t, f, run.ID, 0, func(frame drillFrame) bool {
			if frame.Kind == "snapshot" {
				var data struct {
					Run *CloudRun `json:"run"`
				}
				drillDecode(t, frame.Data, &data)
				if data.Run == nil {
					t.Fatal("snapshot omitted run")
				}
				cursor = data.Run.LastSeq
				before.WriteString(data.Run.Output)
			} else if frame.Kind == "cloud_run" {
				var event drillEvent
				drillDecode(t, frame.Data, &event)
				seq, err := strconv.ParseInt(event.Seq, 10, 64)
				if err != nil || seq != cursor+1 {
					t.Fatal("initial stream has a sequence gap")
				}
				cursor = seq
				if event.Type == "message.delta" {
					before.WriteString(event.Data.Delta)
				}
			}
			return strings.Contains(before.String(), first)
		})
		if cursor == 0 || before.String() != first {
			t.Fatal("live viewer did not receive the first partial answer")
		}
		select {
		case <-aborted:
			t.Fatal("closing only the SSE viewer cancelled the model request")
		default:
		}
		releaseOnce.Do(func() { close(release) })
		finished := drillWaitRun(t, f, run.ID, func(run *CloudRun) bool { return run.Terminal() })
		if finished.State != CloudRunCompleted || finished.Output != first+last {
			t.Fatal("completed output differs from streamed content")
		}
		after := cursor
		terminalEvent := false
		replayFrames := drillSSE(t, f, run.ID, cursor, func(frame drillFrame) bool {
			if frame.Kind != "cloud_run" {
				t.Fatal("replay unexpectedly replaced unconsumed events with a snapshot")
			}
			var event drillEvent
			drillDecode(t, frame.Data, &event)
			seq, err := strconv.ParseInt(event.Seq, 10, 64)
			if err != nil || seq != after+1 || event.RunID != run.ID {
				t.Fatal("replay repeated or skipped an event")
			}
			after = seq
			if event.Type == "message.delta" {
				before.WriteString(event.Data.Delta)
			}
			terminalEvent = terminalEvent || event.Type == "run.completed"
			return false
		})
		if before.String() != finished.Output || after != finished.LastSeq || !terminalEvent {
			t.Fatal("Last-Event-ID replay did not finish the same answer exactly once")
		}
		status, duplicate := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", originalRequest)
		var retried struct {
			Run *CloudRun `json:"run"`
		}
		drillDecode(t, []byte(duplicate), &retried)
		if status != http.StatusOK || retried.Run == nil || retried.Run.ID != run.ID || f.calls.Load() != 1 {
			t.Fatal("accepted request replay created another generation")
		}
		presentation := drillAssertHistory(t, f, finished)
		if len(presentation.Rounds) != 1 || len(presentation.Blocks) != 2 || presentation.Blocks[0].Type != "reasoning" || presentation.Blocks[0].CompletedAt == nil {
			t.Fatal("history lost the complete structured model round")
		}
		t.Logf("local-drill-evidence %s", cloudJSON(map[string]any{"scenario": "disconnect-replay", "synthetic": true, "run_id": run.ID, "initial_frames": initialFrames, "resume_cursor": cursor, "replay_frames": replayFrames, "last_seq": after, "model_calls": f.calls.Load(), "history_blocks": len(presentation.Blocks)}))
	})

	t.Run("explicit_stop_keeps_partial_history", func(t *testing.T) {
		stopped := make(chan struct{}, 1)
		const partial = "合成验收数据：停止前已生成的正文。"
		f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
			emitDrillReasoning(w, "合成思考：演练用户主动停止。")
			emitCloudDelta(w, partial)
			<-r.Context().Done()
			stopped <- struct{}{}
		})
		f.server.Client().Timeout = 6 * time.Second
		run, _ := f.create(t, "local-drill-stop", "合成验收数据：主动停止")
		drillWaitRun(t, f, run.ID, func(run *CloudRun) bool { return run.Output == partial })
		status, _ := f.request(t, http.MethodPost, "/api/web-chat/runs/"+run.ID+"/cancel", "synthetic-browser-cookie", "")
		if status != http.StatusOK {
			t.Fatal("cancel endpoint rejected the owned active run")
		}
		finished := drillWaitRun(t, f, run.ID, func(run *CloudRun) bool { return run.Terminal() })
		if finished.State != CloudRunCancelled || finished.Output != partial || f.calls.Load() != 1 {
			t.Fatal("stop lost partial output or started another generation")
		}
		select {
		case <-stopped:
		case <-time.After(time.Second):
			t.Fatal("stop did not reach the model HTTP request")
		}
		presentation := drillAssertHistory(t, f, finished)
		if presentation.State != CloudRunCancelled || presentation.CompletedAt == nil {
			t.Fatal("cancelled process was not persisted")
		}
		cancelledEvent := false
		frames := drillSSE(t, f, run.ID, 1, func(frame drillFrame) bool {
			if frame.Kind != "cloud_run" {
				return false
			}
			var event drillEvent
			drillDecode(t, frame.Data, &event)
			cancelledEvent = cancelledEvent || event.Type == "run.cancelled"
			return false
		})
		if !cancelledEvent {
			t.Fatal("stop has no replayable terminal event")
		}
		t.Logf("local-drill-evidence %s", cloudJSON(map[string]any{"scenario": "explicit-stop", "synthetic": true, "run_id": run.ID, "state": finished.State, "replay_frames": frames, "history_blocks": len(presentation.Blocks)}))
	})

	t.Run("published_output_survives_following_model_failure", func(t *testing.T) {
		var rounds atomic.Int32
		const csv = "说明,数值\n合成验收数据,42\n"
		f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
			switch rounds.Add(1) {
			case 1:
				emitDrillReasoning(w, "合成思考：写入并保存成果，随后模拟模型失败。")
				emitCloudDelta(w, "合成验收数据：正在准备可下载成果。")
				emitToolCalls(w, map[string]any{"index": 0, "id": "drill-write", "type": "function", "function": map[string]any{"name": "write_file", "arguments": string(cloudJSON(map[string]any{"path": "results/drill.csv", "content": csv}))}})
				emitModelFinish(w, "tool_calls", 3)
			case 2:
				emitToolCalls(w, map[string]any{"index": 0, "id": "drill-publish", "type": "function", "function": map[string]any{"name": "publish_artifact", "arguments": `{"path":"results/drill.csv","name":"合成验收成果.csv"}`}})
				emitModelFinish(w, "tool_calls", 3)
			default:
				http.Error(w, "synthetic-private-model-error", http.StatusForbidden)
			}
		})
		f.server.Client().Timeout = 6 * time.Second
		storage := newCloudFileHTTPFixture(t)
		if err := f.service.SetCloudObjectStore(storage.objects); err != nil {
			t.Fatal(err)
		}
		sdk := newCloudSDKFixture(t, f, true)
		run, originalRequest := f.create(t, "local-drill-output-then-failure", "合成验收数据：保留已完成的成果")
		finished := drillWaitRun(t, f, run.ID, func(run *CloudRun) bool { return run.Terminal() })
		if finished.State != CloudRunFailed || rounds.Load() != 3 {
			t.Fatalf("expected failure after two successful tool rounds; state=%s rounds=%d", finished.State, rounds.Load())
		}
		presentation := drillAssertHistory(t, f, finished)
		var output *CloudPresentationResource
		for _, block := range presentation.Blocks {
			if block.Name != "publish_artifact" {
				continue
			}
			if block.State != CloudToolSucceeded || len(block.Resources) != 1 {
				t.Fatal("successful publication lost its durable resource reference")
			}
			copy := block.Resources[0]
			output = &copy
		}
		if output == nil || output.Kind != "artifact" || output.Role != "output" || output.FamilyID == "" || output.Version != 1 {
			t.Fatal("canonical history has no immutable output identity")
		}
		status, body := f.request(t, http.MethodGet, "/api/web-chat/artifacts/versions/"+output.ID+"/download", "synthetic-browser-cookie", "")
		if status != http.StatusOK || body != csv {
			t.Fatal("artifact from the failed run is not downloadable")
		}
		resourceEvent := false
		frames := drillSSE(t, f, run.ID, 1, func(frame drillFrame) bool {
			if frame.Kind != "cloud_run" {
				return false
			}
			var event drillEvent
			drillDecode(t, frame.Data, &event)
			if event.Type == "tool.completed" && event.Data.Name == "publish_artifact" {
				if len(event.Data.Resources) != 1 || event.Data.Resources[0] != *output {
					t.Fatal("SSE receipt disagrees with persisted artifact identity")
				}
				resourceEvent = true
			}
			if strings.Contains(string(frame.Data), "results/drill.csv") || strings.Contains(string(frame.Data), "synthetic-private-model-error") {
				t.Fatal("public stream exposed private arguments or raw failure details")
			}
			return false
		})
		if !resourceEvent {
			t.Fatal("artifact publication is absent from the replayable SSE history")
		}
		status, _ = f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", originalRequest)
		if status != http.StatusOK || rounds.Load() != 3 || sdk.writes.Load() != 1 {
			t.Fatal("replaying a failed run repeated model or filesystem effects")
		}
		for _, path := range []string{"/api/web-chat/runs/" + run.ID, "/api/web-chat/conversations/" + run.ConversationID + "/messages/" + run.AssistantMessageID, "/api/web-chat/artifacts/versions/" + output.ID + "/download"} {
			status, _ := f.request(t, http.MethodGet, path, "synthetic-other-account", "")
			if status != http.StatusNotFound {
				t.Fatal("drill resource escaped its account boundary")
			}
		}
		t.Logf("local-drill-evidence %s", cloudJSON(map[string]any{"scenario": "output-then-failure", "synthetic": true, "run_id": run.ID, "state": finished.State, "replay_frames": frames, "history_blocks": len(presentation.Blocks), "artifact_id": output.ID, "download_verified": true, "model_calls": rounds.Load()}))
	})
}

type drillFrame struct {
	Kind, ID string
	Data     json.RawMessage
}
type drillEvent struct {
	RunID string `json:"run_id"`
	Seq   string `json:"seq"`
	Type  string `json:"type"`
	Data  struct {
		Delta     string                      `json:"delta"`
		Name      string                      `json:"name"`
		Resources []CloudPresentationResource `json:"resources"`
	} `json:"data"`
}

func emitDrillReasoning(w http.ResponseWriter, text string) {
	w.Header().Set("Content-Type", "text/event-stream")
	_, _ = fmt.Fprintf(w, "data: %s\n\n", cloudJSON(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"reasoning_content": text}}}}))
	if flush, ok := w.(http.Flusher); ok {
		flush.Flush()
	}
}

func drillDecode(t *testing.T, raw []byte, result any) {
	t.Helper()
	if err := json.Unmarshal(raw, result); err != nil {
		t.Fatalf("invalid drill API response: %v", err)
	}
}

func drillWaitRun(t *testing.T, f *cloudHTTPFixture, id string, predicate func(*CloudRun) bool) *CloudRun {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		status, raw := f.request(t, http.MethodGet, "/api/web-chat/runs/"+id, "synthetic-browser-cookie", "")
		if status != http.StatusOK {
			t.Fatalf("run read status=%d", status)
		}
		var value struct {
			Run *CloudRun `json:"run"`
		}
		drillDecode(t, []byte(raw), &value)
		if value.Run == nil || value.Run.ID != id {
			t.Fatal("run endpoint returned the wrong identity")
		}
		if predicate(value.Run) {
			return value.Run
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("loopback drill timed out waiting for run endpoint")
	return nil
}

func drillSSE(t *testing.T, f *cloudHTTPFixture, id string, after int64, consume func(drillFrame) bool) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, f.server.URL+"/api/web-chat/runs/"+id+"/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "synthetic-browser-cookie"})
	if after > 0 {
		req.Header.Set("Last-Event-ID", strconv.FormatInt(after, 10))
	}
	response, err := f.server.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		t.Fatal("SSE endpoint did not open an authenticated stream")
	}
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 4096), 2<<20)
	frame := drillFrame{}
	count := 0
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if len(frame.Data) > 0 {
				count++
				if consume(frame) {
					return count
				}
			}
			frame = drillFrame{}
		} else if value, ok := strings.CutPrefix(line, "event: "); ok {
			frame.Kind = value
		} else if value, ok := strings.CutPrefix(line, "id: "); ok {
			frame.ID = value
		} else if value, ok := strings.CutPrefix(line, "data: "); ok {
			frame.Data = append(frame.Data, []byte(value)...)
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("SSE stream stopped unexpectedly: %v", err)
	}
	return count
}

func drillAssertHistory(t *testing.T, f *cloudHTTPFixture, run *CloudRun) CloudPresentation {
	t.Helper()
	status, raw := f.request(t, http.MethodGet, "/api/web-chat/conversations/"+run.ConversationID+"/messages/"+run.AssistantMessageID, "synthetic-browser-cookie", "")
	if status != http.StatusOK {
		t.Fatalf("history message read status=%d", status)
	}
	var result struct {
		Message CloudHistoryMessage `json:"message"`
	}
	drillDecode(t, []byte(raw), &result)
	if result.Message.ID != run.AssistantMessageID || result.Message.PresentationOmitted || result.Message.ContentOmitted {
		t.Fatal("explicit historical message lost its complete body or process")
	}
	var content string
	drillDecode(t, result.Message.Content, &content)
	if content != run.Output {
		t.Fatal("run output differs from canonical historical content")
	}
	var history, current CloudPresentation
	drillDecode(t, result.Message.Presentation, &history)
	drillDecode(t, run.Presentation, &current)
	if string(cloudJSON(history)) != string(cloudJSON(current)) {
		t.Fatal("historical presentation differs from the full run snapshot")
	}
	status, raw = f.request(t, http.MethodGet, "/api/web-chat/conversations/"+run.ConversationID+"/messages?limit=50", "synthetic-browser-cookie", "")
	if status != http.StatusOK {
		t.Fatal("history page unavailable")
	}
	var page CloudHistoryPage
	drillDecode(t, []byte(raw), &page)
	if len(page.Messages) != 2 || page.Messages[1].ID != run.AssistantMessageID || page.Messages[1].PresentationOmitted {
		t.Fatal("bounded history page unexpectedly dropped the small process fixture")
	}
	for _, private := range []string{"synthetic-model-key", "synthetic-browser-cookie", "synthetic-access-token", "synthetic-refresh-token"} {
		if strings.Contains(raw, private) || strings.Contains(string(run.Presentation), private) {
			t.Fatal("private authorization entered visible process history")
		}
	}
	return history
}
