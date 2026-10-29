package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func runCloudRunTurnHeadContract(t *testing.T, f cloudRunTestFixture) {
	t.Helper()
	ctx := context.Background()
	input := cloudRunTestInput(t, f, 181, "", "offline-turn", strings.Repeat("private-input", 200000))
	run, _, err := f.runs.CreateCloudRun(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := f.runs.ClaimCloudRun(ctx, "terminal-head", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.runs.CommitCloudRun(ctx, 181, run.ID, "terminal-head", claimed.Attempt, CloudRunCommit{OperationID: "offline-unknown", Delta: "canonical partial", State: CloudRunInterrupted, ErrorCode: "cloud_cancellation_outcome_unknown"})
	if err != nil {
		t.Fatal(err)
	}
	store := f.store.(cloudRunTurnHeadStore)
	head, err := store.GetCloudRunForUserMessage(ctx, 181, run.ConversationID, run.UserMessageID)
	if err != nil || head.State != CloudRunInterrupted || head.ErrorCode != "cloud_cancellation_outcome_unknown" || head.Output != "" || len(head.RequestContent) != 0 || head.SessionRef != "" {
		t.Fatal("terminal lookup lost fact or loaded message/private bodies")
	}
	original, err := f.runs.GetCloudRun(ctx, 181, run.ID)
	if err != nil || original.Output != "canonical partial" || len(original.RequestContent) < 2<<20 {
		t.Fatal("head read mutated original task")
	}
	if _, err := store.GetCloudRunForUserMessage(ctx, 182, run.ConversationID, run.UserMessageID); !errors.Is(err, ErrNotFound) {
		t.Fatal("foreign account read a terminal task")
	}
	if _, err := store.GetCloudRunForUserMessage(ctx, 181, run.ConversationID, uuid.NewString()); !errors.Is(err, ErrNotFound) {
		t.Fatal("nonexistent turn returned another task")
	}
}

func TestCloudRunTurnHeadMemoryContract(t *testing.T) {
	runCloudRunTurnHeadContract(t, cloudRunMemoryFixture(t))
}
func TestCloudRunTurnHeadPostgresContract(t *testing.T) {
	runCloudRunTurnHeadContract(t, cloudRunPostgresFixture(t))
}

func TestCloudRunTurnHeadHTTP(t *testing.T) {
	f := newCloudHTTPFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("read must not execute a model") })
	input := cloudRunTestInput(t, cloudRunTestFixture{store: f.store}, 1, f.conversation.ID, "offline-status", "synthetic-private")
	run, _, err := f.store.CreateCloudRun(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	base := "/api/web-chat/runs?conversation_id=" + run.ConversationID + "&user_message_id=" + run.UserMessageID
	status, data := f.request(t, http.MethodGet, base, "synthetic-browser-cookie", "")
	var response struct {
		Runs           []map[string]json.RawMessage `json:"runs"`
		OutputIncluded bool                         `json:"output_included"`
	}
	if status != 200 || json.Unmarshal([]byte(data), &response) != nil || len(response.Runs) != 1 || response.OutputIncluded {
		t.Fatalf("head response status=%d data=%s", status, data)
	}
	for _, key := range []string{"output", "request_content", "session_ref", "model_parameters", "public_research", "usage"} {
		if _, ok := response.Runs[0][key]; ok {
			t.Fatalf("head leaked body field %s", key)
		}
	}
	for _, suffix := range []string{"&active=true", "&client_request_id=offline-status"} {
		if status, _ := f.request(t, http.MethodGet, base+suffix, "synthetic-browser-cookie", ""); status != 400 {
			t.Fatal("ambiguous head query accepted")
		}
	}
	if status, _ := f.request(t, http.MethodGet, base, "synthetic-other-account", ""); status != 404 {
		t.Fatal("foreign conversation head was visible")
	}
	if f.calls.Load() != 0 {
		t.Fatal("head read executed a model")
	}
}
