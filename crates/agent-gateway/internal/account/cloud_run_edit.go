package account

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"github.com/google/uuid"
)

// CloudRunHistoryEdit binds the destructive edit to the exact history the
// account saw. It is part of the request hash and is used only during admission.
type CloudRunHistoryEdit struct {
	MessageID      string `json:"message_id"`
	ExpectedTailID string `json:"expected_tail_id"`
}

var errCloudHistoryChanged = &APIError{
	Status:  http.StatusConflict,
	Reason:  "cloud_history_changed",
	Message: "会话历史已变化。请重新加载会话后再编辑。",
}

func normalizeCloudRunHistoryEdit(edit *CloudRunHistoryEdit) (*CloudRunHistoryEdit, error) {
	if edit == nil {
		return nil, nil
	}
	anchor, err := uuid.Parse(edit.MessageID)
	if err != nil {
		return nil, ErrCloudRunInvalid
	}
	tail, err := uuid.Parse(edit.ExpectedTailID)
	if err != nil {
		return nil, ErrCloudRunInvalid
	}
	return &CloudRunHistoryEdit{MessageID: anchor.String(), ExpectedTailID: tail.String()}, nil
}

func truncateCloudRunHistoryTx(ctx context.Context, tx *sql.Tx, run *CloudRun) error {
	edit := run.historyEdit
	var tail string
	err := tx.QueryRowContext(ctx, `SELECT id::text FROM zerobox_cloud_messages
WHERE conversation_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
		run.ConversationID, run.UserID).Scan(&tail)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && tail != edit.ExpectedTailID) {
		return errCloudHistoryChanged
	}
	if err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM zerobox_cloud_messages AS message
USING zerobox_cloud_messages AS anchor
WHERE anchor.conversation_id=$1 AND anchor.user_id=$2 AND anchor.id=$3 AND anchor.role='user'
AND message.conversation_id=anchor.conversation_id AND message.user_id=anchor.user_id
AND (message.created_at,message.id)>=(anchor.created_at,anchor.id)`,
		run.ConversationID, run.UserID, edit.MessageID)
	if err != nil {
		return err
	}
	deleted, err := result.RowsAffected()
	if err == nil && deleted == 0 {
		return errCloudHistoryChanged
	}
	return err
}
