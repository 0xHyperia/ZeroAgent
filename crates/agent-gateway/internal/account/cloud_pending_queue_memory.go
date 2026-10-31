package account

import (
	"context"
	"strconv"
)

func (s *MemoryStore) cloudPendingQueueLocked(userID int64, conversationID string) (*CloudPendingQueue, error) {
	conversation, ok := s.cloudConversations[conversationID]
	if !ok || conversation.UserID != userID {
		return nil, ErrNotFound
	}
	if queue := s.cloudPending[conversationID]; queue != nil {
		return cloneCloudPendingQueue(*queue), nil
	}
	return &CloudPendingQueue{ConversationID: conversationID, Items: []CloudPendingItem{}}, nil
}

func (s *MemoryStore) GetCloudPendingQueue(ctx context.Context, userID int64, conversationID string) (*CloudPendingQueue, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id, err := canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cloudPendingQueueLocked(userID, id)
}

func (s *MemoryStore) MutateCloudPendingQueue(ctx context.Context, userID int64, conversationID string, mutation CloudPendingMutation) (*CloudPendingQueue, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
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
	s.mu.Lock()
	defer s.mu.Unlock()
	queue, err := s.cloudPendingQueueLocked(userID, id)
	if err != nil {
		return nil, err
	}
	if mutation.Kind == "enqueue" && mutation.Item != nil && s.cloudRuns != nil {
		if _, exists := s.cloudRuns.requests[strconv.FormatInt(userID, 10)+":"+mutation.Item.ClientItemID]; exists {
			return nil, ErrCloudPendingConflict
		}
	}
	if mutation.Kind == "enqueue" && mutation.Item != nil {
		for otherID, other := range s.cloudPending {
			if otherID != id && s.cloudConversations[otherID].UserID == userID && cloudPendingIndex(other, mutation.Item.ClientItemID) >= 0 {
				return nil, ErrCloudPendingConflict
			}
		}
	}
	next, err := applyCloudPendingMutation(queue, mutation, s.now())
	if err != nil {
		return nil, err
	}
	if s.cloudPending == nil {
		s.cloudPending = map[string]*CloudPendingQueue{}
	}
	s.cloudPending[id] = next
	return cloneCloudPendingQueue(*next), nil
}

// Called under the admission mutex immediately before its infallible writes.
func (s *MemoryStore) consumeCloudPendingLocked(run *CloudRun) error {
	if run.pendingVersion == 0 {
		for id, other := range s.cloudPending {
			if s.cloudConversations[id].UserID == run.UserID && cloudPendingIndex(other, run.ClientRequestID) >= 0 {
				return ErrCloudPendingConflict
			}
		}
	}
	queue, err := s.cloudPendingQueueLocked(run.UserID, run.ConversationID)
	if err != nil {
		return err
	}
	next, err := consumeCloudPendingQueue(queue, run)
	if err != nil {
		return err
	}
	if next.Version != queue.Version {
		if s.cloudPending == nil {
			s.cloudPending = map[string]*CloudPendingQueue{}
		}
		s.cloudPending[run.ConversationID] = next
	}
	return nil
}
