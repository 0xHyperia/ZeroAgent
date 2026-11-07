package account

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

type cloudRunTestFixture struct {
	store     Store
	runs      CloudRunStore
	expire    func(string)
	setOutput func(string, string)
}

func cloudRunMemoryFixture(t *testing.T) cloudRunTestFixture {
	t.Helper()
	store := NewMemoryStore()
	var clock atomic.Int64
	clock.Store(time.Now().UTC().UnixNano())
	store.now = func() time.Time { return time.Unix(0, clock.Load()).UTC() }
	return cloudRunTestFixture{store: store, runs: store, expire: func(id string) { clock.Add(int64(10 * time.Minute)) }, setOutput: func(id, output string) {
		store.mu.Lock()
		defer store.mu.Unlock()
		run := store.cloudRuns.runs[id]
		run.Output = output
		store.cloudRuns.runs[id] = run
	}}
}

// The integration test accepts only an explicit loopback test DSN. It creates a
// fresh random schema and drops only that schema, never using DATABASE_URL or
// the application's deployed tables and Redis sessions.
func cloudRunPostgresFixture(t *testing.T) cloudRunTestFixture {
	t.Helper()
	dsn := os.Getenv("ZEROAGENT_CLOUD_RUN_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set ZEROAGENT_CLOUD_RUN_TEST_DATABASE_URL for isolated PostgreSQL contract verification")
	}
	parsed, err := url.Parse(dsn)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") ||
		(parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" && parsed.Hostname() != "::1") {
		t.Fatal("cloud run integration DSN must identify an explicit loopback PostgreSQL test service")
	}
	admin, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal("open test PostgreSQL")
	}
	t.Cleanup(func() { _ = admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	schema := "zeroagent_cloud_run_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = admin.ExecContext(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("create isolated cloud run schema: %v", err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.ExecContext(ctx, "DROP SCHEMA "+schema+" CASCADE"); err != nil {
			t.Errorf("remove isolated cloud run schema: %v", err)
		}
	})
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	db, err := sql.Open("postgres", parsed.String())
	if err != nil {
		t.Fatal("open isolated schema")
	}
	db.SetMaxOpenConns(10)
	t.Cleanup(func() { _ = db.Close() })
	const existingCloudSchema = `CREATE TABLE zerobox_cloud_conversations (
id UUID PRIMARY KEY,user_id BIGINT NOT NULL,title TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',
created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE TABLE zerobox_cloud_messages (id UUID PRIMARY KEY,conversation_id UUID NOT NULL REFERENCES zerobox_cloud_conversations(id) ON DELETE CASCADE,
user_id BIGINT NOT NULL,role TEXT NOT NULL,content JSONB NOT NULL,usage JSONB NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`
	if _, err = db.ExecContext(ctx, existingCloudSchema+CloudRunSchema+CloudFileSchema+CloudArtifactSchema+CloudSiteSchema+CloudSpaceSchema+CloudExtensionsSchema); err != nil {
		t.Fatalf("create test cloud schema: %v", err)
	}
	store := &PersistentStore{db: db}
	return cloudRunTestFixture{store: store, runs: store, expire: func(id string) {
		if _, err := db.Exec(`UPDATE zeroagent_cloud_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1`, id); err != nil {
			t.Fatal(err)
		}
	}, setOutput: func(id, output string) {
		if _, err := db.Exec(`UPDATE zeroagent_cloud_runs SET output=$2 WHERE id=$1`, id, output); err != nil {
			t.Fatal(err)
		}
	}}
}

func cloudRunTestInput(t *testing.T, fixture cloudRunTestFixture, userID int64, conversationID, requestID, text string) *CloudRun {
	t.Helper()
	if conversationID == "" {
		conversationID = uuid.NewString()
		if err := fixture.store.PutCloudConversation(context.Background(), &CloudConversation{ID: conversationID, UserID: userID, Title: "新对话", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}); err != nil {
			t.Fatal(err)
		}
	}
	content, _ := json.Marshal(text)
	hash := sha256.Sum256(append([]byte(conversationID+"/model/"), content...))
	sessionHash := sha256.Sum256([]byte("server-session-private-" + uuid.NewString()))
	return &CloudRun{ConversationID: conversationID, UserID: userID, SessionRef: hex.EncodeToString(sessionHash[:]),
		ClientRequestID: requestID, RequestHash: hex.EncodeToString(hash[:]), Model: "test-model", RequestContent: content}
}

func TestCloudRunMemoryContract(t *testing.T)   { runCloudRunContract(t, cloudRunMemoryFixture) }
func TestCloudRunPostgresContract(t *testing.T) { runCloudRunContract(t, cloudRunPostgresFixture) }

func runCloudRunContract(t *testing.T, newFixture func(*testing.T) cloudRunTestFixture) {
	t.Run("concurrent request replay accepts exactly one history write", func(t *testing.T) {
		f := newFixture(t)
		ctx := context.Background()
		input := cloudRunTestInput(t, f, 11, "", "concurrent-request", "one accepted input")
		var createdCount atomic.Int64
		var firstID string
		var resultMu sync.Mutex
		var group sync.WaitGroup
		for range 8 {
			group.Add(1)
			go func() {
				defer group.Done()
				run, created, err := f.runs.CreateCloudRun(ctx, input)
				if err != nil {
					t.Errorf("concurrent request: %v", err)
					return
				}
				if created {
					createdCount.Add(1)
				}
				resultMu.Lock()
				defer resultMu.Unlock()
				if firstID == "" {
					firstID = run.ID
				} else if firstID != run.ID {
					t.Error("same request returned a second run identity")
				}
			}()
		}
		group.Wait()
		if createdCount.Load() != 1 {
			t.Fatalf("accepted writes: %d", createdCount.Load())
		}
		messages, err := f.store.ListCloudMessages(ctx, 11, input.ConversationID)
		if err != nil || len(messages) != 1 {
			t.Fatalf("concurrent history writes: %d %v", len(messages), err)
		}
		other := cloudRunTestInput(t, f, 11, "", input.ClientRequestID, "another conversation")
		if _, _, err := f.runs.CreateCloudRun(ctx, other); !errors.Is(err, ErrCloudRunConflict) {
			t.Fatalf("request reused for another conversation: %v", err)
		}
		if rows, err := f.store.ListCloudMessages(ctx, 11, other.ConversationID); err != nil || len(rows) != 0 {
			t.Fatalf("conflicting transaction left input history: %d %v", len(rows), err)
		}
	})
	t.Run("atomic acceptance ownership and request deduplication", func(t *testing.T) {
		f := newFixture(t)
		ctx := context.Background()
		input := cloudRunTestInput(t, f, 11, "", "request-1", "测试新会话标题")
		run, created, err := f.runs.CreateCloudRun(ctx, input)
		if err != nil || !created {
			t.Fatalf("create: created=%v err=%v", created, err)
		}
		if run.State != CloudRunQueued || run.LastSeq != 1 || run.UserMessageID == "" || run.AssistantMessageID == "" {
			t.Fatalf("invalid queued projection: %+v", run)
		}
		if alternate, err := f.runs.GetCloudRun(ctx, 11, "urn:uuid:"+strings.ToUpper(run.ID)); err != nil || alternate.ID != run.ID {
			t.Fatalf("equivalent UUID lookup: %+v %v", alternate, err)
		}
		duplicate, created, err := f.runs.CreateCloudRun(ctx, input)
		if err != nil || created || duplicate.ID != run.ID {
			t.Fatalf("duplicate: %v %v", created, err)
		}
		messages, err := f.store.ListCloudMessages(ctx, 11, input.ConversationID)
		if err != nil || len(messages) != 1 {
			t.Fatalf("duplicate wrote history: count=%d err=%v", len(messages), err)
		}
		conversation, err := f.store.GetCloudConversation(ctx, 11, input.ConversationID)
		if err != nil || conversation.Title != "测试新会话标题" || conversation.Model != input.Model {
			t.Fatalf("conversation update: %+v %v", conversation, err)
		}
		changed := cloudRunTestInput(t, f, 11, input.ConversationID, input.ClientRequestID, "different")
		if _, _, err = f.runs.CreateCloudRun(ctx, changed); !errors.Is(err, ErrCloudRunConflict) {
			t.Fatalf("changed duplicate: %v", err)
		}
		busy := cloudRunTestInput(t, f, 11, input.ConversationID, "request-2", "second")
		if _, _, err = f.runs.CreateCloudRun(ctx, busy); !errors.Is(err, ErrCloudRunBusy) {
			t.Fatalf("active conversation: %v", err)
		}
		forged := cloudRunTestInput(t, f, 22, input.ConversationID, "request-3", "foreign")
		if _, _, err = f.runs.CreateCloudRun(ctx, forged); !errors.Is(err, ErrNotFound) {
			t.Fatalf("foreign create: %v", err)
		}
		if _, err = f.runs.GetCloudRun(ctx, 22, run.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("foreign get: %v", err)
		}
		if _, err = f.runs.ListCloudRuns(ctx, 22, input.ConversationID, false); !errors.Is(err, ErrNotFound) {
			t.Fatalf("foreign list: %v", err)
		}
		if _, err = f.runs.CancelCloudRun(ctx, 22, run.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("foreign cancel: %v", err)
		}
		if _, err = f.runs.ListCloudRunEvents(ctx, 22, run.ID, 0, 100); !errors.Is(err, ErrNotFound) {
			t.Fatalf("foreign events: %v", err)
		}
		encoded, _ := json.Marshal(run)
		for _, secret := range []string{input.SessionRef, input.RequestHash, "lease_owner", "request_content", "user_id"} {
			if strings.Contains(string(encoded), secret) {
				t.Fatalf("private run field serialized: %s", secret)
			}
		}
		if !strings.Contains(string(encoded), `"last_seq":"1"`) {
			t.Fatalf("cursor must be decimal string: %s", encoded)
		}
	})
	t.Run("exclusive claim and fenced idempotent commits", func(t *testing.T) {
		f := newFixture(t)
		ctx := context.Background()
		input := cloudRunTestInput(t, f, 11, "", "once", "hi")
		run, _, err := f.runs.CreateCloudRun(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		var claimed atomic.Int64
		var mu sync.Mutex
		var winner *CloudRun
		var group sync.WaitGroup
		for range 8 {
			group.Add(1)
			go func() {
				defer group.Done()
				candidate, err := f.runs.ClaimCloudRun(ctx, uuid.NewString(), time.Minute)
				if err == nil {
					claimed.Add(1)
					mu.Lock()
					winner = candidate
					mu.Unlock()
				} else if !errors.Is(err, ErrNotFound) {
					t.Errorf("claim error: %v", err)
				}
			}()
		}
		group.Wait()
		if claimed.Load() != 1 || winner == nil {
			t.Fatalf("claim count: %d", claimed.Load())
		}
		if winner.Attempt != 1 || winner.ID != run.ID {
			t.Fatalf("claim fence: %+v", winner)
		}
		commit := CloudRunCommit{OperationID: "delta-1", Delta: "你好", EventType: "message.delta", Payload: json.RawMessage(`{"delta":"你好"}`)}
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, "wrong-owner", 1, commit); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatalf("wrong owner: %v", err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, winner.LeaseOwner, 2, commit); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatalf("wrong attempt: %v", err)
		}
		updated, err := f.runs.CommitCloudRun(ctx, 11, run.ID, winner.LeaseOwner, 1, commit)
		if err != nil || updated.Output != "你好" || updated.LastSeq != 3 {
			t.Fatalf("delta: %+v %v", updated, err)
		}
		again, err := f.runs.CommitCloudRun(ctx, 11, "urn:uuid:"+strings.ToUpper(run.ID), winner.LeaseOwner, 1, commit)
		if err != nil || again.Output != "你好" || again.LastSeq != 3 {
			t.Fatalf("duplicate delta: %+v %v", again, err)
		}
		conflict := commit
		conflict.Delta = "different"
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, winner.LeaseOwner, 1, conflict); !errors.Is(err, ErrCloudRunConflict) {
			t.Fatalf("operation payload conflict: %v", err)
		}
		finish := CloudRunCommit{OperationID: "finish", Delta: "世界", State: CloudRunCompleted, Usage: json.RawMessage(`{"total_tokens":7}`)}
		completed, err := f.runs.CommitCloudRun(ctx, 11, run.ID, winner.LeaseOwner, 1, finish)
		if err != nil || !completed.Terminal() || completed.Output != "你好世界" {
			t.Fatalf("finish: %+v %v", completed, err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, winner.LeaseOwner, 1, finish); err != nil {
			t.Fatalf("uncertain finish replay: %v", err)
		}
		finish.OperationID = "finish-again"
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, winner.LeaseOwner, 1, finish); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatalf("terminal mutation: %v", err)
		}
		messages, err := f.store.ListCloudMessages(ctx, 11, input.ConversationID)
		if err != nil || len(messages) != 2 || messages[1].Role != "assistant" || string(messages[1].Content) != `"你好世界"` {
			t.Fatalf("canonical history: %+v %v", messages, err)
		}
		events, err := f.runs.ListCloudRunEvents(ctx, 11, run.ID, 2, 1)
		if err != nil || len(events) != 1 || events[0].Seq != 3 || events[0].Type != "message.delta" {
			t.Fatalf("bounded replay: %+v %v", events, err)
		}
		events[0].Payload[0] = 'x'
		replay, err := f.runs.ListCloudRunEvents(ctx, 11, run.ID, 2, 1)
		if err != nil || !json.Valid(replay[0].Payload) {
			t.Fatalf("event alias corrupted: %+v %v", replay, err)
		}
		active, err := f.runs.ListCloudRuns(ctx, 11, input.ConversationID, true)
		if err != nil || len(active) != 0 {
			t.Fatalf("active terminal: %+v %v", active, err)
		}
		all, err := f.runs.ListCloudRuns(ctx, 11, input.ConversationID, false)
		if err != nil || len(all) != 1 {
			t.Fatalf("history runs: %+v %v", all, err)
		}
	})
	t.Run("cancel dominates generation and queued cancellation is final", func(t *testing.T) {
		f := newFixture(t)
		ctx := context.Background()
		input := cloudRunTestInput(t, f, 11, "", "queued-cancel", "hi")
		run, _, err := f.runs.CreateCloudRun(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		cancelled, err := f.runs.CancelCloudRun(ctx, 11, run.ID)
		if err != nil || cancelled.State != CloudRunCancelled {
			t.Fatalf("queued cancel: %+v %v", cancelled, err)
		}
		if _, err = f.runs.ClaimCloudRun(ctx, "worker", time.Minute); !errors.Is(err, ErrNotFound) {
			t.Fatalf("cancelled run reclaimed: %v", err)
		}
		input = cloudRunTestInput(t, f, 11, input.ConversationID, "running-cancel", "again")
		run, _, err = f.runs.CreateCloudRun(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		run, err = f.runs.ClaimCloudRun(ctx, "worker", time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, "worker", run.Attempt, CloudRunCommit{OperationID: "partial", Delta: "partial"}); err != nil {
			t.Fatal(err)
		}
		cancelling, err := f.runs.CancelCloudRun(ctx, 11, run.ID)
		if err != nil || cancelling.State != CloudRunCancelling {
			t.Fatalf("running cancel: %+v %v", cancelling, err)
		}
		ack, err := f.runs.RenewCloudRunLease(ctx, 11, run.ID, "worker", run.Attempt, time.Minute)
		if err != nil || ack.State != CloudRunCancelling {
			t.Fatalf("cancel observation: %+v %v", ack, err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, "worker", run.Attempt, CloudRunCommit{OperationID: "late", Delta: "unsafe"}); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatalf("late delta after cancel: %v", err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, "worker", run.Attempt, CloudRunCommit{OperationID: "late-finish", State: CloudRunCompleted}); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatalf("completion overrode cancellation: %v", err)
		}
		ended, err := f.runs.CommitCloudRun(ctx, 11, run.ID, "worker", run.Attempt, CloudRunCommit{OperationID: "cancelled", State: CloudRunCancelled})
		if err != nil || ended.State != CloudRunCancelled {
			t.Fatalf("cancel confirmation: %+v %v", ended, err)
		}
		again, err := f.runs.CancelCloudRun(ctx, 11, run.ID)
		if err != nil || again.LastSeq != ended.LastSeq {
			t.Fatalf("duplicate cancel wrote event: %+v %v", again, err)
		}
	})
	t.Run("expired execution preserves partial history without resubmission", func(t *testing.T) {
		f := newFixture(t)
		ctx := context.Background()
		input := cloudRunTestInput(t, f, 11, "", "expire", "hi")
		run, _, err := f.runs.CreateCloudRun(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		run, err = f.runs.ClaimCloudRun(ctx, "worker", time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, "worker", run.Attempt, CloudRunCommit{OperationID: "partial", Delta: "saved fragment"}); err != nil {
			t.Fatal(err)
		}
		f.expire(run.ID)
		if _, err = f.runs.RenewCloudRunLease(ctx, 11, run.ID, "worker", run.Attempt, time.Minute); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatalf("expired lease revived: %v", err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, "worker", run.Attempt, CloudRunCommit{OperationID: "late", Delta: "duplicate"}); !errors.Is(err, ErrCloudRunLeaseLost) {
			t.Fatalf("expired execution wrote: %v", err)
		}
		count, err := f.runs.InterruptExpiredCloudRuns(ctx)
		if err != nil || count != 1 {
			t.Fatalf("recovery: %d %v", count, err)
		}
		count, err = f.runs.InterruptExpiredCloudRuns(ctx)
		if err != nil || count != 0 {
			t.Fatalf("repeated recovery: %d %v", count, err)
		}
		ended, err := f.runs.GetCloudRun(ctx, 11, run.ID)
		if err != nil || ended.State != CloudRunInterrupted || ended.Output != "saved fragment" || ended.ErrorCode != "lease_expired" {
			t.Fatalf("interrupted projection: %+v %v", ended, err)
		}
		if _, err = f.runs.ClaimCloudRun(ctx, "replacement", time.Minute); !errors.Is(err, ErrNotFound) {
			t.Fatalf("interrupted run resent: %v", err)
		}
		messages, err := f.store.ListCloudMessages(ctx, 11, input.ConversationID)
		if err != nil || len(messages) != 2 || string(messages[1].Content) != `"saved fragment"` {
			t.Fatalf("lost partial history: %+v %v", messages, err)
		}
	})
	t.Run("deleted history is inaccessible and no longer executable", func(t *testing.T) {
		f := newFixture(t)
		ctx := context.Background()
		input := cloudRunTestInput(t, f, 11, "", "delete", "hi")
		run, _, err := f.runs.CreateCloudRun(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		if err = f.store.DeleteCloudConversation(ctx, 11, input.ConversationID); err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.GetCloudRun(ctx, 11, run.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("deleted run visible: %v", err)
		}
		if _, err = f.runs.ListCloudRunEvents(ctx, 11, run.ID, 0, 10); !errors.Is(err, ErrNotFound) {
			t.Fatalf("deleted output replayed: %v", err)
		}
		if _, err = f.runs.ClaimCloudRun(ctx, "worker", time.Minute); !errors.Is(err, ErrNotFound) {
			t.Fatalf("deleted run executed: %v", err)
		}
	})
	t.Run("invalid operations and output limits do not mutate state", func(t *testing.T) {
		f := newFixture(t)
		ctx := context.Background()
		input := cloudRunTestInput(t, f, 11, "", "limit", "hi")
		invalid := *input
		invalid.RequestContent = json.RawMessage(`{`)
		if _, _, err := f.runs.CreateCloudRun(ctx, &invalid); !errors.Is(err, ErrCloudRunInvalid) {
			t.Fatalf("invalid content: %v", err)
		}
		run, _, err := f.runs.CreateCloudRun(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.GetCloudRun(ctx, 11, "not-a-uuid"); !errors.Is(err, ErrNotFound) {
			t.Fatalf("malformed resource identifier: %v", err)
		}
		if _, err = f.runs.ClaimCloudRun(ctx, "worker", 0); !errors.Is(err, ErrCloudRunInvalid) {
			t.Fatalf("unbounded lease: %v", err)
		}
		run, err = f.runs.ClaimCloudRun(ctx, "worker", time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, "worker", run.Attempt, CloudRunCommit{OperationID: "large-event", Delta: strings.Repeat("x", CloudRunMaxEventBytes+1)}); !errors.Is(err, ErrCloudRunLimit) {
			t.Fatalf("large event: %v", err)
		}
		f.setOutput(run.ID, strings.Repeat("x", CloudRunMaxOutputBytes))
		if _, err = f.runs.CommitCloudRun(ctx, 11, run.ID, "worker", run.Attempt, CloudRunCommit{OperationID: "overflow", Delta: "x"}); !errors.Is(err, ErrCloudRunLimit) {
			t.Fatalf("output bound: %v", err)
		}
		events, err := f.runs.ListCloudRunEvents(ctx, 11, run.ID, 0, 100)
		if err != nil || len(events) != 2 {
			t.Fatalf("rejected writes changed event log: %d %v", len(events), err)
		}
	})
}
