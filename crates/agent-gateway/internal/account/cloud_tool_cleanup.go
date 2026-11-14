package account

import (
	"context"
	"sort"
)

// Marking a VM for termination is a private safety operation, not authority to
// start work. It remains possible after the owning Run/lease/history is gone.
func (s *MemoryStore) RequestCloudWorkspaceCleanup(ctx context.Context, userID int64, bindingID string) ([]CloudWorkspaceCleanup, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.cloudToolStateLocked()
	binding, exists := state.workspaces[bindingID]
	if !exists || binding.UserID != userID {
		return nil, ErrNotFound
	}
	if binding.State != CloudWorkspaceClosed && binding.State != CloudWorkspaceCleanupPending {
		binding.State = CloudWorkspaceCleanupPending
		binding.Version++
		binding.UpdatedAt = s.now().UTC()
		state.workspaces[bindingID] = binding
	}
	items := []CloudWorkspaceCleanup{}
	observations := 0
	for id, row := range state.observations {
		if row.BindingID != bindingID {
			continue
		}
		observations++
		if row.State == CloudWorkspaceClosed {
			continue
		}
		if row.State != CloudWorkspaceCleanupPending {
			row.State = CloudWorkspaceCleanupPending
			row.Version++
			row.UpdatedAt = s.now().UTC()
			state.observations[id] = row
		}
		items = append(items, row)
	}
	if observations == 0 && binding.State != CloudWorkspaceClosed {
		items = append(items, unallocatedCloudWorkspaceCleanup(binding))
	}
	sortCloudCleanup(items, binding.SandboxID)
	if len(items) > 100 {
		items = items[:100]
	}
	return items, nil
}

func sortCloudCleanup(items []CloudWorkspaceCleanup, canonical string) {
	sort.Slice(items, func(i, j int) bool {
		if (items[i].SandboxID == canonical) != (items[j].SandboxID == canonical) {
			return items[i].SandboxID == canonical
		}
		return cloudProjectEarlier(items[i].CreatedAt, items[i].ID, items[j].CreatedAt, items[j].ID)
	})
}

func (s *PersistentStore) RequestCloudWorkspaceCleanup(ctx context.Context, userID int64, bindingID string) ([]CloudWorkspaceCleanup, error) {
	id, err := canonicalCloudRunID(bindingID)
	if err != nil {
		return nil, ErrCloudToolInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	binding, err := scanCloudWorkspace(tx.QueryRowContext(ctx, `SELECT `+cloudWorkspaceColumns+` FROM zeroagent_cloud_workspaces w WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, userID))
	if err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_workspaces SET state='cleanup_pending',version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND state NOT IN ('closed','cleanup_pending')`, id); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_workspace_observations SET state='cleanup_pending',version=version+1,updated_at=clock_timestamp() WHERE binding_id=$1 AND state NOT IN ('closed','cleanup_pending')`, id); err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT `+cloudWorkspaceObservationColumns+` FROM zeroagent_cloud_workspace_observations o WHERE binding_id=$1 AND state<>'closed' ORDER BY (sandbox_id=$2) DESC,created_at,id LIMIT 100`, id, binding.SandboxID)
	if err != nil {
		return nil, err
	}
	items := []CloudWorkspaceCleanup{}
	for rows.Next() {
		row, err := scanCloudWorkspaceObservation(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		items = append(items, *row)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	if len(items) == 0 && binding.State != CloudWorkspaceClosed {
		var count int
		if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM zeroagent_cloud_workspace_observations WHERE binding_id=$1`, id).Scan(&count); err != nil {
			return nil, err
		}
		if count == 0 {
			binding, err = scanCloudWorkspace(tx.QueryRowContext(ctx, `SELECT `+cloudWorkspaceColumns+` FROM zeroagent_cloud_workspaces w WHERE id=$1`, id))
			if err != nil {
				return nil, err
			}
			items = append(items, unallocatedCloudWorkspaceCleanup(*binding))
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return items, nil
}
