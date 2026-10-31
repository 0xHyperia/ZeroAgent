package cloudbackup

import (
	"context"
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/account"
)

func TestCloudBackupRestorePartialMessagesMonotonicPostgres(t *testing.T) {
	base, redisURL := os.Getenv("ZEROAGENT_BACKUP_TEST_DATABASE_URL"), os.Getenv("ZEROAGENT_BACKUP_TEST_REDIS_URL")
	if base == "" || redisURL == "" {
		t.Skip("explicit isolated PostgreSQL/Redis fixture configuration required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	dsn, db := backupDatabase(t, base)
	if _, err := db.ExecContext(ctx, `CREATE SCHEMA cloudapp`); err != nil {
		t.Fatal(err)
	}
	store, err := account.OpenPersistentStore(ctx, dsn, redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })
	// Only this newly created test DB relaxes the modern active-run invariant to
	// represent an older/abnormal restored snapshot. Production schema is intact.
	if _, err = db.ExecContext(ctx, `DROP INDEX cloudapp.zeroagent_cloud_runs_active_conversation_idx`); err != nil {
		t.Fatal(err)
	}
	var now time.Time
	if err = db.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&now); err != nil {
		t.Fatal(err)
	}
	conversations := []string{uuid.NewString(), uuid.NewString(), uuid.NewString()}
	for index, id := range conversations {
		owner := int64(7)
		if index == 1 {
			owner = 9
		}
		if err = store.PutCloudConversation(ctx, &account.CloudConversation{ID: id, UserID: owner, Title: "isolated restore ordering", CreatedAt: now, UpdatedAt: now}); err != nil {
			t.Fatal(err)
		}
	}
	type seeded struct {
		run, assistant, conversation, state, output string
		owner                                       int64
		userTime, runTime                           time.Time
		existingAssistant                           bool
		presentationOnly                            bool
	}
	future := now.Add(24 * time.Hour)
	seeds := []seeded{
		{run: "00000000-0000-4000-8000-000000000003", conversation: conversations[0], owner: 7, state: "running", output: "already canonical", userTime: future.Add(-3 * time.Microsecond), runTime: now, existingAssistant: true},
		{run: "00000000-0000-4000-8000-000000000002", conversation: conversations[0], owner: 7, state: "cancelling", output: "second retained partial", userTime: future.Add(-2 * time.Microsecond), runTime: now},
		{run: "00000000-0000-4000-8000-000000000001", conversation: conversations[0], owner: 7, state: "running", output: "first retained partial", userTime: future.Add(-time.Microsecond), runTime: now},
		{run: uuid.NewString(), conversation: conversations[0], owner: 7, state: "queued", userTime: future.Add(-4 * time.Microsecond), runTime: now},
		{run: uuid.NewString(), conversation: conversations[1], owner: 9, state: "running", output: "other owner partial", userTime: future.Add(24 * time.Hour), runTime: now},
		{run: uuid.NewString(), conversation: conversations[2], owner: 7, state: "running", output: "ordinary clock partial", userTime: now.Add(-time.Hour), runTime: now},
		{run: uuid.NewString(), conversation: conversations[2], owner: 7, state: "completed", output: "terminal must not be republished", userTime: now.Add(-time.Hour + time.Microsecond), runTime: now},
		{run: uuid.NewString(), conversation: conversations[2], owner: 7, state: "running", presentationOnly: true, userTime: now.Add(-time.Hour + 2*time.Microsecond), runTime: now},
	}
	for index := range seeds {
		s := &seeds[index]
		s.assistant = uuid.NewString()
		userMessage := uuid.NewString()
		if _, err = db.ExecContext(ctx, `INSERT INTO zerobox_cloud_messages(id,conversation_id,user_id,role,content,created_at) VALUES($1,$2,$3,'user','"synthetic user question"',$4)`, userMessage, s.conversation, s.owner, s.userTime); err != nil {
			t.Fatal(err)
		}
		if _, err = db.ExecContext(ctx, `INSERT INTO zeroagent_cloud_runs(id,conversation_id,user_id,session_ref,client_request_id,request_hash,model,request_content,user_message_id,assistant_message_id,state,output,usage,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,'fixture','"synthetic user question"',$7,$8,$9,$10,'{"total_tokens":7}',$11,$11)`, s.run, s.conversation, s.owner, strings.Repeat("a", 64), uuid.NewString(), strings.Repeat("b", 64), userMessage, s.assistant, s.state, s.output, s.runTime); err != nil {
			t.Fatal(err)
		}
		if s.existingAssistant {
			if _, err = db.ExecContext(ctx, `INSERT INTO zerobox_cloud_messages(id,conversation_id,user_id,role,content,created_at) VALUES($1,$2,$3,'assistant','"original canonical response"',$4)`, s.assistant, s.conversation, s.owner, future); err != nil {
				t.Fatal(err)
			}
		}
		if s.presentationOnly {
			completed := now.Add(-time.Minute)
			projection := account.CloudPresentation{Version: 1, State: "running", StartedAt: now.Add(-2 * time.Minute), Blocks: []account.CloudPresentationBlock{
				{ID: "reasoning:0", Type: "reasoning", Text: "公开思考片段", StartedAt: now.Add(-2 * time.Minute), CompletedAt: &completed},
				{ID: "tool:done", Type: "tool", Name: "read_file", State: "succeeded", Status: "已完成", StartedAt: now.Add(-time.Minute), CompletedAt: &completed},
				{ID: "tool:pending", Type: "tool", Name: "execute_command", State: "executing", StartedAt: now.Add(-time.Minute)},
			}, Rounds: []account.CloudPresentationRound{{Round: 0, Model: "fixture", StartedAt: now.Add(-2 * time.Minute)}}}
			raw, _ := json.Marshal(projection)
			if _, err = db.ExecContext(ctx, `UPDATE zeroagent_cloud_runs SET presentation=$2 WHERE id=$1`, s.run, raw); err != nil {
				t.Fatal(err)
			}
		}
	}
	type message struct {
		Conversation, Role, Content, Usage, Presentation string
		Owner                                            int64
		Time                                             time.Time
	}
	readMessages := func() map[string]message {
		t.Helper()
		rows, queryErr := db.QueryContext(ctx, `SELECT id::text,conversation_id::text,user_id,role,content::text,COALESCE(usage::text,'null'),created_at,COALESCE(presentation::text,'null') FROM zerobox_cloud_messages`)
		if queryErr != nil {
			t.Fatal(queryErr)
		}
		defer rows.Close()
		messages := map[string]message{}
		for rows.Next() {
			var id string
			var value message
			if scanErr := rows.Scan(&id, &value.Conversation, &value.Owner, &value.Role, &value.Content, &value.Usage, &value.Time, &value.Presentation); scanErr != nil {
				t.Fatal(scanErr)
			}
			messages[id] = value
		}
		if rows.Err() != nil {
			t.Fatal(rows.Err())
		}
		return messages
	}
	before := readMessages()
	engine := &Engine{Config: Config{Schema: "cloudapp"}, DB: db}
	invalidate := func() {
		t.Helper()
		tx, beginErr := db.BeginTx(ctx, nil)
		if beginErr != nil {
			t.Fatal(beginErr)
		}
		defer tx.Rollback()
		if invalidateErr := engine.invalidateSQL(ctx, tx); invalidateErr != nil {
			t.Fatal(invalidateErr)
		}
		if commitErr := tx.Commit(); commitErr != nil {
			t.Fatal(commitErr)
		}
	}
	invalidate()
	after := readMessages()
	for id, original := range before {
		if !reflect.DeepEqual(after[id], original) {
			t.Fatalf("canonical history changed: %s", id)
		}
	}
	if len(after) != len(before)+5 {
		t.Fatal("recovery did not append exactly the five missing public partial messages")
	}
	for _, s := range seeds {
		if (s.output == "" && !s.presentationOnly) || s.state == "completed" {
			if _, exists := after[s.assistant]; exists {
				t.Fatal("empty or terminal output was republished")
			}
			continue
		}
		value := after[s.assistant]
		if value.Conversation != s.conversation || value.Owner != s.owner || value.Role != "assistant" {
			t.Fatal("recovery message owner/conversation changed")
		}
		if !s.existingAssistant && (value.Content != `"`+s.output+`"` || value.Usage != `{"total_tokens": 7}` || !value.Time.After(s.userTime)) {
			t.Fatal("recovered partial lost content/usage or sorted before its user message")
		}
	}
	var projection account.CloudPresentation
	if json.Unmarshal([]byte(after[seeds[7].assistant].Presentation), &projection) != nil || projection.State != "interrupted" || projection.CompletedAt == nil || len(projection.Blocks) != 3 || len(projection.Rounds) != 1 {
		t.Fatal("restored public projection missing from canonical history")
	}
	if projection.Blocks[0].Text != "公开思考片段" || !projection.Blocks[0].CompletedAt.Equal(now.Add(-time.Minute)) || projection.Blocks[1].State != "succeeded" || projection.Blocks[2].State != "unknown" || projection.Blocks[2].CompletedAt == nil || projection.Rounds[0].CompletedAt == nil {
		t.Fatal("restore overwrote completed facts or inferred unfinished tool outcome")
	}
	if !after[seeds[2].assistant].Time.Equal(future.Add(time.Microsecond)) ||
		!after[seeds[1].assistant].Time.Equal(future.Add(2*time.Microsecond)) {
		t.Fatal("same-conversation partials did not receive distinct deterministic timestamps after latest canonical history")
	}
	if !after[seeds[4].assistant].Time.Equal(future.Add(24*time.Hour + time.Microsecond)) {
		t.Fatal("another conversation did not use its own latest canonical history")
	}
	if after[seeds[5].assistant].Time.Before(now) || after[seeds[5].assistant].Time.After(now.Add(time.Minute)) {
		t.Fatal("normal-clock recovery timestamp is outside its own recovery time")
	}
	var events, active int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM zeroagent_cloud_run_events WHERE type='run.interrupted'`).Scan(&events); err != nil || events != 7 {
		t.Fatal("active run interruption facts were not preserved")
	}
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM zeroagent_cloud_runs WHERE state IN ('queued','running','cancelling')`).Scan(&active); err != nil || active != 0 {
		t.Fatal("recovery left active runs unfenced")
	}
	invalidate()
	if !reflect.DeepEqual(readMessages(), after) {
		t.Fatal("repeated authentication invalidation changed canonical history")
	}
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM zeroagent_cloud_run_events WHERE type='run.interrupted'`).Scan(&events); err != nil || events != 7 {
		t.Fatal("repeated invalidation duplicated interruption events")
	}
}
