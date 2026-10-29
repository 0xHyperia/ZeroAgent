package account

import (
	"context"
	"database/sql"
	"errors"
)

const cloudCancellationOutcomeUnknown = "cloud_cancellation_outcome_unknown"
const cloudCancellationOutcomeNotice = "任务已停止，但远端执行结果或工作区结束状态尚未确认；已保留内容，请勿直接重试可能已执行的操作。"

// These are private metadata reads, not execution grants. In particular they
// never materialize the potentially large operation Input/Result JSON bodies.
type cloudRunCancellationStore interface {
	HasUncertainCloudRunOperations(context.Context, int64, string) (bool, error)
	GetCloudRunCancellationWorkspace(context.Context, int64, string, string) (*CloudWorkspaceBinding, error)
}

type cloudRunExecutionFacts struct {
	workspace        *CloudWorkspaceBinding
	cleanupAttempted bool
}

func (s *MemoryStore) HasUncertainCloudRunOperations(ctx context.Context, uid int64, runID string) (bool, error) {
	if err := ctx.Err(); err != nil {
		return false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if _, err := s.cloudRunLocked(uid, runID); err != nil {
		return false, err
	}
	if s.cloudTools != nil {
		for _, operation := range s.cloudTools.operations {
			if operation.UserID == uid && operation.RunID == runID && (operation.State == CloudToolExecuting || operation.State == CloudToolUnknown) {
				return true, nil
			}
		}
	}
	return false, nil
}

func (s *PersistentStore) HasUncertainCloudRunOperations(ctx context.Context, uid int64, runID string) (bool, error) {
	runID, err := canonicalCloudRunID(runID)
	if err != nil {
		return false, err
	}
	var uncertain bool
	err = s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_tool_operations o WHERE o.user_id=r.user_id AND o.run_id=r.id AND o.state IN ('executing','unknown')) FROM zeroagent_cloud_runs r JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.id=$1 AND r.user_id=$2`, runID, uid).Scan(&uncertain)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return uncertain, err
}

func (s *MemoryStore) GetCloudRunCancellationWorkspace(ctx context.Context, uid int64, runID, workspaceID string) (*CloudWorkspaceBinding, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	run, err := s.cloudRunLocked(uid, runID)
	if err != nil {
		return nil, err
	}
	if s.cloudTools != nil {
		binding, ok := s.cloudTools.workspaces[workspaceID]
		if ok && binding.UserID == uid && binding.ConversationID == run.ConversationID {
			return &binding, nil
		}
	}
	return nil, ErrNotFound
}

func (s *PersistentStore) GetCloudRunCancellationWorkspace(ctx context.Context, uid int64, runID, workspaceID string) (*CloudWorkspaceBinding, error) {
	runID, err := canonicalCloudRunID(runID)
	if err != nil {
		return nil, err
	}
	workspaceID, err = canonicalCloudRunID(workspaceID)
	if err != nil {
		return nil, err
	}
	return scanCloudWorkspace(s.db.QueryRowContext(ctx, `SELECT `+cloudWorkspaceColumns+` FROM zeroagent_cloud_workspaces w JOIN zeroagent_cloud_runs r ON r.user_id=w.user_id AND r.conversation_id=w.conversation_id JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.id=$1 AND r.user_id=$2 AND w.id=$3`, runID, uid, workspaceID))
}

func (r *cloudRunRuntime) cancelledOutcome(ctx context.Context, run *CloudRun, facts *cloudRunExecutionFacts) (string, string) {
	unknown := func() (string, string) { return CloudRunInterrupted, cloudCancellationOutcomeUnknown }
	store, ok := r.store.(cloudRunCancellationStore)
	if !ok {
		return unknown()
	}
	// Only the exact workspace used by this execution is relevant. A different
	// conversation/account's pending cleanup must never affect this task.
	if facts.workspace != nil {
		binding, err := store.GetCloudRunCancellationWorkspace(ctx, run.UserID, run.ID, facts.workspace.ID)
		if err != nil {
			return unknown()
		}
		if binding.State != CloudWorkspaceClosed && !facts.cleanupAttempted {
			tools, ok := r.store.(CloudToolStore)
			if !ok {
				return unknown()
			}
			execution := &cloudRunToolExecution{runtime: r, run: run, store: tools, client: r.service.CloudExecutor(), workspace: binding}
			execution.cleanup(ctx)
			facts.cleanupAttempted = true
			binding, err = store.GetCloudRunCancellationWorkspace(ctx, run.UserID, run.ID, binding.ID)
			if err != nil {
				return unknown()
			}
		}
		if binding.State != CloudWorkspaceClosed {
			return unknown()
		}
	}
	uncertain, err := store.HasUncertainCloudRunOperations(ctx, run.UserID, run.ID)
	if err != nil || uncertain {
		return unknown()
	}
	return CloudRunCancelled, ""
}
