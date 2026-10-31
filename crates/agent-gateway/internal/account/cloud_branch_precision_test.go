package account

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCloudBranchPostgresClonePrecision(t *testing.T) {
	f := cloudRunPostgresFixture(t)
	ctx := context.Background()
	source := CloudConversation{ID: uuid.NewString(), UserID: 41, Title: "precision"}
	messages := []CloudMessage{
		{ID: uuid.NewString(), Role: "user", Content: cloudJSON("first")},
		{ID: uuid.NewString(), Role: "assistant", Content: cloudJSON("second")},
		{ID: uuid.NewString(), Role: "user", Content: cloudJSON("third")},
	}
	// PostgreSQL rounds sub-microsecond input. Consecutive .5 microsecond
	// instants can round to the same even microsecond and reorder by UUID.
	at := time.Date(2026, 10, 31, 0, 0, 0, 123456500, time.UTC)
	branch, clones, err := buildCloudBranch(source, messages, CloudBranchInput{Action: "fork", MessageID: messages[2].ID}, at)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.store.PutCloudConversation(ctx, branch.Conversation); err != nil {
		t.Fatal(err)
	}
	db := f.store.(*PersistentStore).db
	for _, m := range clones {
		if _, err = db.ExecContext(ctx, `INSERT INTO zerobox_cloud_messages(id,conversation_id,user_id,role,content,created_at)VALUES($1,$2,$3,$4,$5,$6)`, m.ID, m.ConversationID, m.UserID, m.Role, m.Content, m.CreatedAt); err != nil {
			t.Fatal(err)
		}
	}
	var distinct int
	if err = db.QueryRowContext(ctx, `SELECT count(DISTINCT created_at) FROM zerobox_cloud_messages WHERE conversation_id=$1`, branch.Conversation.ID).Scan(&distinct); err != nil {
		t.Fatal(err)
	}
	if distinct != len(clones) {
		t.Fatalf("database collapsed clone chronology: %d distinct instants for %d messages", distinct, len(clones))
	}
	loaded, err := f.store.ListCloudMessages(ctx, 41, branch.Conversation.ID)
	if err != nil || len(loaded) != len(clones) {
		t.Fatal("load cloned history", err)
	}
	for index, m := range loaded {
		if m.ID != clones[index].ID || string(m.Content) != string(clones[index].Content) {
			t.Fatal("clone order changed after database round trip")
		}
	}
}
