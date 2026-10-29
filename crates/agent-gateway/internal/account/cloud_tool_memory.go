package account

import (
	"context"
	"encoding/json"
	"sort"

	"github.com/google/uuid"
)

type cloudToolMemoryState struct {
	operations   map[string]CloudToolOperation
	calls        map[string]string
	workspaces   map[string]CloudWorkspaceBinding
	observations map[string]CloudWorkspaceCleanup
	budgets      map[string]int64
	allocations  map[string]CloudAllocationReservation
}

func (s *MemoryStore) cloudToolStateLocked() *cloudToolMemoryState {
	if s.cloudTools == nil {
		s.cloudTools = &cloudToolMemoryState{operations: map[string]CloudToolOperation{}, calls: map[string]string{}, workspaces: map[string]CloudWorkspaceBinding{}, observations: map[string]CloudWorkspaceCleanup{}, budgets: map[string]int64{}}
	}
	return s.cloudTools
}

func (s *MemoryStore) cloudToolRunLocked(userID int64, runID, owner string, attempt int64, allowCancelling bool) (*CloudRun, error) {
	run, err := s.cloudRunLocked(userID, runID)
	if err != nil {
		return nil, err
	}
	if err = validateCloudRunLease(run, owner, attempt, s.now()); err != nil {
		return nil, err
	}
	if !allowCancelling && run.State != CloudRunRunning {
		return nil, ErrCloudRunLeaseLost
	}
	return run, nil
}

func (s *MemoryStore) deleteCloudToolRunRecordsLocked(conversationID string) {
	if s.cloudTools == nil {
		return
	}
	for id, op := range s.cloudTools.operations {
		if op.ConversationID == conversationID {
			delete(s.cloudTools.operations, id)
			delete(s.cloudTools.calls, op.RunID+":"+op.CallKey)
		}
	}
	for id, binding := range s.cloudTools.workspaces {
		if binding.ConversationID == conversationID && binding.State != CloudWorkspaceClosed {
			binding.State = CloudWorkspaceCleanupPending
			binding.Version++
			binding.UpdatedAt = s.now().UTC()
			s.cloudTools.workspaces[id] = binding
		}
	}
}

func (s *MemoryStore) PrepareCloudTool(ctx context.Context, userID int64, runID, owner string, attempt int64, input *CloudToolOperation) (*CloudToolOperation, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.cloudToolRunLocked(userID, runID, owner, attempt, false)
	if err != nil {
		return nil, false, err
	}
	op, err := prepareCloudTool(input, userID, run, s.now())
	if err != nil {
		return nil, false, err
	}
	state := s.cloudToolStateLocked()
	key := run.ID + ":" + op.CallKey
	if id, ok := state.calls[key]; ok {
		existing := state.operations[id]
		if existing.RequestHash != op.RequestHash {
			return nil, false, ErrCloudToolConflict
		}
		if existing.ExecutionAttempt != attempt {
			return nil, false, ErrCloudRunLeaseLost
		}
		copy := cloneCloudTool(existing)
		return &copy, false, nil
	}
	if _, exists := state.operations[op.ID]; exists {
		return nil, false, ErrCloudToolConflict
	}
	count := 0
	for _, other := range state.operations {
		if other.RunID == run.ID {
			count++
		}
	}
	if count >= CloudToolMaxRunOperations {
		return nil, false, ErrCloudToolQuota
	}
	state.operations[op.ID] = *op
	state.calls[key] = op.ID
	copy := cloneCloudTool(*op)
	return &copy, true, nil
}

func (s *MemoryStore) cloudToolLocked(userID int64, id string) (*CloudToolOperation, error) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return nil, ErrCloudToolInvalid
	}
	op, ok := s.cloudToolStateLocked().operations[parsed.String()]
	if !ok || op.UserID != userID {
		return nil, ErrNotFound
	}
	if _, err = s.cloudRunLocked(userID, op.RunID); err != nil {
		return nil, err
	}
	copy := cloneCloudTool(op)
	return &copy, nil
}

func (s *MemoryStore) GetCloudToolOperation(ctx context.Context, userID int64, id string) (*CloudToolOperation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cloudToolLocked(userID, id)
}

func (s *MemoryStore) ListCloudToolOperations(ctx context.Context, userID int64, runID string, limit int) ([]CloudToolOperation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit < 1 || limit > CloudToolMaxRunOperations {
		return nil, ErrCloudToolInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.cloudRunLocked(userID, runID)
	if err != nil {
		return nil, err
	}
	items := []CloudToolOperation{}
	for _, op := range s.cloudToolStateLocked().operations {
		if op.UserID == userID && op.RunID == run.ID {
			items = append(items, cloneCloudTool(op))
		}
	}
	sort.Slice(items, func(i, j int) bool {
		return cloudProjectEarlier(items[i].CreatedAt, items[i].ID, items[j].CreatedAt, items[j].ID)
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *MemoryStore) StartCloudTool(ctx context.Context, userID int64, id, owner string, attempt int64) (*CloudToolOperation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	op, err := s.cloudToolLocked(userID, id)
	if err != nil {
		return nil, err
	}
	if _, err = s.cloudToolRunLocked(userID, op.RunID, owner, attempt, false); err != nil {
		return nil, err
	}
	if op.ExecutionAttempt != attempt {
		return nil, ErrCloudRunLeaseLost
	}
	if op.State != CloudToolPrepared {
		return nil, ErrCloudToolConflict
	}
	op.State = CloudToolExecuting
	op.Version++
	op.UpdatedAt = s.now().UTC()
	s.cloudTools.operations[op.ID] = *op
	return op, nil
}

func (s *MemoryStore) CommitCloudTool(ctx context.Context, userID int64, id, owner string, attempt int64, state string, result json.RawMessage, errorCode string) (*CloudToolOperation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	op, err := s.cloudToolLocked(userID, id)
	if err != nil {
		return nil, err
	}
	if _, err = s.cloudToolRunLocked(userID, op.RunID, owner, attempt, true); err != nil {
		return nil, err
	}
	if op.ExecutionAttempt != attempt {
		return nil, ErrCloudRunLeaseLost
	}
	op, err = commitCloudTool(*op, state, result, errorCode, s.now())
	if err != nil {
		return nil, err
	}
	s.cloudTools.operations[op.ID] = *op
	return op, nil
}

func (s *MemoryStore) latestCloudWorkspaceLocked(userID int64, conversationID string, activeOnly bool) (*CloudWorkspaceBinding, error) {
	var result *CloudWorkspaceBinding
	for _, binding := range s.cloudToolStateLocked().workspaces {
		if binding.UserID != userID || binding.ConversationID != conversationID || (activeOnly && binding.State == CloudWorkspaceClosed) {
			continue
		}
		if result == nil || (result.State == CloudWorkspaceClosed && binding.State != CloudWorkspaceClosed) || ((result.State == CloudWorkspaceClosed) == (binding.State == CloudWorkspaceClosed) && cloudProjectEarlier(result.CreatedAt, result.ID, binding.CreatedAt, binding.ID)) {
			copy := binding
			result = &copy
		}
	}
	if result == nil {
		return nil, ErrNotFound
	}
	return result, nil
}

func (s *MemoryStore) GetCloudWorkspace(ctx context.Context, userID int64, conversationID string) (*CloudWorkspaceBinding, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	conversationID, err := canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, ErrCloudToolInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	conversation, exists := s.cloudConversations[conversationID]
	if !exists || conversation.UserID != userID {
		return nil, ErrNotFound
	}
	return s.latestCloudWorkspaceLocked(userID, conversationID, false)
}

func (s *MemoryStore) ReserveCloudWorkspace(ctx context.Context, userID int64, runID, owner string, attempt, seconds, limit int64) (*CloudWorkspaceBinding, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if !validCloudWorkspaceReservation(seconds, limit) {
		return nil, false, ErrCloudToolInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run, err := s.cloudToolRunLocked(userID, runID, owner, attempt, false)
	if err != nil {
		return nil, false, err
	}
	state := s.cloudToolStateLocked()
	if current, err := s.latestCloudWorkspaceLocked(userID, run.ConversationID, true); err == nil {
		if current.State == CloudWorkspaceReady && !current.ExpiresAt.After(s.now()) {
			current.State = CloudWorkspaceCleanupPending
		}
		return current, false, nil
	}
	binding := newCloudWorkspace(run, seconds, s.now())
	if _, _, err := reserveCloudAllocationLocked(state, userID, binding.CreateOperationID, "conversation", seconds, limit, s.now()); err != nil {
		return nil, false, err
	}
	state.workspaces[binding.ID] = *binding
	return binding, true, nil
}

func (s *MemoryStore) workspaceCreationAuthorizedLocked(binding CloudWorkspaceBinding) bool {
	_, err := s.cloudToolRunLocked(binding.UserID, binding.RunID, binding.LeaseOwner, binding.ExecutionAttempt, false)
	return err == nil
}

func (s *MemoryStore) RecordCloudWorkspaceReceipt(ctx context.Context, userID int64, bindingID, operationID string, version int64, receipt CloudWorkspaceReceipt) (*CloudWorkspaceBinding, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validCloudWorkspaceReceipt(receipt) {
		return nil, ErrCloudToolInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.cloudToolStateLocked()
	binding, ok := state.workspaces[bindingID]
	if !ok || binding.UserID != userID || binding.CreateOperationID != operationID {
		return nil, ErrNotFound
	}
	updated, cleanup, conflict := applyCloudWorkspaceReceipt(binding, version, receipt, s.workspaceCreationAuthorizedLocked(binding), s.now())
	state.workspaces[binding.ID] = *updated
	if receipt.SandboxID != "" {
		var observed *CloudWorkspaceCleanup
		for id, row := range state.observations {
			if row.BindingID == binding.ID && row.SandboxID == receipt.SandboxID {
				copy := row
				observed = &copy
				if cleanup && row.State != CloudWorkspaceClosed {
					row.State = CloudWorkspaceCleanupPending
					row.Version++
					row.UpdatedAt = s.now().UTC()
					state.observations[id] = row
				}
				break
			}
		}
		if observed == nil {
			row := newCloudWorkspaceObservation(*updated, receipt.SandboxID, cleanup, s.now())
			state.observations[row.ID] = row
		}
	}
	if conflict {
		return updated, ErrCloudToolConflict
	}
	return updated, nil
}

func (s *MemoryStore) ListCloudWorkspaceCleanup(ctx context.Context, limit int) ([]CloudWorkspaceCleanup, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 100 {
		return nil, ErrCloudToolInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.cloudToolStateLocked()
	items := []CloudWorkspaceCleanup{}
	for _, binding := range state.workspaces {
		conversation, exists := s.cloudConversations[binding.ConversationID]
		orphan := !exists || conversation.UserID != binding.UserID
		needs := binding.State == CloudWorkspaceCleanupPending || orphan || (!binding.ExpiresAt.IsZero() && !binding.ExpiresAt.After(s.now()))
		observations := 0
		for _, row := range state.observations {
			if row.BindingID != binding.ID {
				continue
			}
			observations++
			if row.State == CloudWorkspaceClosed {
				continue
			}
			if needs || row.State == CloudWorkspaceCleanupPending {
				row.State = CloudWorkspaceCleanupPending
				items = append(items, row)
			}
		}
		if binding.State != CloudWorkspaceClosed && observations == 0 && (needs || !s.workspaceCreationAuthorizedLocked(binding)) {
			items = append(items, unallocatedCloudWorkspaceCleanup(binding))
		}
	}
	sort.Slice(items, func(i, j int) bool {
		return cloudProjectEarlier(items[i].UpdatedAt, items[i].ID, items[j].UpdatedAt, items[j].ID)
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *MemoryStore) CommitCloudWorkspaceCleanup(ctx context.Context, userID int64, id string, version int64, closed bool, errorCode string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if errorCode != "" && !cloudToolErrorCode.MatchString(errorCode) {
		return ErrCloudToolInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.cloudToolStateLocked()
	row, ok := state.observations[id]
	if !ok {
		binding, exists := state.workspaces[id]
		if !exists || binding.UserID != userID {
			return ErrNotFound
		}
		if binding.Version != version {
			return ErrCloudToolConflict
		}
		for _, other := range state.observations {
			if other.BindingID == id && other.State != CloudWorkspaceClosed {
				return ErrCloudToolConflict
			}
		}
		if closed {
			binding.State = CloudWorkspaceClosed
		}
		binding.Version++
		binding.UpdatedAt = s.now().UTC()
		state.workspaces[id] = binding
		return nil
	}
	if row.UserID != userID {
		return ErrNotFound
	}
	if row.Version != version {
		return ErrCloudToolConflict
	}
	if row.State == CloudWorkspaceClosed {
		return nil
	}
	if closed {
		row.State = CloudWorkspaceClosed
	} else {
		row.State = CloudWorkspaceCleanupPending
	}
	row.ErrorCode = errorCode
	row.Version++
	row.UpdatedAt = s.now().UTC()
	state.observations[id] = row
	if closed {
		allClosed := true
		for _, other := range state.observations {
			if other.BindingID == row.BindingID && other.State != CloudWorkspaceClosed {
				allClosed = false
			}
		}
		if allClosed {
			binding := state.workspaces[row.BindingID]
			binding.State = CloudWorkspaceClosed
			binding.Version++
			binding.UpdatedAt = s.now().UTC()
			state.workspaces[binding.ID] = binding
		}
	}
	return nil
}
