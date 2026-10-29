package account

import (
	"context"
	"encoding/json"
	"sort"
	"strconv"
	"time"

	"github.com/google/uuid"
)

type cloudRunMemoryState struct {
	runs          map[string]CloudRun
	requests      map[string]string
	events        map[string][]CloudRunEvent
	operations    map[string]map[string]string
	admission     CloudRunAdmissionLimits
	lastClaims    map[int64]int64
	claimSequence int64
}

func (s *MemoryStore) cloudRunStateLocked() *cloudRunMemoryState {
	if s.cloudRuns == nil {
		s.cloudRuns = &cloudRunMemoryState{
			runs: make(map[string]CloudRun), requests: make(map[string]string),
			events: make(map[string][]CloudRunEvent), operations: make(map[string]map[string]string),
			admission: DefaultCloudRunAdmissionLimits(), lastClaims: make(map[int64]int64),
		}
	}
	return s.cloudRuns
}

// deleteCloudRunsLocked mirrors PostgreSQL's conversation cascade. The caller
// must own s.mu and must have checked the conversation's authenticated owner.
func (s *MemoryStore) deleteCloudRunsLocked(conversationID string) {
	if s.cloudRuns == nil {
		return
	}
	for id, run := range s.cloudRuns.runs {
		if run.ConversationID != conversationID {
			continue
		}
		requestKey := strconv.FormatInt(run.UserID, 10) + ":" + run.ClientRequestID
		if s.cloudRuns.requests[requestKey] == id {
			delete(s.cloudRuns.requests, requestKey)
		}
		delete(s.cloudRuns.runs, id)
		delete(s.cloudRuns.events, id)
		delete(s.cloudRuns.operations, id)
	}
}

func (s *MemoryStore) cloudRunLocked(userID int64, id string) (*CloudRun, error) {
	var err error
	id, err = canonicalCloudRunID(id)
	if err != nil {
		return nil, err
	}
	if s.cloudRuns == nil {
		return nil, ErrNotFound
	}
	run, ok := s.cloudRuns.runs[id]
	conversation, exists := s.cloudConversations[run.ConversationID]
	if !ok || run.UserID != userID || !exists || conversation.UserID != userID {
		return nil, ErrNotFound
	}
	copy := cloneCloudRun(run)
	return &copy, nil
}

func (s *MemoryStore) appendCloudRunEventLocked(run *CloudRun, kind string, payload json.RawMessage, now time.Time) {
	run.LastSeq++
	run.UpdatedAt = now.UTC()
	s.cloudRuns.events[run.ID] = append(s.cloudRuns.events[run.ID], CloudRunEvent{
		ID: uuid.NewString(), RunID: run.ID, ConversationID: run.ConversationID, Seq: run.LastSeq,
		Type: kind, Payload: append(json.RawMessage(nil), payload...), CreatedAt: now.UTC(),
	})
	s.cloudRuns.runs[run.ID] = cloneCloudRun(*run)
}

func (s *MemoryStore) finishCloudRunLocked(run *CloudRun, now time.Time) {
	updatedAt := now.UTC()
	if run.Output != "" {
		messageAt := s.nextCloudMessageTimeLocked(run.ConversationID, now)
		updatedAt = messageAt
		content, _ := json.Marshal(run.Output)
		s.cloudMessages[run.ConversationID] = append(s.cloudMessages[run.ConversationID], CloudMessage{
			ID: run.AssistantMessageID, ConversationID: run.ConversationID, UserID: run.UserID,
			Role: "assistant", Content: content, Usage: append(json.RawMessage(nil), run.Usage...), CreatedAt: messageAt,
		})
	}
	conversation := s.cloudConversations[run.ConversationID]
	conversation.UpdatedAt = updatedAt
	s.cloudConversations[run.ConversationID] = conversation
	run.LeaseOwner, run.LeaseUntil = "", time.Time{}
}

func (s *MemoryStore) CreateCloudRun(ctx context.Context, input *CloudRun) (*CloudRun, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	run, err := prepareCloudRun(input, s.now())
	if err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	conversation, ok := s.cloudConversations[run.ConversationID]
	if !ok || conversation.UserID != run.UserID {
		return nil, false, ErrNotFound
	}
	state := s.cloudRunStateLocked()
	requestKey := strconv.FormatInt(run.UserID, 10) + ":" + run.ClientRequestID
	if id, exists := state.requests[requestKey]; exists {
		existing, getErr := s.cloudRunLocked(run.UserID, id)
		if getErr != nil {
			return nil, false, ErrCloudRunConflict
		}
		if existing.RequestHash != run.RequestHash || existing.ConversationID != run.ConversationID {
			return nil, false, ErrCloudRunConflict
		}
		return existing, false, nil
	}
	if _, exists := state.runs[run.ID]; exists {
		return nil, false, ErrCloudRunConflict
	}
	for _, existing := range state.runs {
		if existing.ConversationID == run.ConversationID && !existing.Terminal() {
			return nil, false, ErrCloudRunBusy
		}
	}
	queued := 0
	for _, existing := range state.runs {
		if existing.UserID == run.UserID && existing.State == CloudRunQueued {
			queued++
		}
	}
	if queued >= state.admission.MaxQueuedPerAccount {
		return nil, false, ErrCloudRunQueueFull
	}
	for _, message := range s.cloudMessages[run.ConversationID] {
		if message.ID == run.UserMessageID || message.ID == run.AssistantMessageID {
			return nil, false, ErrCloudRunConflict
		}
	}
	messageAt := s.nextCloudMessageTimeLocked(run.ConversationID, run.CreatedAt)
	s.cloudMessages[run.ConversationID] = append(s.cloudMessages[run.ConversationID], CloudMessage{
		ID: run.UserMessageID, ConversationID: run.ConversationID, UserID: run.UserID,
		Role: "user", Content: append(json.RawMessage(nil), run.RequestContent...), CreatedAt: messageAt,
	})
	conversation.UpdatedAt, conversation.Model = messageAt, run.Model
	if conversation.Title == "" || conversation.Title == "新对话" {
		conversation.Title = cloudConversationTitle(run.RequestContent)
	}
	s.cloudConversations[run.ConversationID] = conversation
	state.requests[requestKey] = run.ID
	state.operations[run.ID] = make(map[string]string)
	s.appendCloudRunEventLocked(run, "run.queued", cloudRunEventPayload(run.State, "", ""), run.CreatedAt)
	return run, true, nil
}

func (s *MemoryStore) GetCloudRun(ctx context.Context, userID int64, id string) (*CloudRun, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cloudRunLocked(userID, id)
}

func (s *MemoryStore) ListCloudRuns(ctx context.Context, userID int64, conversationID string, activeOnly bool) ([]CloudRun, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	var err error
	conversationID, err = canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	conversation, ok := s.cloudConversations[conversationID]
	if !ok || conversation.UserID != userID {
		return nil, ErrNotFound
	}
	result := make([]CloudRun, 0)
	if s.cloudRuns != nil {
		for _, run := range s.cloudRuns.runs {
			if run.UserID == userID && run.ConversationID == conversationID && (!activeOnly || !run.Terminal()) {
				result = append(result, cloneCloudRun(run))
			}
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt.Equal(result[j].CreatedAt) {
			return result[i].ID > result[j].ID
		}
		return result[i].CreatedAt.After(result[j].CreatedAt)
	})
	if len(result) > 100 {
		result = result[:100]
	}
	return result, nil
}

func (s *MemoryStore) ClaimCloudRun(ctx context.Context, owner string, lease time.Duration) (*CloudRun, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := normalizeCloudRunLease(owner, lease); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.cloudRunStateLocked()
	var selected *CloudRun
	active := map[int64]int{}
	for _, run := range state.runs {
		if run.State == CloudRunRunning || run.State == CloudRunCancelling {
			active[run.UserID]++
		}
	}
	for _, run := range state.runs {
		conversation, exists := s.cloudConversations[run.ConversationID]
		if run.State != CloudRunQueued || !exists || conversation.UserID != run.UserID {
			continue
		}
		if active[run.UserID] >= state.admission.MaxExecutingPerAccount {
			continue
		}
		if selected == nil || state.lastClaims[run.UserID] < state.lastClaims[selected.UserID] || (state.lastClaims[run.UserID] == state.lastClaims[selected.UserID] && (run.CreatedAt.Before(selected.CreatedAt) || (run.CreatedAt.Equal(selected.CreatedAt) && run.ID < selected.ID))) {
			copy := cloneCloudRun(run)
			selected = &copy
		}
	}
	if selected == nil {
		return nil, ErrNotFound
	}
	now := s.now().UTC()
	selected.State, selected.LeaseOwner, selected.LeaseUntil = CloudRunRunning, owner, now.Add(lease)
	selected.Attempt++
	state.claimSequence++
	state.lastClaims[selected.UserID] = state.claimSequence
	s.appendCloudRunEventLocked(selected, "run.started", cloudRunEventPayload(selected.State, "", ""), now)
	return selected, nil
}

func (s *MemoryStore) RenewCloudRunLease(ctx context.Context, userID int64, id, owner string, attempt int64, lease time.Duration) (*CloudRun, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := normalizeCloudRunLease(owner, lease); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.cloudRunLocked(userID, id)
	if err != nil {
		return nil, err
	}
	now := s.now().UTC()
	if err := validateCloudRunLease(run, owner, attempt, now); err != nil {
		return nil, err
	}
	run.LeaseUntil, run.UpdatedAt = now.Add(lease), now
	s.cloudRuns.runs[run.ID] = cloneCloudRun(*run)
	return run, nil
}

func (s *MemoryStore) CommitCloudRun(ctx context.Context, userID int64, id, owner string, attempt int64, update CloudRunCommit) (*CloudRun, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	commit, hash, err := prepareCloudRunCommit(update)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.cloudRunLocked(userID, id)
	if err != nil {
		return nil, err
	}
	id = run.ID
	if previous, ok := s.cloudRuns.operations[id][commit.OperationID]; ok {
		if previous != hash {
			return nil, ErrCloudRunConflict
		}
		return run, nil
	}
	now := s.now().UTC()
	if err := validateCloudRunLease(run, owner, attempt, now); err != nil {
		return nil, err
	}
	if run.State == CloudRunCancelling && commit.State != CloudRunCancelled && commit.State != CloudRunInterrupted {
		return nil, ErrCloudRunLeaseLost
	}
	if len(run.Output)+len(commit.Delta) > CloudRunMaxOutputBytes {
		return nil, ErrCloudRunLimit
	}
	run.Output += commit.Delta
	if len(commit.Usage) > 0 {
		run.Usage = append(json.RawMessage(nil), commit.Usage...)
	}
	if commit.State != "" {
		run.State = commit.State
	}
	run.ErrorCode = commit.ErrorCode
	if run.Terminal() {
		s.finishCloudRunLocked(run, now)
	}
	s.cloudRuns.operations[id][commit.OperationID] = hash
	s.appendCloudRunEventLocked(run, commit.EventType, commit.Payload, now)
	return run, nil
}

func (s *MemoryStore) CancelCloudRun(ctx context.Context, userID int64, id string) (*CloudRun, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.cloudRunLocked(userID, id)
	if err != nil {
		return nil, err
	}
	if run.Terminal() || run.State == CloudRunCancelling {
		return run, nil
	}
	if run.State == CloudRunQueued {
		run.State = CloudRunCancelled
		s.finishCloudRunLocked(run, s.now())
	} else {
		run.State = CloudRunCancelling
	}
	s.appendCloudRunEventLocked(run, "run."+run.State, cloudRunEventPayload(run.State, "", ""), s.now())
	return run, nil
}

func (s *MemoryStore) ListCloudRunEvents(ctx context.Context, userID int64, id string, after int64, limit int) ([]CloudRunEvent, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if after < 0 {
		return nil, ErrCloudRunInvalid
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	run, err := s.cloudRunLocked(userID, id)
	if err != nil {
		return nil, err
	}
	result := make([]CloudRunEvent, 0)
	limit = cloudRunEventsLimit(limit)
	for _, event := range s.cloudRuns.events[run.ID] {
		if event.Seq > after {
			event.Payload = append(json.RawMessage(nil), event.Payload...)
			result = append(result, event)
			if len(result) == limit {
				break
			}
		}
	}
	return result, nil
}

func (s *MemoryStore) InterruptExpiredCloudRuns(ctx context.Context) (int, error) {
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now().UTC()
	count := 0
	if s.cloudRuns == nil {
		return 0, nil
	}
	for id, current := range s.cloudRuns.runs {
		if (current.State != CloudRunRunning && current.State != CloudRunCancelling) || current.LeaseUntil.After(now) {
			continue
		}
		if _, err := s.cloudRunLocked(current.UserID, id); err != nil {
			continue
		}
		run := cloneCloudRun(current)
		run.State, run.ErrorCode = CloudRunInterrupted, "lease_expired"
		s.finishCloudRunLocked(&run, now)
		s.appendCloudRunEventLocked(&run, "run.interrupted", cloudRunEventPayload(run.State, "", run.ErrorCode), now)
		count++
	}
	return count, nil
}
