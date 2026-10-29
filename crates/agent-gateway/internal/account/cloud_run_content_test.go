package account

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestCloudRunHTTPContentControlFieldsAreRejectedBeforeAcceptance(t *testing.T) {
	for _, content := range []string{
		`[{"type":"text","text":"hello","prompt_cache_breakpoint":{"mode":"explicit"}}]`,
		`[{"type":"text","text":"hello","cache_control":{"type":"ephemeral"}}]`,
		`[{"type":"image_url","image_url":{"url":"data:image/png;base64,AA=="},"prompt_cache_breakpoint":{}}]`,
		`[{"type":"image_url","image_url":{"url":"data:image/png;base64,AA==","prompt_cache_breakpoint":{}}}]`,
		`[{"type":"image_url","image_url":{"url":"data:image/png;base64,AA==","detail":"unbounded"}}]`,
		`[{"type":"image_url","image_url":{"url":"data:image/png;base64,AA==","detail":true}}]`,
	} {
		t.Run(content, func(t *testing.T) {
			f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("invalid content reached model") })
			input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: uuid.NewString(), Model: "test-model", ProviderKeyID: 41, ModelParameters: CloudRunModelParameters{ProviderCacheMode: "none", ModelCacheMode: "none"}, Content: json.RawMessage(content)}
			status, _ := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
			messages, err := f.store.ListCloudMessages(context.Background(), 1, f.conversation.ID)
			if status != http.StatusBadRequest || f.calls.Load() != 0 || err != nil || len(messages) != 0 {
				t.Fatalf("unsupported content accepted: status=%d calls=%d messages=%d err=%v", status, f.calls.Load(), len(messages), err)
			}
		})
	}
}

func TestCloudRunModelContentProjectionDoesNotForwardStoredCacheControls(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		for _, field := range []string{"prompt_cache_breakpoint", "cache_control", "server_authority"} {
			if strings.Contains(string(body), field) {
				t.Errorf("stored unsupported field %s reached model", field)
			}
		}
		if !strings.Contains(string(body), "retained original text") || !strings.Contains(string(body), `"detail":"low"`) {
			t.Error("content projection dropped supported text/image data")
		}
		emitCloudDelta(w, "safe reply")
		emitModelFinish(w, "stop", 1)
	})
	original := json.RawMessage(`[{"type":"text","text":"retained original text","prompt_cache_breakpoint":{"mode":"explicit"},"server_authority":true},{"type":"image_url","prompt_cache_breakpoint":{"mode":"explicit"},"image_url":{"url":"data:image/png;base64,AA==","detail":"low","cache_control":{}}}]`)
	if err := f.store.AddCloudMessage(context.Background(), &CloudMessage{ID: uuid.NewString(), UserID: 1, ConversationID: f.conversation.ID, Role: "user", Content: original}); err != nil {
		t.Fatal(err)
	}
	input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: uuid.NewString(), Model: "test-model", ProviderKeyID: 41, ModelParameters: CloudRunModelParameters{ProviderCacheMode: "none", ModelCacheMode: "none"}, Content: cloudJSON([]any{map[string]any{"type": "text", "text": "new supported request"}})}
	status, body := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var accepted struct {
		Run *CloudRun `json:"run"`
	}
	if status != http.StatusAccepted || json.Unmarshal([]byte(body), &accepted) != nil || accepted.Run == nil {
		t.Fatal("supported content was rejected")
	}
	finished := f.wait(t, accepted.Run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || f.calls.Load() != 1 {
		t.Fatalf("safe request state=%s code=%s", finished.State, finished.ErrorCode)
	}
	messages, err := f.store.ListCloudMessages(context.Background(), 1, f.conversation.ID)
	if err != nil || string(messages[0].Content) != string(original) {
		t.Fatal("defensive model projection rewrote canonical history")
	}
}
