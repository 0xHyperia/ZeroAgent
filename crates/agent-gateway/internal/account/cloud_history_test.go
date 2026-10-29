package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

func historyConversation(t *testing.T, f cloudRunTestFixture, uid int64) string {
	t.Helper()
	id := uuid.NewString()
	now := time.Now().UTC()
	if err := f.store.PutCloudConversation(context.Background(), &CloudConversation{ID: id, UserID: uid, Title: "历史测试", Model: "fixture", CreatedAt: now, UpdatedAt: now}); err != nil {
		t.Fatal(err)
	}
	return id
}
func historyMessage(t *testing.T, store Store, uid int64, conversationID, text string, at time.Time) CloudMessage {
	t.Helper()
	message := CloudMessage{ID: uuid.NewString(), ConversationID: conversationID, UserID: uid, Role: "user", Content: cloudJSON(text), CreatedAt: at}
	if err := store.AddCloudMessage(context.Background(), &message); err != nil {
		t.Fatal(err)
	}
	return message
}

// Seed preserved pre-existing rows with their original timestamps, including
// ambiguous ties. New append paths deliberately do not guess or rewrite them.
func historyExistingMessage(t *testing.T, store Store, uid int64, cid, text string, at time.Time) CloudMessage {
	t.Helper()
	message := CloudMessage{ID: uuid.NewString(), ConversationID: cid, UserID: uid, Role: "user", Content: cloudJSON(text), CreatedAt: at}
	switch target := store.(type) {
	case *MemoryStore:
		target.mu.Lock()
		target.cloudMessages[cid] = append(target.cloudMessages[cid], cloneCloudMessage(message))
		target.mu.Unlock()
	case *PersistentStore:
		if _, err := target.db.Exec(`INSERT INTO zerobox_cloud_messages(id,conversation_id,user_id,role,content,created_at) VALUES($1,$2,$3,$4,$5,$6)`, message.ID, cid, uid, message.Role, []byte(message.Content), at); err != nil {
			t.Fatal(err)
		}
	default:
		t.Fatal("unsupported fixture")
	}
	return message
}

func TestCloudHistoryMemoryContract(t *testing.T) { runCloudHistoryContract(t, cloudRunMemoryFixture) }
func TestCloudHistoryPostgresContract(t *testing.T) {
	runCloudHistoryContract(t, cloudRunPostgresFixture)
}
func runCloudHistoryContract(t *testing.T, factory func(*testing.T) cloudRunTestFixture) {
	t.Run("stable scoped older pages and immutable size hash", func(t *testing.T) {
		f := factory(t)
		store := f.store.(CloudHistoryStore)
		ctx := context.Background()
		conversation := historyConversation(t, f, 7)
		at := time.Now().UTC().Truncate(time.Microsecond)
		messages := []CloudMessage{}
		for i := 0; i < 9; i++ {
			messages = append(messages, historyExistingMessage(t, f.store, 7, conversation, fmt.Sprint(i), at))
		}
		sort.Slice(messages, func(i, j int) bool { return messages[i].ID < messages[j].ID })
		page, err := store.ListCloudMessageHeads(ctx, 7, conversation, "", 3)
		if err != nil || len(page.Items) != 3 || !page.HasMore || page.Items[0].ID != messages[6].ID {
			t.Fatalf("unstable newest page: %v", err)
		}
		historyMessage(t, f.store, 7, conversation, "new append", at.Add(time.Second))
		older, err := store.ListCloudMessageHeads(ctx, 7, conversation, page.NextBeforeID, 3)
		if err != nil || len(older.Items) != 3 || older.Items[0].ID != messages[3].ID || older.Items[2].ID != messages[5].ID {
			t.Fatal("append changed an existing older cursor boundary")
		}
		full, err := store.GetCloudHistoryMessages(ctx, 7, conversation, []string{messages[5].ID}, 1024)
		if err != nil || len(full) != 1 {
			t.Fatal(err)
		}
		digest := sha256.Sum256(full[0].Content)
		if full[0].ContentSHA256 != hex.EncodeToString(digest[:]) || full[0].ContentBytes != int64(len(full[0].Content)) {
			t.Fatal("head did not describe the exact returned JSON bytes")
		}
		foreign := historyConversation(t, f, 7)
		cursor := historyMessage(t, f.store, 7, foreign, "foreign cursor", at)
		if _, err = store.ListCloudMessageHeads(ctx, 7, conversation, cursor.ID, 3); !errors.Is(err, ErrNotFound) {
			t.Fatal("cursor crossed conversation scope")
		}
		if _, err = store.GetCloudHistoryMessages(ctx, 8, conversation, []string{messages[0].ID}, 1024); !errors.Is(err, ErrNotFound) {
			t.Fatal("body crossed account scope")
		}
		if _, err = store.ReadCloudHistoryFragment(ctx, 8, conversation, messages[0].ID, 0, 64); !errors.Is(err, ErrNotFound) {
			t.Fatal("fragment crossed account scope")
		}
		if err = f.store.DeleteCloudConversation(ctx, 7, conversation); err != nil {
			t.Fatal(err)
		}
		if _, err = store.ListCloudMessageHeads(ctx, 7, conversation, page.NextBeforeID, 3); !errors.Is(err, ErrNotFound) {
			t.Fatal("deleted cursor remained usable")
		}
	})
	t.Run("large bodies are omitted before bounded body query and fragments are explicit", func(t *testing.T) {
		f := factory(t)
		store := f.store.(CloudHistoryStore)
		ctx := context.Background()
		conversation := historyConversation(t, f, 7)
		at := time.Now().UTC()
		large := historyMessage(t, f.store, 7, conversation, "唯一大正文"+strings.Repeat("字", 1<<20), at)
		historyMessage(t, f.store, 7, conversation, "new small message", at.Add(time.Second))
		service := NewService(f.store, nil, time.Hour, time.Hour)
		page, err := service.CloudHistoryPage(ctx, 7, conversation, "", 50)
		if err != nil || len(page.Messages) != 2 {
			t.Fatal(err)
		}
		if !page.Messages[0].ContentOmitted || len(page.Messages[0].Content) != 0 || page.Messages[0].ContentBytes < 3<<20 || page.Messages[1].ContentOmitted {
			t.Fatal("oversized message was fetched, silently cropped, or presented as an empty answer")
		}
		fragment, err := store.ReadCloudHistoryFragment(ctx, 7, conversation, large.ID, 7, 1024)
		if err != nil || fragment.Complete || !fragment.HasMore || fragment.Encoding != "json_utf8_excerpt" || !utf8.ValidString(fragment.Excerpt) || len(fragment.Excerpt) > 1024 || len(fragment.Content) != 0 {
			t.Fatal("partial history claimed a whole message or split UTF-8")
		}
		if fragment.NextOffsetBytes <= fragment.OffsetBytes {
			t.Fatal("fragment cursor made no progress")
		}
		full, err := service.CloudHistoryMessage(ctx, 7, conversation, large.ID)
		if err != nil || full.ContentOmitted || len(full.Content) == 0 {
			t.Fatal("explicit bounded original read lost preserved history")
		}
	})
	t.Run("branch uses only its canonical copied prefix", func(t *testing.T) {
		f := factory(t)
		if persistent, ok := f.store.(*PersistentStore); ok {
			if _, err := persistent.db.Exec(CloudFileSchema + CloudProjectSchema + CloudBranchSchema); err != nil {
				t.Fatal(err)
			}
		}
		conversation := historyConversation(t, f, 7)
		at := time.Now().UTC()
		first := historyMessage(t, f.store, 7, conversation, "first", at)
		anchor := historyMessage(t, f.store, 7, conversation, "anchor", at.Add(time.Second))
		historyMessage(t, f.store, 7, conversation, "future must stay out", at.Add(2*time.Second))
		branch, _, err := f.store.(CloudBranchStore).CreateCloudBranch(context.Background(), 7, conversation, CloudBranchInput{ClientRequestID: "history-branch", MessageID: anchor.ID, Action: "fork"})
		if err != nil {
			t.Fatal(err)
		}
		store := f.store.(CloudHistoryStore)
		heads, err := store.ListCloudMessageHeads(context.Background(), 7, branch.Conversation.ID, "", 100)
		if err != nil || len(heads.Items) != 2 {
			t.Fatal("branch history did not retain the exact prefix")
		}
		ids := []string{}
		for _, head := range heads.Items {
			ids = append(ids, head.ID)
		}
		messages, err := store.GetCloudHistoryMessages(context.Background(), 7, branch.Conversation.ID, ids, 1024)
		if err != nil || string(messages[0].Content) != string(first.Content) || strings.Contains(string(cloudJSON(messages)), "future must stay out") {
			t.Fatal("branch exposed a future source message")
		}
		if _, err = store.GetCloudHistoryMessages(context.Background(), 7, branch.Conversation.ID, []string{anchor.ID}, 1024); !errors.Is(err, ErrNotFound) {
			t.Fatal("source message ID accessed through a new branch")
		}
	})
	t.Run("new canonical appends survive frozen or backward wall clocks", func(t *testing.T) {
		f := factory(t)
		ctx := context.Background()
		conversation := historyConversation(t, f, 7)
		originalAt := time.Now().UTC().Add(time.Hour).Truncate(time.Microsecond)
		original := historyExistingMessage(t, f.store, 7, conversation, "original untouched", originalAt)
		if memory, ok := f.store.(*MemoryStore); ok {
			memory.now = func() time.Time { return originalAt.Add(-time.Hour) }
		}
		input := cloudRunTestInput(t, f, 7, conversation, "monotonic-first", "new user")
		accepted, _, err := f.runs.CreateCloudRun(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
		claimed, err := f.runs.ClaimCloudRun(ctx, "chronology-worker", time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.CommitCloudRun(ctx, 7, claimed.ID, claimed.LeaseOwner, claimed.Attempt, CloudRunCommit{OperationID: "finish-monotonic", Delta: "assistant", State: CloudRunCompleted}); err != nil {
			t.Fatal(err)
		}
		historyMessage(t, f.store, 7, conversation, "append after frozen clock", originalAt.Add(-24*time.Hour))
		input = cloudRunTestInput(t, f, 7, conversation, "monotonic-second", "next user")
		if _, _, err = f.runs.CreateCloudRun(ctx, input); err != nil {
			t.Fatal(err)
		}
		store := f.store.(CloudHistoryStore)
		heads, err := store.ListCloudMessageHeads(ctx, 7, conversation, "", 100)
		if err != nil || len(heads.Items) != 5 {
			t.Fatal(err)
		}
		if heads.Items[0].ID != original.ID || !heads.Items[0].CreatedAt.Equal(originalAt) || heads.Items[1].ID != accepted.UserMessageID || heads.Items[2].Role != "assistant" {
			t.Fatal("new writes reordered or rewrote existing canonical messages")
		}
		for index := 1; index < len(heads.Items); index++ {
			if heads.Items[index].CreatedAt.Sub(heads.Items[index-1].CreatedAt) < time.Microsecond {
				t.Fatal("new message did not advance the conversation order")
			}
		}
		service := NewService(f.store, nil, time.Hour, time.Hour)
		messages, _, err := service.cloudModelHistory(ctx, claimed, claimed.ModelParameters)
		if err != nil || len(messages) != 2 || messages[0].ID != original.ID || messages[1].ID != accepted.UserMessageID {
			t.Fatal("model prefix used wall clock instead of its actual user-message boundary")
		}
	})
	t.Run("concurrent new appends serialize per conversation", func(t *testing.T) {
		f := factory(t)
		conversation := historyConversation(t, f, 7)
		var wg sync.WaitGroup
		for index := 0; index < 24; index++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				message := &CloudMessage{ID: uuid.NewString(), ConversationID: conversation, UserID: 7, Role: "user", Content: cloudJSON("parallel"), CreatedAt: time.Time{}}
				if err := f.store.AddCloudMessage(context.Background(), message); err != nil {
					t.Error(err)
				}
			}()
		}
		wg.Wait()
		heads, err := f.store.(CloudHistoryStore).ListCloudMessageHeads(context.Background(), 7, conversation, "", 100)
		if err != nil || len(heads.Items) != 24 {
			t.Fatal(err)
		}
		for index := 1; index < len(heads.Items); index++ {
			if heads.Items[index].CreatedAt.Sub(heads.Items[index-1].CreatedAt) < time.Microsecond {
				t.Fatal("concurrent append did not hold conversation ordering lock")
			}
		}
	})
}

type tracedCloudHistoryStore struct {
	*MemoryStore
	legacyReads     atomic.Int32
	maxBodyBytes    atomic.Int64
	removeAfterRead string
}

func (s *tracedCloudHistoryStore) ListCloudMessages(context.Context, int64, string) ([]CloudMessage, error) {
	s.legacyReads.Add(1)
	return nil, ErrCloudRunLimit
}
func (s *tracedCloudHistoryStore) GetCloudHistoryMessages(ctx context.Context, uid int64, cid string, ids []string, max int64) ([]CloudHistoryMessage, error) {
	items, err := s.MemoryStore.GetCloudHistoryMessages(ctx, uid, cid, ids, max)
	var total int64
	for _, item := range items {
		total += int64(len(item.Content) + len(item.Usage))
	}
	for old := s.maxBodyBytes.Load(); total > old; old = s.maxBodyBytes.Load() {
		if s.maxBodyBytes.CompareAndSwap(old, total) {
			break
		}
	}
	return items, err
}
func (s *tracedCloudHistoryStore) ReadCloudHistoryFragment(ctx context.Context, uid int64, cid, id string, offset, limit int64) (*CloudHistoryExcerpt, error) {
	fragment, err := s.MemoryStore.ReadCloudHistoryFragment(ctx, uid, cid, id, offset, limit)
	if err == nil && id == s.removeAfterRead {
		s.mu.Lock()
		items := s.cloudMessages[cid]
		for index, item := range items {
			if item.ID == id {
				s.cloudMessages[cid] = append(items[:index], items[index+1:]...)
				break
			}
		}
		s.mu.Unlock()
	}
	return fragment, err
}

func TestCloudHistoryHTTPAndModelNeverUseWholeConversationBodyReader(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		_ = json.NewDecoder(r.Body).Decode(&request)
		messages := string(cloudJSON(request["messages"]))
		if !strings.Contains(messages, "未被摘要") && !strings.Contains(messages, "未被总结") {
			t.Error("bounded selection silently looked like complete history")
		}
		emitCloudDelta(w, "只根据提供内容回答")
		emitModelFinish(w, "stop", 1)
	})
	for index := 0; index < 90; index++ {
		historyMessage(t, f.store, 1, f.conversation.ID, strings.Repeat("x", 40<<10), time.Now().Add(time.Duration(index-100)*time.Second))
	}
	trace := &tracedCloudHistoryStore{MemoryStore: f.store}
	f.service.store = trace
	status, body := f.request(t, "GET", "/api/web-chat/conversations/"+f.conversation.ID+"/messages?limit=50", "synthetic-browser-cookie", "")
	var page CloudHistoryPage
	if status != 200 || json.Unmarshal([]byte(body), &page) != nil || !page.HasMore || len(page.Messages) != 50 || int64(len(body)) > CloudHistoryPageBytes+(512<<10) {
		t.Fatal("history page was not bounded/recoverable")
	}
	run, _ := f.create(t, "bounded-model-history", "最新需求必须保留")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || trace.legacyReads.Load() != 0 || trace.maxBodyBytes.Load() > CloudHistoryPageBytes {
		t.Fatalf("model loaded entire history: state=%s code=%s legacy=%d bodies=%d", finished.State, finished.ErrorCode, trace.legacyReads.Load(), trace.maxBodyBytes.Load())
	}
}

func TestCloudHistoryReadToolRechecksDeletedRecordBeforeNextModelRound(t *testing.T) {
	var rounds atomic.Int32
	var originalID atomic.Value
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if rounds.Add(1) == 1 {
			emitToolCalls(w, map[string]any{"index": 0, "id": "old_history", "type": "function", "function": map[string]any{"name": "read_history", "arguments": string(cloudJSON(map[string]any{"message_ids": []string{originalID.Load().(string)}, "max_bytes": 1024}))}})
			emitModelFinish(w, "tool_calls", 1)
			return
		}
		result := lastResearchToolResult(t, r)
		encoded := string(cloudJSON(result))
		if strings.Contains(encoded, "deleted-original-marker") || !strings.Contains(encoded, "unavailable_message_ids") {
			t.Error("deleted historical body was restored from private tool receipt")
		}
		emitCloudDelta(w, "该历史消息已删除，无法继续引用。")
		emitModelFinish(w, "stop", 1)
	})
	old := historyMessage(t, f.store, 1, f.conversation.ID, "deleted-original-marker"+strings.Repeat("x", 3<<20), time.Now().Add(-time.Hour))
	originalID.Store(old.ID)
	trace := &tracedCloudHistoryStore{MemoryStore: f.store, removeAfterRead: old.ID}
	f.service.store = trace
	run, _ := f.create(t, "history-deletion", "读取较早的大消息")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || rounds.Load() != 2 || trace.legacyReads.Load() != 0 {
		t.Fatalf("controlled retrieval failed: state=%s code=%s rounds=%d", finished.State, finished.ErrorCode, rounds.Load())
	}
}

func TestCloudHistoryHTTPShowsOmissionAndExplicitOwnedOriginal(t *testing.T) {
	f := newCloudHTTPFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("history read invoked a model") })
	message := historyMessage(t, f.store, 1, f.conversation.ID, "<original>"+strings.Repeat("x", 3<<20), time.Now())
	path := "/api/web-chat/conversations/" + f.conversation.ID + "/messages"
	status, body := f.request(t, "GET", path, "synthetic-browser-cookie", "")
	var page CloudHistoryPage
	if status != 200 || json.Unmarshal([]byte(body), &page) != nil || len(page.Messages) != 1 || !page.Messages[0].ContentOmitted || string(page.Messages[0].Content) != "null" || int64(len(body)) > CloudHistoryPageBytes+(512<<10) {
		t.Fatal("large history page hid omission or included the original body")
	}
	status, body = f.request(t, "GET", path+"/"+message.ID, "synthetic-browser-cookie", "")
	var response struct {
		Message CloudHistoryMessage `json:"message"`
	}
	if status != 200 || json.Unmarshal([]byte(body), &response) != nil || response.Message.ContentOmitted || string(response.Message.Content) != string(message.Content) {
		t.Fatal("explicit original was truncated or reinterpreted")
	}
	status, body = f.request(t, "GET", path+"/"+message.ID, "synthetic-other-account", "")
	if status != 404 || strings.Contains(body, "<original>") {
		t.Fatal("full original read crossed accounts")
	}
	status, _ = f.request(t, "GET", path+"?limit=101", "synthetic-browser-cookie", "")
	if status != 400 {
		t.Fatal("unbounded history page accepted")
	}
}

func TestCloudHistoryToolRejectsForeignConversationAndFutureMessage(t *testing.T) {
	for _, kind := range []string{"foreign_account", "future_in_same_conversation"} {
		t.Run(kind, func(t *testing.T) {
			var f *cloudHTTPFixture
			var rounds atomic.Int32
			f = newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
				if rounds.Add(1) > 1 {
					t.Error("unauthorized history entered a followup model round")
				}
				uid, cid := int64(1), f.conversation.ID
				if kind == "foreign_account" {
					conversation, err := f.service.CreateCloudConversation(context.Background(), 2, "fixture")
					if err != nil {
						t.Error(err)
						return
					}
					uid, cid = 2, conversation.ID
				}
				message := historyMessage(t, f.store, uid, cid, "unavailable-secret-history", time.Now())
				emitToolCalls(w, map[string]any{"index": 0, "id": "forbidden_history", "type": "function", "function": map[string]any{"name": "read_history", "arguments": string(cloudJSON(map[string]any{"message_ids": []string{message.ID}}))}})
				emitModelFinish(w, "tool_calls", 1)
			})
			run, _ := f.create(t, "scoped-history-tool", "只阅读本轮之前的当前会话")
			finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
			if finished.State != CloudRunFailed || finished.ErrorCode != "history_unavailable" || rounds.Load() != 1 || strings.Contains(finished.Output, "unavailable-secret-history") {
				t.Fatalf("history boundary failed: state=%s code=%s", finished.State, finished.ErrorCode)
			}
			ops, err := f.store.ListCloudToolOperations(context.Background(), 1, run.ID, 100)
			if err != nil {
				t.Fatal(err)
			}
			for _, op := range ops {
				if strings.Contains(string(op.Result), "unavailable-secret-history") {
					t.Fatal("foreign/future text entered private result cache")
				}
			}
		})
	}
}
