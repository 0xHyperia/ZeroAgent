package account

import (
	"context"
	"database/sql"
	"time"
)

// Call while owning the conversation write lock. Keep wall-clock display
// separate from a new message's minimum chronological position; never rewrite
// an existing message to guess an ambiguous historical order.
func (s *MemoryStore) nextCloudMessageTimeLocked(conversationID string, now time.Time) time.Time {
	result := now.UTC()
	for _, message := range s.cloudMessages[conversationID] {
		minimum := message.CreatedAt.Add(time.Microsecond)
		if result.Before(minimum) {
			result = minimum
		}
	}
	return result
}

func nextCloudMessageTimeTx(ctx context.Context, tx *sql.Tx, uid int64, conversationID string, now time.Time) (time.Time, error) {
	var result time.Time
	err := tx.QueryRowContext(ctx, `SELECT GREATEST($3::timestamptz,COALESCE(max(created_at)+interval '1 microsecond',$3::timestamptz)) FROM zerobox_cloud_messages WHERE user_id=$1 AND conversation_id=$2`, uid, conversationID, now).Scan(&result)
	return result.UTC(), err
}
