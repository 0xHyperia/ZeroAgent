package cloudchat_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/account"
)

type browserRecoverySeed struct {
	ConversationID     string `json:"conversation_id"`
	RunID              string `json:"run_id"`
	UserMessageID      string `json:"user_message_id"`
	AssistantMessageID string `json:"assistant_message_id"`
	State              string `json:"state"`
	ErrorCode          string `json:"error_code,omitempty"`
	OutputBytes        int    `json:"output_bytes"`
	OutputSHA256       string `json:"output_sha256"`
}

// Only the explicitly started browser fixture calls this helper. Canonical
// Create/Claim/Cancel/Commit APIs produce the terminal history before a browser
// connects, reproducing offline completion without synthetic production routes.
func seedBrowserRecovery(ctx context.Context, store *account.MemoryStore, uid int64) ([]browserRecoverySeed, error) {
	var seeds []browserRecoverySeed
	cases := []struct {
		title, state, code, output string
		cancelled                  bool
	}{
		{"离线终态：取消结果未确认", account.CloudRunInterrupted, "cloud_cancellation_outcome_unknown", "合成任务的部分答复，远端取消结果尚未确认。", true},
		{"离线终态：零输出失败", account.CloudRunFailed, "synthetic_model_failure", "", false},
		{"离线终态：已停止", account.CloudRunCancelled, "", "合成任务已保存的片段。", true},
		{"离线终态：已完成", account.CloudRunCompleted, "", "合成任务的完整持久答复。", false},
	}
	for i, scenario := range cases {
		now := time.Now().UTC()
		conversationID := fmt.Sprintf("83000000-0000-4000-8000-%012d", i+1)
		if err := store.PutCloudConversation(ctx, &account.CloudConversation{ID: conversationID, UserID: uid, Title: scenario.title, Model: "gpt-5.1", CreatedAt: now, UpdatedAt: now}); err != nil {
			return nil, err
		}
		content, _ := json.Marshal("合成离线任务，仅用于恢复状态验收。")
		digest := sha256.Sum256(content)
		sessionDigest := sha256.Sum256([]byte("test-only-browser-recovery"))
		run, _, err := store.CreateCloudRun(ctx, &account.CloudRun{ConversationID: conversationID, UserID: uid, SessionRef: hex.EncodeToString(sessionDigest[:]), ClientRequestID: uuid.NewString(), RequestHash: hex.EncodeToString(digest[:]), Model: "gpt-5.1", RequestContent: content})
		if err != nil {
			return nil, err
		}
		claimed, err := store.ClaimCloudRun(ctx, "synthetic-recovery-owner", time.Minute)
		if err != nil {
			return nil, err
		}
		if claimed.ID != run.ID {
			return nil, fmt.Errorf("unexpected fixture claim")
		}
		if scenario.cancelled {
			if _, err = store.CancelCloudRun(ctx, uid, run.ID); err != nil {
				return nil, err
			}
		}
		finished, err := store.CommitCloudRun(ctx, uid, run.ID, claimed.LeaseOwner, claimed.Attempt, account.CloudRunCommit{OperationID: "synthetic-terminal", Delta: scenario.output, State: scenario.state, ErrorCode: scenario.code})
		if err != nil {
			return nil, err
		}
		outputDigest := sha256.Sum256([]byte(finished.Output))
		seeds = append(seeds, browserRecoverySeed{conversationID, finished.ID, finished.UserMessageID, finished.AssistantMessageID, finished.State, finished.ErrorCode, len(finished.Output), hex.EncodeToString(outputDigest[:])})
	}
	// More than one real keyset page, all metadata-only. Older timestamps leave
	// the main history/recovery examples immediately visible on the first page.
	for i := range 65 {
		now := time.Now().UTC().Add(-time.Duration(i+1) * time.Hour)
		if err := store.PutCloudConversation(ctx, &account.CloudConversation{ID: fmt.Sprintf("84000000-0000-4000-8000-%012d", i+1), UserID: uid, Title: fmt.Sprintf("分页验收 %03d", i+1), Model: "gpt-5.1", CreatedAt: now, UpdatedAt: now}); err != nil {
			return nil, err
		}
	}
	return seeds, nil
}

func TestBrowserSyntheticOfflineRecoverySeed(t *testing.T) {
	ctx := context.Background()
	store := account.NewMemoryStore()
	seeds, err := seedBrowserRecovery(ctx, store, 700127)
	if err != nil {
		t.Fatal(err)
	}
	if len(seeds) != 4 {
		t.Fatal("missing terminal cases")
	}
	for _, seed := range seeds {
		run, err := store.GetCloudRun(ctx, 700127, seed.RunID)
		if err != nil || !run.Terminal() {
			t.Fatal("seed did not finish through the canonical store")
		}
		messages, err := store.ListCloudMessages(ctx, 700127, seed.ConversationID)
		if err != nil {
			t.Fatal(err)
		}
		expected := 2
		if seed.OutputBytes == 0 {
			expected = 1
		}
		if len(messages) != expected || messages[0].ID != seed.UserMessageID {
			t.Fatal("terminal canonical history mismatch")
		}
		active, err := store.ListCloudRunViews(ctx, 700127, seed.ConversationID, true, "")
		if err != nil || len(active) != 0 {
			t.Fatal("offline seed unexpectedly needs execution")
		}
		head, err := store.GetCloudRunForUserMessage(ctx, 700127, seed.ConversationID, seed.UserMessageID)
		if err != nil || head.State != seed.State || head.Output != "" || len(head.RequestContent) != 0 {
			t.Fatal("precise head did not stay metadata-only")
		}
	}
	page, err := store.ListCloudConversationPage(ctx, 700127, "", 51)
	if err != nil || len(page) != 51 {
		t.Fatal("metadata page does not require load more")
	}
	status, _ := json.Marshal(seeds)
	if len(status) > 4096 {
		t.Fatal("fixture status should contain only bounded IDs, counts and hashes")
	}
}
