package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const CloudBranchSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_branches (
 user_id BIGINT NOT NULL, client_request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL, destination_conversation_id UUID NOT NULL,
 result JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,client_request_id)
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_branches_destination_idx ON zeroagent_cloud_branches(user_id,destination_conversation_id);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_branches_source_idx ON zeroagent_cloud_branches(user_id,(result->>'source_conversation_id'));
`

func (s *PersistentStore) GetCloudBranch(ctx context.Context, userID int64, requestID string) (*CloudBranch, error) {
	var data []byte
	err := s.db.QueryRowContext(ctx, `SELECT b.result FROM zeroagent_cloud_branches b JOIN zerobox_cloud_conversations c ON c.id=b.destination_conversation_id AND c.user_id=b.user_id WHERE b.user_id=$1 AND b.client_request_id=$2`, userID, requestID).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var branch CloudBranch
	if err = json.Unmarshal(data, &branch); err != nil {
		return nil, err
	}
	if branch.Conversation == nil {
		return nil, ErrCloudRunInvalid
	}
	branch.Conversation.UserID = userID
	return &branch, nil
}

// Receipts deliberately have no cascading source/destination FK: deleting an
// original or branch must not make a lost-receipt retry recreate a deleted chat.
func (s *PersistentStore) CreateCloudBranch(ctx context.Context, userID int64, sourceID string, input CloudBranchInput) (*CloudBranch, bool, error) {
	sourceID, input, hash, err := validateCloudBranch(userID, sourceID, input)
	if err != nil {
		return nil, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, fmt.Sprintf("zeroagent-branch:%d:%s", userID, input.ClientRequestID)); err != nil {
		return nil, false, err
	}
	var oldHash, destination string
	var oldResult []byte
	err = tx.QueryRowContext(ctx, `SELECT request_hash,destination_conversation_id::text,result FROM zeroagent_cloud_branches WHERE user_id=$1 AND client_request_id=$2`, userID, input.ClientRequestID).Scan(&oldHash, &destination, &oldResult)
	if err == nil {
		if oldHash != hash {
			return nil, false, ErrCloudRunConflict
		}
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zerobox_cloud_conversations WHERE user_id=$1 AND id=$2)`, userID, destination).Scan(&exists); err != nil {
			return nil, false, err
		}
		if !exists {
			return nil, false, ErrNotFound
		}
		var branch CloudBranch
		if err = json.Unmarshal(oldResult, &branch); err != nil {
			return nil, false, err
		}
		if branch.Conversation == nil {
			return nil, false, ErrCloudRunInvalid
		}
		branch.Conversation.UserID = userID
		return &branch, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, false, err
	}
	var source CloudConversation
	err = tx.QueryRowContext(ctx, `SELECT id::text,user_id,title,model,created_at,updated_at FROM zerobox_cloud_conversations WHERE user_id=$1 AND id=$2 FOR UPDATE`, userID, sourceID).Scan(&source.ID, &source.UserID, &source.Title, &source.Model, &source.CreatedAt, &source.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, ErrNotFound
	}
	if err != nil {
		return nil, false, err
	}
	var active bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_runs WHERE conversation_id=$1 AND state IN ('queued','running','cancelling'))`, sourceID).Scan(&active); err != nil {
		return nil, false, err
	}
	if active {
		return nil, false, ErrCloudRunBusy
	}
	rows, err := tx.QueryContext(ctx, `SELECT id::text,conversation_id::text,user_id,role,content,usage,created_at,presentation FROM zerobox_cloud_messages WHERE user_id=$1 AND conversation_id=$2 ORDER BY created_at,id LIMIT 10001`, userID, sourceID)
	if err != nil {
		return nil, false, err
	}
	messages := make([]CloudMessage, 0)
	total := 0
	for rows.Next() {
		var message CloudMessage
		var usage, presentation []byte
		if err = rows.Scan(&message.ID, &message.ConversationID, &message.UserID, &message.Role, &message.Content, &usage, &message.CreatedAt, &presentation); err != nil {
			_ = rows.Close()
			return nil, false, err
		}
		message.Usage = append(json.RawMessage(nil), usage...)
		message.Presentation = append(json.RawMessage(nil), presentation...)
		total += len(message.Content) + len(usage) + len(presentation)
		if total > CloudRunMaxInputBytes || len(messages) >= 10000 {
			_ = rows.Close()
			return nil, false, ErrCloudRunLimit
		}
		messages = append(messages, message)
		if message.ID == input.MessageID {
			break
		}
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, false, err
	}
	branch, clones, err := buildCloudBranch(source, messages, input, time.Now().UTC())
	if err != nil {
		return nil, false, err
	}
	conversation := branch.Conversation
	if _, err = tx.ExecContext(ctx, `INSERT INTO zerobox_cloud_conversations(id,user_id,title,model,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6)`, conversation.ID, userID, conversation.Title, conversation.Model, conversation.CreatedAt, conversation.UpdatedAt); err != nil {
		return nil, false, err
	}
	for _, message := range clones {
		var usage any
		if len(message.Usage) > 0 {
			usage = []byte(message.Usage)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO zerobox_cloud_messages(id,conversation_id,user_id,role,content,usage,created_at,presentation) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, message.ID, message.ConversationID, userID, message.Role, []byte(message.Content), usage, message.CreatedAt, cloudRunNullableJSON(message.Presentation)); err != nil {
			return nil, false, err
		}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_project_conversations(conversation_id,user_id,project_id,version,created_at) SELECT $1,user_id,project_id,1,clock_timestamp() FROM zeroagent_cloud_project_conversations WHERE conversation_id=$2 AND user_id=$3 AND project_id IS NOT NULL`, conversation.ID, sourceID, userID); err != nil {
		return nil, false, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_branches(user_id,client_request_id,request_hash,destination_conversation_id,result) VALUES($1,$2,$3,$4,$5)`, userID, input.ClientRequestID, hash, conversation.ID, []byte(cloudJSON(branch))); err != nil {
		return nil, false, err
	}
	if err = tx.Commit(); err != nil {
		return nil, false, err
	}
	return branch, true, nil
}
