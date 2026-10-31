package account

import (
	"context"
	"time"
)

type cloudRunTurnHeadStore interface {
	GetCloudRunForUserMessage(context.Context, int64, string, string) (*CloudRun, error)
}

// This DTO deliberately has no output, model request, research topic, or usage
// body. Reading a terminal status cannot replace canonical saved messages.
type cloudRunTurnHead struct {
	ID                 string    `json:"id"`
	ConversationID     string    `json:"conversation_id"`
	ClientRequestID    string    `json:"client_request_id"`
	Model              string    `json:"model"`
	UserMessageID      string    `json:"user_message_id"`
	AssistantMessageID string    `json:"assistant_message_id"`
	State              string    `json:"state"`
	ErrorCode          string    `json:"error_code,omitempty"`
	LastSeq            int64     `json:"last_seq,string"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

func cloudRunHeadForTurn(run *CloudRun) cloudRunTurnHead {
	return cloudRunTurnHead{run.ID, run.ConversationID, run.ClientRequestID, run.Model, run.UserMessageID, run.AssistantMessageID, run.State, run.ErrorCode, run.LastSeq, run.CreatedAt, run.UpdatedAt}
}

func (s *MemoryStore) GetCloudRunForUserMessage(ctx context.Context, userID int64, conversationID, messageID string) (*CloudRun, error) {
	var err error
	if conversationID, err = canonicalCloudRunID(conversationID); err != nil {
		return nil, err
	}
	if messageID, err = canonicalCloudRunID(messageID); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	conversation, ok := s.cloudConversations[conversationID]
	if !ok || conversation.UserID != userID {
		return nil, ErrNotFound
	}
	if s.cloudRuns != nil {
		for _, item := range s.cloudRuns.runs {
			if item.UserID == userID && item.ConversationID == conversationID && item.UserMessageID == messageID {
				run := cloudPublicRun(item)
				run.Output = ""
				run.Presentation = nil
				return run, nil
			}
		}
	}
	return nil, ErrNotFound
}

func (s *PersistentStore) GetCloudRunForUserMessage(ctx context.Context, userID int64, conversationID, messageID string) (*CloudRun, error) {
	var err error
	if conversationID, err = canonicalCloudRunID(conversationID); err != nil {
		return nil, err
	}
	if messageID, err = canonicalCloudRunID(messageID); err != nil {
		return nil, err
	}
	columns := cloudRunProjectionColumns("''")
	return scanCloudRunView(s.db.QueryRowContext(ctx, "SELECT "+columns+` FROM zeroagent_cloud_runs r JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.user_id=$1 AND r.conversation_id=$2 AND r.user_message_id=$3 LIMIT 1`, userID, conversationID, messageID))
}
