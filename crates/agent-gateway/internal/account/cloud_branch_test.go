package account

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func runCloudBranchContract(t *testing.T, fixture cloudRunTestFixture) {
	t.Helper()
	ctx := context.Background()
	store := fixture.store
	branches := store.(CloudBranchStore)
	seed := func() (*CloudConversation, []CloudMessage) {
		conversation := &CloudConversation{ID: uuid.NewString(), UserID: 41, Title: "写作", Model: "synthetic", CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
		if err := store.PutCloudConversation(ctx, conversation); err != nil {
			t.Fatal(err)
		}
		messages := make([]CloudMessage, 0, 4)
		for i, role := range []string{"user", "assistant", "user", "assistant"} {
			m := CloudMessage{ID: uuid.NewString(), ConversationID: conversation.ID, UserID: 41, Role: role, Content: cloudJSON([]string{"原始问题", "原始答案", "追加问题", "追加答案"}[i]), CreatedAt: time.Now().UTC().Add(time.Duration(i) * time.Millisecond)}
			if err := store.AddCloudMessage(ctx, &m); err != nil {
				t.Fatal(err)
			}
			messages = append(messages, m)
		}
		return conversation, messages
	}
	t.Run("fork_preserves_original", func(t *testing.T) {
		source, messages := seed()
		input := CloudBranchInput{ClientRequestID: uuid.NewString(), MessageID: messages[2].ID, Action: "fork"}
		branch, created, err := branches.CreateCloudBranch(ctx, 41, source.ID, input)
		if err != nil || !created {
			t.Fatalf("fork created=%v err=%v", created, err)
		}
		prefix, err := store.ListCloudMessages(ctx, 41, branch.Conversation.ID)
		const want = 3
		if err != nil || len(prefix) != want {
			t.Fatalf("fork prefix=%d expected=%d err=%v", len(prefix), want, err)
		}
		for i, m := range prefix {
			if m.ID == messages[i].ID || m.ConversationID != branch.Conversation.ID || string(m.Content) != string(messages[i].Content) {
				t.Fatalf("branch clone %d mismatch: id=%s original=%s conversation=%s want=%s content=%q want=%q time=%s", i, m.ID, messages[i].ID, m.ConversationID, branch.Conversation.ID, m.Content, messages[i].Content, m.CreatedAt.Format(time.RFC3339Nano))
			}
		}
		replayed, again, err := branches.CreateCloudBranch(ctx, 41, source.ID, input)
		if err != nil || again || replayed.Conversation.ID != branch.Conversation.ID || replayed.Conversation.UserID != 41 {
			t.Fatalf("lost receipt replay created=%v err=%v", again, err)
		}
		changed := input
		changed.MessageID = messages[0].ID
		if _, _, err = branches.CreateCloudBranch(ctx, 41, source.ID, changed); !errors.Is(err, ErrCloudRunConflict) {
			t.Fatal("request reuse accepted different anchor")
		}
		original, _ := store.ListCloudMessages(ctx, 41, source.ID)
		if len(original) != 4 || original[2].ID != messages[2].ID {
			t.Fatal("original history changed")
		}
		// New user turns must sort after every copied prefix in PostgreSQL.
		next := CloudMessage{ID: uuid.NewString(), ConversationID: branch.Conversation.ID, UserID: 41, Role: "user", Content: cloudJSON("后续"), CreatedAt: time.Now().UTC()}
		if err = store.AddCloudMessage(ctx, &next); err != nil {
			t.Fatal(err)
		}
		all, _ := store.ListCloudMessages(ctx, 41, branch.Conversation.ID)
		if all[len(all)-1].ID != next.ID {
			t.Fatal("copied timestamps sorted after new work")
		}

	})
	t.Run("ownership_and_active_source", func(t *testing.T) {
		source, messages := seed()
		input := CloudBranchInput{ClientRequestID: uuid.NewString(), MessageID: messages[1].ID, Action: "fork"}
		if _, _, err := branches.CreateCloudBranch(ctx, 42, source.ID, input); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign source accepted")
		}
		bad := input
		bad.MessageID = uuid.NewString()
		if _, _, err := branches.CreateCloudBranch(ctx, 41, source.ID, bad); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign/missing anchor accepted")
		}
		run := cloudRunTestInput(t, fixture, 41, source.ID, uuid.NewString(), "still running")
		if _, _, err := fixture.runs.CreateCloudRun(ctx, run); err != nil {
			t.Fatal(err)
		}
		if _, _, err := branches.CreateCloudBranch(ctx, 41, source.ID, input); !errors.Is(err, ErrCloudRunBusy) {
			t.Fatalf("active source branch err=%v", err)
		}
	})
	t.Run("concurrent_lost_receipt_and_deletion", func(t *testing.T) {
		source, messages := seed()
		input := CloudBranchInput{ClientRequestID: uuid.NewString(), MessageID: messages[1].ID, Action: "fork"}
		var created atomic.Int32
		var wg sync.WaitGroup
		ids := make(chan string, 12)
		for i := 0; i < 12; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				branch, newBranch, err := branches.CreateCloudBranch(ctx, 41, source.ID, input)
				if err != nil {
					t.Errorf("concurrent branch: %v", err)
					return
				}
				if newBranch {
					created.Add(1)
				}
				ids <- branch.Conversation.ID
			}()
		}
		wg.Wait()
		close(ids)
		id := ""
		for current := range ids {
			if id != "" && id != current {
				t.Fatal("duplicate branch created")
			}
			id = current
		}
		if created.Load() != 1 {
			t.Fatalf("created=%d", created.Load())
		}
		if err := store.DeleteCloudConversation(ctx, 41, source.ID); err != nil {
			t.Fatal(err)
		}
		if replay, again, err := branches.CreateCloudBranch(ctx, 41, source.ID, input); err != nil || again || replay.Conversation.ID != id {
			t.Fatalf("source deletion lost branch receipt: %v", err)
		}
		if err := store.DeleteCloudConversation(ctx, 41, id); err != nil {
			t.Fatal(err)
		}
		if _, _, err := branches.CreateCloudBranch(ctx, 41, source.ID, input); !errors.Is(err, ErrNotFound) {
			t.Fatal("deleted branch was recreated from receipt retry")
		}
	})
	t.Run("project_context_follows_branch", func(t *testing.T) {
		source, messages := seed()
		projects := store.(CloudProjectStore)
		project, err := projects.CreateCloudProject(ctx, &CloudProject{UserID: 41, Name: "私有项目", Instructions: "保留项目指令"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = projects.SetCloudConversationProject(ctx, 41, source.ID, project.ID, 0); err != nil {
			t.Fatal(err)
		}
		branch, _, err := branches.CreateCloudBranch(ctx, 41, source.ID, CloudBranchInput{ClientRequestID: uuid.NewString(), MessageID: messages[1].ID, Action: "fork"})
		if err != nil {
			t.Fatal(err)
		}
		binding, err := projects.GetCloudConversationProject(ctx, 41, branch.Conversation.ID)
		if err != nil || binding.ProjectID != project.ID || binding.Version != 1 {
			t.Fatalf("branch lost private project binding: %v", err)
		}
		if _, err = projects.GetCloudConversationProject(ctx, 42, branch.Conversation.ID); !errors.Is(err, ErrNotFound) {
			t.Fatal("foreign branch project disclosed")
		}
	})
}

func TestCloudBranchMemoryContract(t *testing.T) { runCloudBranchContract(t, cloudRunMemoryFixture(t)) }
func TestCloudBranchPostgresContract(t *testing.T) {
	fixture := cloudRunPostgresFixture(t)
	if _, err := fixture.store.(*PersistentStore).db.Exec(CloudFileSchema + CloudProjectSchema + CloudBranchSchema); err != nil {
		t.Fatal(err)
	}
	runCloudBranchContract(t, fixture)
}

func TestCloudBranchValidationRejectsPreviewActions(t *testing.T) {
	for _, action := range []string{"edit", "regenerate"} {
		if _, _, _, err := validateCloudBranch(1, uuid.NewString(), CloudBranchInput{ClientRequestID: "fork", MessageID: uuid.NewString(), Action: action}); !errors.Is(err, ErrCloudRunInvalid) {
			t.Fatalf("accepted preview action %s", action)
		}
	}
}
