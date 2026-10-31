package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"time"
)

const CloudPendingQueueSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_pending_queues (
  conversation_id UUID PRIMARY KEY REFERENCES zerobox_cloud_conversations(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  version BIGINT NOT NULL DEFAULT 0 CHECK (version >= 0),
  items JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(items)='array' AND jsonb_array_length(items)<=20 AND octet_length(items::text)<=16777216)
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_pending_queues_owner_idx ON zeroagent_cloud_pending_queues(user_id,conversation_id);
`

func readCloudPendingQueue(row cloudRunScanner, conversationID string) (*CloudPendingQueue, error) {
	queue := &CloudPendingQueue{ConversationID: conversationID, Items: []CloudPendingItem{}}
	var raw []byte
	err := row.Scan(&queue.Version, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return queue, nil
	}
	if err != nil {
		return nil, err
	}
	if json.Unmarshal(raw, &queue.Items) != nil || len(raw) > CloudPendingMaxQueueBytes || len(queue.Items) > CloudPendingMaxItems {
		return nil, ErrCloudRunInvalid
	}
	return queue, nil
}

func (s *PersistentStore) GetCloudPendingQueue(ctx context.Context, userID int64, conversationID string) (*CloudPendingQueue, error) {
	id, err := canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, err
	}
	var owner int64
	if err = s.db.QueryRowContext(ctx, `SELECT user_id FROM zerobox_cloud_conversations WHERE id=$1 AND user_id=$2`, id, userID).Scan(&owner); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	return readCloudPendingQueue(s.db.QueryRowContext(ctx, `SELECT version,items FROM zeroagent_cloud_pending_queues WHERE conversation_id=$1 AND user_id=$2`, id, userID), id)
}

func persistCloudPendingQueue(ctx context.Context, tx *sql.Tx, userID int64, queue *CloudPendingQueue) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_pending_queues(conversation_id,user_id,version,items) VALUES($1,$2,$3,$4)
ON CONFLICT(conversation_id) DO UPDATE SET version=EXCLUDED.version,items=EXCLUDED.items WHERE zeroagent_cloud_pending_queues.user_id=EXCLUDED.user_id`, queue.ConversationID, userID, queue.Version, []byte(cloudJSON(queue.Items)))
	return err
}

func (s *PersistentStore) MutateCloudPendingQueue(ctx context.Context, userID int64, conversationID string, mutation CloudPendingMutation) (*CloudPendingQueue, error) {
	id, err := canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, err
	}
	if mutation.Item != nil {
		mutation.Item, err = normalizeCloudPendingItem(mutation.Item)
		if err != nil {
			return nil, err
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if mutation.Kind == "enqueue" && mutation.Item != nil {
		// Same order as CreateCloudRun: request identity before conversation.
		key := strconv.FormatInt(userID, 10) + ":" + mutation.Item.ClientItemID
		if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock(hashtextextended($1,0))", key); err != nil {
			return nil, err
		}
	}
	var owner int64
	if err = tx.QueryRowContext(ctx, `SELECT user_id FROM zerobox_cloud_conversations WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, userID).Scan(&owner); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	if mutation.Kind == "enqueue" && mutation.Item != nil {
		var used bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_runs WHERE user_id=$1 AND client_request_id=$2)`, userID, mutation.Item.ClientItemID).Scan(&used); err != nil {
			return nil, err
		}
		if used {
			return nil, ErrCloudPendingConflict
		}
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_pending_queues WHERE user_id=$1 AND conversation_id<>$2 AND items @> $3::jsonb)`, userID, id, string(cloudJSON([]map[string]string{{"client_item_id": mutation.Item.ClientItemID}}))).Scan(&used); err != nil {
			return nil, err
		}
		if used {
			return nil, ErrCloudPendingConflict
		}
	}
	queue, err := readCloudPendingQueue(tx.QueryRowContext(ctx, `SELECT version,items FROM zeroagent_cloud_pending_queues WHERE conversation_id=$1 AND user_id=$2 FOR UPDATE`, id, userID), id)
	if err != nil {
		return nil, err
	}
	next, err := applyCloudPendingMutation(queue, mutation, time.Now())
	if err != nil {
		return nil, err
	}
	if err = persistCloudPendingQueue(ctx, tx, userID, next); err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return next, nil
}

// The caller already owns the conversation and account admission locks. Queue
// removal is committed with the Run, canonical user message and initial event.
func consumeCloudPendingTx(ctx context.Context, tx *sql.Tx, run *CloudRun) error {
	if run.pendingVersion == 0 {
		var reserved bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_pending_queues WHERE user_id=$1 AND items @> $2::jsonb)`, run.UserID, string(cloudJSON([]map[string]string{{"client_item_id": run.ClientRequestID}}))).Scan(&reserved); err != nil {
			return err
		}
		if reserved {
			return ErrCloudPendingConflict
		}
	}
	queue, err := readCloudPendingQueue(tx.QueryRowContext(ctx, `SELECT version,items FROM zeroagent_cloud_pending_queues WHERE conversation_id=$1 AND user_id=$2 FOR UPDATE`, run.ConversationID, run.UserID), run.ConversationID)
	if err != nil {
		return err
	}
	next, err := consumeCloudPendingQueue(queue, run)
	if err != nil {
		return err
	}
	if next.Version == queue.Version {
		return nil
	}
	return persistCloudPendingQueue(ctx, tx, run.UserID, next)
}
