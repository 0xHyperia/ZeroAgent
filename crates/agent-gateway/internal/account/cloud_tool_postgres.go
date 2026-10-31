package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"

	"github.com/google/uuid"
)

const CloudToolSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_tool_operations (
 id UUID PRIMARY KEY,user_id BIGINT NOT NULL,conversation_id UUID NOT NULL,run_id UUID NOT NULL,
 call_key TEXT NOT NULL,name TEXT NOT NULL,request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),
 input JSONB NOT NULL CHECK(octet_length(input::text)<=4194304),
 state TEXT NOT NULL CHECK(state IN ('prepared','executing','succeeded','failed','cancelled','unknown')),
 result JSONB NULL,error_code TEXT NOT NULL DEFAULT '',execution_attempt BIGINT NOT NULL,
 version BIGINT NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(run_id,call_key),FOREIGN KEY(run_id,user_id) REFERENCES zeroagent_cloud_runs(id,user_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_tool_operations_run_idx ON zeroagent_cloud_tool_operations(user_id,run_id,created_at,id);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_workspaces (
 id UUID PRIMARY KEY,user_id BIGINT NOT NULL,conversation_id UUID NOT NULL,run_id UUID NOT NULL,
 lease_owner TEXT NOT NULL,execution_attempt BIGINT NOT NULL,create_operation_id UUID NOT NULL UNIQUE,
 owner_scope TEXT NOT NULL,workspace_ref TEXT NOT NULL,sandbox_id TEXT NOT NULL DEFAULT '',
 state TEXT NOT NULL CHECK(state IN ('prepared','ready','allocation_unknown','cleanup_pending','closed')),
 allocation_day DATE NOT NULL,reserved_seconds BIGINT NOT NULL CHECK(reserved_seconds BETWEEN 1 AND 3600),
 version BIGINT NOT NULL DEFAULT 1,started_at TIMESTAMPTZ NULL,expires_at TIMESTAMPTZ NULL,
 created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,UNIQUE(id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS zeroagent_cloud_workspaces_active_idx ON zeroagent_cloud_workspaces(user_id,conversation_id) WHERE state<>'closed';
CREATE INDEX IF NOT EXISTS zeroagent_cloud_workspaces_cleanup_idx ON zeroagent_cloud_workspaces(state,expires_at,updated_at);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_workspace_observations (
 id UUID PRIMARY KEY,user_id BIGINT NOT NULL,binding_id UUID NOT NULL,conversation_id UUID NOT NULL,
 create_operation_id UUID NOT NULL,cleanup_operation_id UUID NOT NULL UNIQUE,owner_scope TEXT NOT NULL,workspace_ref TEXT NOT NULL,
 sandbox_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('observed','cleanup_pending','closed')),
 error_code TEXT NOT NULL DEFAULT '',version BIGINT NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,
 UNIQUE(binding_id,sandbox_id),FOREIGN KEY(binding_id,user_id) REFERENCES zeroagent_cloud_workspaces(id,user_id)
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_workspace_observations_cleanup_idx ON zeroagent_cloud_workspace_observations(state,updated_at,id);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_tool_daily_budget (
 user_id BIGINT NOT NULL,allocation_day DATE NOT NULL,allocated_seconds BIGINT NOT NULL CHECK(allocated_seconds>=0),PRIMARY KEY(user_id,allocation_day)
);
CREATE OR REPLACE FUNCTION zeroagent_cloud_workspace_conversation_deleted() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE zeroagent_cloud_workspaces SET state='cleanup_pending',version=version+1,updated_at=clock_timestamp()
 WHERE conversation_id=OLD.id AND user_id=OLD.user_id AND state<>'closed';
 UPDATE zeroagent_cloud_workspace_observations o SET state='cleanup_pending',version=o.version+1,updated_at=clock_timestamp()
 WHERE o.conversation_id=OLD.id AND o.user_id=OLD.user_id AND o.state<>'closed';
 RETURN OLD;
END; $$;
DROP TRIGGER IF EXISTS zeroagent_cloud_workspace_conversation_deleted ON zerobox_cloud_conversations;
CREATE TRIGGER zeroagent_cloud_workspace_conversation_deleted AFTER DELETE ON zerobox_cloud_conversations
 FOR EACH ROW EXECUTE FUNCTION zeroagent_cloud_workspace_conversation_deleted();` + CloudAllocationSchema

const cloudToolColumns = `o.id::text,o.user_id,o.conversation_id::text,o.run_id::text,o.call_key,o.name,o.request_hash,o.input,o.state,o.result,o.error_code,o.execution_attempt,o.version,o.created_at,o.updated_at`
const cloudWorkspaceColumns = `w.id::text,w.user_id,w.conversation_id::text,w.run_id::text,w.lease_owner,w.execution_attempt,w.create_operation_id::text,w.owner_scope,w.workspace_ref,w.sandbox_id,w.state,w.allocation_day::text,w.reserved_seconds,w.version,w.started_at,w.expires_at,w.created_at,w.updated_at`
const cloudWorkspaceObservationColumns = `o.id::text,o.user_id,o.binding_id::text,o.conversation_id::text,o.create_operation_id::text,o.cleanup_operation_id::text,o.owner_scope,o.workspace_ref,o.sandbox_id,o.state,o.error_code,o.version,o.created_at,o.updated_at`

func scanCloudTool(row interface{ Scan(...any) error }) (*CloudToolOperation, error) {
	var op CloudToolOperation
	var input, result []byte
	err := row.Scan(&op.ID, &op.UserID, &op.ConversationID, &op.RunID, &op.CallKey, &op.Name, &op.RequestHash, &input, &op.State, &result, &op.ErrorCode, &op.ExecutionAttempt, &op.Version, &op.CreatedAt, &op.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	op.Input, op.Result = input, result
	return &op, nil
}

func scanCloudWorkspace(row interface{ Scan(...any) error }) (*CloudWorkspaceBinding, error) {
	var w CloudWorkspaceBinding
	var started, expires sql.NullTime
	err := row.Scan(&w.ID, &w.UserID, &w.ConversationID, &w.RunID, &w.LeaseOwner, &w.ExecutionAttempt, &w.CreateOperationID, &w.OwnerScope, &w.WorkspaceRef, &w.SandboxID, &w.State, &w.AllocationDay, &w.ReservedSeconds, &w.Version, &started, &expires, &w.CreatedAt, &w.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if started.Valid {
		w.StartedAt = started.Time
	}
	if expires.Valid {
		w.ExpiresAt = expires.Time
	}
	return &w, nil
}

func scanCloudWorkspaceObservation(row interface{ Scan(...any) error }) (*CloudWorkspaceCleanup, error) {
	var o CloudWorkspaceCleanup
	err := row.Scan(&o.ID, &o.UserID, &o.BindingID, &o.ConversationID, &o.CreateOperationID, &o.CleanupOperationID, &o.OwnerScope, &o.WorkspaceRef, &o.SandboxID, &o.State, &o.ErrorCode, &o.Version, &o.CreatedAt, &o.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &o, nil
}

func (s *PersistentStore) cloudToolRunTx(ctx context.Context, tx *sql.Tx, userID int64, runID, owner string, attempt int64, allowCancelling bool) (*CloudRun, error) {
	run, err := s.lockCloudRun(ctx, tx, userID, runID)
	if err != nil {
		return nil, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err = validateCloudRunLease(run, owner, attempt, now); err != nil {
		return nil, err
	}
	if !allowCancelling && run.State != CloudRunRunning {
		return nil, ErrCloudRunLeaseLost
	}
	return run, nil
}

func (s *PersistentStore) PrepareCloudTool(ctx context.Context, userID int64, runID, owner string, attempt int64, input *CloudToolOperation) (*CloudToolOperation, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	run, err := s.cloudToolRunTx(ctx, tx, userID, runID, owner, attempt, false)
	if err != nil {
		return nil, false, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, false, err
	}
	op, err := prepareCloudTool(input, userID, run, now)
	if err != nil {
		return nil, false, err
	}
	existing, err := scanCloudTool(tx.QueryRowContext(ctx, `SELECT `+cloudToolColumns+` FROM zeroagent_cloud_tool_operations o WHERE run_id=$1 AND call_key=$2`, run.ID, op.CallKey))
	if err == nil {
		if existing.RequestHash != op.RequestHash {
			return nil, false, ErrCloudToolConflict
		}
		if existing.ExecutionAttempt != attempt {
			return nil, false, ErrCloudRunLeaseLost
		}
		if err = tx.Commit(); err != nil {
			return nil, false, err
		}
		return existing, false, nil
	} else if !errors.Is(err, ErrNotFound) {
		return nil, false, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM zeroagent_cloud_tool_operations WHERE run_id=$1`, run.ID).Scan(&count); err != nil {
		return nil, false, err
	}
	if count >= CloudToolMaxRunOperations {
		return nil, false, ErrCloudToolQuota
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_tool_operations(id,user_id,conversation_id,run_id,call_key,name,request_hash,input,state,execution_attempt,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'prepared',$9,1,$10,$10)`, op.ID, userID, run.ConversationID, run.ID, op.CallKey, op.Name, op.RequestHash, []byte(op.Input), attempt, now)
	if err != nil {
		return nil, false, cloudProjectSQLError(err)
	}
	if err = tx.Commit(); err != nil {
		return nil, false, err
	}
	return op, true, nil
}

func (s *PersistentStore) GetCloudToolOperation(ctx context.Context, userID int64, id string) (*CloudToolOperation, error) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return nil, ErrCloudToolInvalid
	}
	return scanCloudTool(s.db.QueryRowContext(ctx, `SELECT `+cloudToolColumns+` FROM zeroagent_cloud_tool_operations o JOIN zeroagent_cloud_runs r ON r.id=o.run_id AND r.user_id=o.user_id JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=o.user_id WHERE o.id=$1 AND o.user_id=$2`, parsed.String(), userID))
}

func (s *PersistentStore) ListCloudToolOperations(ctx context.Context, userID int64, runID string, limit int) ([]CloudToolOperation, error) {
	if limit < 1 || limit > CloudToolMaxRunOperations {
		return nil, ErrCloudToolInvalid
	}
	run, err := s.GetCloudRun(ctx, userID, runID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+cloudToolColumns+` FROM zeroagent_cloud_tool_operations o WHERE user_id=$1 AND run_id=$2 ORDER BY created_at,id LIMIT $3`, userID, run.ID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CloudToolOperation{}
	for rows.Next() {
		op, err := scanCloudTool(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *op)
	}
	return items, rows.Err()
}

func (s *PersistentStore) lockCloudTool(ctx context.Context, tx *sql.Tx, userID int64, id, owner string, attempt int64, allowCancelling bool) (*CloudToolOperation, error) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return nil, ErrCloudToolInvalid
	}
	var runID string
	err = tx.QueryRowContext(ctx, `SELECT run_id::text FROM zeroagent_cloud_tool_operations WHERE id=$1 AND user_id=$2`, parsed.String(), userID).Scan(&runID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	if _, err = s.cloudToolRunTx(ctx, tx, userID, runID, owner, attempt, allowCancelling); err != nil {
		return nil, err
	}
	op, err := scanCloudTool(tx.QueryRowContext(ctx, `SELECT `+cloudToolColumns+` FROM zeroagent_cloud_tool_operations o WHERE id=$1 AND user_id=$2 FOR UPDATE`, parsed.String(), userID))
	if err != nil {
		return nil, err
	}
	if op.ExecutionAttempt != attempt {
		return nil, ErrCloudRunLeaseLost
	}
	return op, nil
}

func (s *PersistentStore) StartCloudTool(ctx context.Context, userID int64, id, owner string, attempt int64) (*CloudToolOperation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	op, err := s.lockCloudTool(ctx, tx, userID, id, owner, attempt, false)
	if err != nil {
		return nil, err
	}
	if op.State != CloudToolPrepared {
		return nil, ErrCloudToolConflict
	}
	op, err = scanCloudTool(tx.QueryRowContext(ctx, `UPDATE zeroagent_cloud_tool_operations o SET state='executing',version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING `+cloudToolColumns, op.ID))
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return op, nil
}

func (s *PersistentStore) CommitCloudTool(ctx context.Context, userID int64, id, owner string, attempt int64, state string, result json.RawMessage, errorCode string) (*CloudToolOperation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	op, err := s.lockCloudTool(ctx, tx, userID, id, owner, attempt, true)
	if err != nil {
		return nil, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	op, err = commitCloudTool(*op, state, result, errorCode, now)
	if err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_tool_operations SET state=$2,result=$3,error_code=$4,version=$5,updated_at=$6 WHERE id=$1`, op.ID, op.State, cloudRunNullableJSON(op.Result), op.ErrorCode, op.Version, op.UpdatedAt)
	if err != nil {
		return nil, err
	}
	if _, public := cloudPublicToolRound(op); public {
		var recorded bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_run_events WHERE run_id=$1 AND operation_id=$2)`, op.RunID, cloudToolPresentationOperationID(op)).Scan(&recorded); err != nil {
			return nil, err
		}
		if !recorded {
			run, readErr := scanCloudRun(tx.QueryRowContext(ctx, "SELECT "+cloudRunColumns+" FROM zeroagent_cloud_runs r WHERE r.id=$1 AND r.user_id=$2", op.RunID, userID))
			if readErr != nil {
				return nil, readErr
			}
			resources, readErr := cloudToolResourcesTx(ctx, tx, op)
			if readErr != nil {
				return nil, readErr
			}
			commit, hash, projectErr := prepareCloudToolPresentation(run, op, resources, op.UpdatedAt)
			if projectErr != nil {
				return nil, projectErr
			}
			if commit != nil {
				if err = appendCloudRunDBEvent(ctx, tx, run, commit.EventType, commit.Payload, commit.OperationID, hash, now); err != nil {
					return nil, err
				}
			}
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return op, nil
}

func (s *PersistentStore) GetCloudWorkspace(ctx context.Context, userID int64, conversationID string) (*CloudWorkspaceBinding, error) {
	conversationID, err := canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, ErrCloudToolInvalid
	}
	return scanCloudWorkspace(s.db.QueryRowContext(ctx, `SELECT `+cloudWorkspaceColumns+` FROM zeroagent_cloud_workspaces w JOIN zerobox_cloud_conversations c ON c.id=w.conversation_id AND c.user_id=w.user_id WHERE w.user_id=$1 AND w.conversation_id=$2 ORDER BY (w.state='closed'),w.created_at DESC,w.id DESC LIMIT 1`, userID, conversationID))
}

func (s *PersistentStore) ReserveCloudWorkspace(ctx context.Context, userID int64, runID, owner string, attempt, seconds, limit int64) (*CloudWorkspaceBinding, bool, error) {
	if !validCloudWorkspaceReservation(seconds, limit) {
		return nil, false, ErrCloudToolInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	run, err := s.cloudToolRunTx(ctx, tx, userID, runID, owner, attempt, false)
	if err != nil {
		return nil, false, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, false, err
	}
	current, err := scanCloudWorkspace(tx.QueryRowContext(ctx, `SELECT `+cloudWorkspaceColumns+` FROM zeroagent_cloud_workspaces w WHERE user_id=$1 AND conversation_id=$2 AND state<>'closed' ORDER BY created_at DESC,id DESC LIMIT 1 FOR UPDATE`, userID, run.ConversationID))
	if err == nil {
		if current.State == CloudWorkspaceReady && !current.ExpiresAt.After(now) {
			current.State = CloudWorkspaceCleanupPending
		}
		if err = tx.Commit(); err != nil {
			return nil, false, err
		}
		return current, false, nil
	} else if !errors.Is(err, ErrNotFound) {
		return nil, false, err
	}
	binding := newCloudWorkspace(run, seconds, now)
	if _, _, err = reserveCloudAllocationTx(ctx, tx, userID, binding.CreateOperationID, "conversation", seconds, limit, now); err != nil {
		return nil, false, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_workspaces(id,user_id,conversation_id,run_id,lease_owner,execution_attempt,create_operation_id,owner_scope,workspace_ref,state,allocation_day,reserved_seconds,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$13)`, binding.ID, userID, binding.ConversationID, binding.RunID, binding.LeaseOwner, binding.ExecutionAttempt, binding.CreateOperationID, binding.OwnerScope, binding.WorkspaceRef, binding.State, binding.AllocationDay, seconds, now)
	if err != nil {
		return nil, false, cloudProjectSQLError(err)
	}
	if err = tx.Commit(); err != nil {
		return nil, false, err
	}
	return binding, true, nil
}

func persistCloudWorkspace(ctx context.Context, tx *sql.Tx, w *CloudWorkspaceBinding) error {
	_, err := tx.ExecContext(ctx, `UPDATE zeroagent_cloud_workspaces SET sandbox_id=$2,state=$3,version=$4,started_at=$5,expires_at=$6,updated_at=$7 WHERE id=$1`, w.ID, w.SandboxID, w.State, w.Version, cloudRunNullableTime(w.StartedAt), cloudRunNullableTime(w.ExpiresAt), w.UpdatedAt)
	return err
}

func (s *PersistentStore) RecordCloudWorkspaceReceipt(ctx context.Context, userID int64, bindingID, operationID string, version int64, receipt CloudWorkspaceReceipt) (*CloudWorkspaceBinding, error) {
	if !validCloudWorkspaceReceipt(receipt) {
		return nil, ErrCloudToolInvalid
	}
	parsed, err := uuid.Parse(bindingID)
	if err != nil {
		return nil, ErrCloudToolInvalid
	}
	bindingID = parsed.String()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	initial, err := scanCloudWorkspace(tx.QueryRowContext(ctx, `SELECT `+cloudWorkspaceColumns+` FROM zeroagent_cloud_workspaces w WHERE id=$1 AND user_id=$2`, bindingID, userID))
	if err != nil {
		return nil, err
	}
	if initial.CreateOperationID != operationID {
		return nil, ErrNotFound
	}
	authorized := false
	_, authErr := s.cloudToolRunTx(ctx, tx, userID, initial.RunID, initial.LeaseOwner, initial.ExecutionAttempt, false)
	if authErr == nil {
		authorized = true
	} else if !errors.Is(authErr, ErrNotFound) && !errors.Is(authErr, ErrCloudRunLeaseLost) {
		return nil, authErr
	}
	binding, err := scanCloudWorkspace(tx.QueryRowContext(ctx, `SELECT `+cloudWorkspaceColumns+` FROM zeroagent_cloud_workspaces w WHERE id=$1 AND user_id=$2 FOR UPDATE`, bindingID, userID))
	if err != nil {
		return nil, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	updated, cleanup, conflict := applyCloudWorkspaceReceipt(*binding, version, receipt, authorized, now)
	if err = persistCloudWorkspace(ctx, tx, updated); err != nil {
		return nil, err
	}
	if receipt.SandboxID != "" {
		row := newCloudWorkspaceObservation(*updated, receipt.SandboxID, cleanup, now)
		_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_workspace_observations(id,user_id,binding_id,conversation_id,create_operation_id,cleanup_operation_id,owner_scope,workspace_ref,sandbox_id,state,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$11) ON CONFLICT(binding_id,sandbox_id) DO UPDATE SET state=CASE WHEN $12 AND zeroagent_cloud_workspace_observations.state<>'closed' THEN 'cleanup_pending' ELSE zeroagent_cloud_workspace_observations.state END,version=CASE WHEN $12 AND zeroagent_cloud_workspace_observations.state<>'closed' THEN zeroagent_cloud_workspace_observations.version+1 ELSE zeroagent_cloud_workspace_observations.version END,updated_at=CASE WHEN $12 AND zeroagent_cloud_workspace_observations.state<>'closed' THEN EXCLUDED.updated_at ELSE zeroagent_cloud_workspace_observations.updated_at END`, row.ID, userID, binding.ID, binding.ConversationID, operationID, row.CleanupOperationID, row.OwnerScope, row.WorkspaceRef, row.SandboxID, row.State, now, cleanup)
		if err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	if conflict {
		return updated, ErrCloudToolConflict
	}
	return updated, nil
}

func (s *PersistentStore) ListCloudWorkspaceCleanup(ctx context.Context, limit int) ([]CloudWorkspaceCleanup, error) {
	if limit < 1 || limit > 100 {
		return nil, ErrCloudToolInvalid
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+cloudWorkspaceObservationColumns+` FROM zeroagent_cloud_workspace_observations o JOIN zeroagent_cloud_workspaces w ON w.id=o.binding_id AND w.user_id=o.user_id LEFT JOIN zerobox_cloud_conversations c ON c.id=w.conversation_id AND c.user_id=w.user_id WHERE o.state<>'closed' AND (o.state='cleanup_pending' OR w.state='cleanup_pending' OR c.id IS NULL OR w.expires_at<=clock_timestamp()) ORDER BY o.updated_at,o.id LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	items := []CloudWorkspaceCleanup{}
	for rows.Next() {
		row, err := scanCloudWorkspaceObservation(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		row.State = CloudWorkspaceCleanupPending
		items = append(items, *row)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	rows, err = s.db.QueryContext(ctx, `SELECT `+cloudWorkspaceColumns+` FROM zeroagent_cloud_workspaces w LEFT JOIN zerobox_cloud_conversations c ON c.id=w.conversation_id AND c.user_id=w.user_id LEFT JOIN zeroagent_cloud_runs r ON r.id=w.run_id AND r.user_id=w.user_id WHERE w.state<>'closed' AND NOT EXISTS(SELECT 1 FROM zeroagent_cloud_workspace_observations o WHERE o.binding_id=w.id) AND (w.state='cleanup_pending' OR c.id IS NULL OR NOT COALESCE(r.state='running' AND r.lease_owner=w.lease_owner AND r.attempt=w.execution_attempt AND r.lease_until>clock_timestamp(),false)) ORDER BY w.updated_at,w.id LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		binding, err := scanCloudWorkspace(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		items = append(items, unallocatedCloudWorkspaceCleanup(*binding))
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	sort.Slice(items, func(i, j int) bool {
		return cloudProjectEarlier(items[i].UpdatedAt, items[i].ID, items[j].UpdatedAt, items[j].ID)
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *PersistentStore) CommitCloudWorkspaceCleanup(ctx context.Context, userID int64, id string, version int64, closed bool, errorCode string) error {
	if errorCode != "" && !cloudToolErrorCode.MatchString(errorCode) {
		return ErrCloudToolInvalid
	}
	parsed, err := uuid.Parse(id)
	if err != nil {
		return ErrCloudToolInvalid
	}
	id = parsed.String()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var bindingID string
	err = tx.QueryRowContext(ctx, `SELECT binding_id::text FROM zeroagent_cloud_workspace_observations WHERE id=$1 AND user_id=$2`, id, userID).Scan(&bindingID)
	synthetic := errors.Is(err, sql.ErrNoRows)
	if synthetic {
		bindingID = id
	} else if err != nil {
		return err
	}
	binding, err := scanCloudWorkspace(tx.QueryRowContext(ctx, `SELECT `+cloudWorkspaceColumns+` FROM zeroagent_cloud_workspaces w WHERE id=$1 AND user_id=$2 FOR UPDATE`, bindingID, userID))
	if err != nil {
		return err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return err
	}
	if synthetic {
		if binding.Version != version {
			return ErrCloudToolConflict
		}
		var active int
		if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM zeroagent_cloud_workspace_observations WHERE binding_id=$1 AND state<>'closed'`, bindingID).Scan(&active); err != nil {
			return err
		}
		if active > 0 {
			return ErrCloudToolConflict
		}
		if closed {
			binding.State = CloudWorkspaceClosed
		}
		binding.Version++
		binding.UpdatedAt = now
		if err = persistCloudWorkspace(ctx, tx, binding); err != nil {
			return err
		}
		return tx.Commit()
	}
	row, err := scanCloudWorkspaceObservation(tx.QueryRowContext(ctx, `SELECT `+cloudWorkspaceObservationColumns+` FROM zeroagent_cloud_workspace_observations o WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, userID))
	if err != nil {
		return err
	}
	if row.Version != version {
		return ErrCloudToolConflict
	}
	if row.State == CloudWorkspaceClosed {
		return tx.Commit()
	}
	state := CloudWorkspaceCleanupPending
	if closed {
		state = CloudWorkspaceClosed
	}
	if _, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_workspace_observations SET state=$2,error_code=$3,version=version+1,updated_at=$4 WHERE id=$1`, id, state, errorCode, now); err != nil {
		return err
	}
	if closed {
		var count int
		if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM zeroagent_cloud_workspace_observations WHERE binding_id=$1 AND state<>'closed'`, binding.ID).Scan(&count); err != nil {
			return err
		}
		if count == 0 {
			binding.State = CloudWorkspaceClosed
			binding.Version++
			binding.UpdatedAt = now
			if err = persistCloudWorkspace(ctx, tx, binding); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}
