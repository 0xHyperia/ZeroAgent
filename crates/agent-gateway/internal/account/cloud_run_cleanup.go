package account

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

func (r *cloudRunRuntime) cleanupWorker() {
	defer r.wg.Done()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-ticker.C:
			client := r.service.CloudExecutor()
			store, ok := r.service.store.(CloudToolStore)
			if client == nil || !ok {
				continue
			}
			ctx, cancel := context.WithTimeout(r.ctx, 10*time.Second)
			items, err := store.ListCloudWorkspaceCleanup(ctx, 16)
			if err == nil && len(items) > 0 {
				health, healthErr := client.Health(ctx)
				if healthErr == nil && health.Enabled {
					for _, item := range items {
						if ctx.Err() != nil {
							break
						}
						if r.service.now().Sub(item.UpdatedAt) < 30*time.Second {
							continue
						}
						r.cleanupWorkspace(ctx, client, store, item)
					}
				}
			}
			cancel()
		}
	}
}

func (r *cloudRunRuntime) cleanupWorkspace(ctx context.Context, client *cloudexecutor.Client, store CloudToolStore, item CloudWorkspaceCleanup) {
	scope := cloudexecutor.Scope{OwnerScope: item.OwnerScope, WorkspaceRef: item.WorkspaceRef}
	if item.SandboxID == "" {
		// Never Submit the original create again, including after adapter restart.
		receipt, err := client.Get(ctx, item.CreateOperationID, scope)
		candidates := []json.RawMessage{}
		if err == nil && len(receipt.Result) > 0 {
			var existing struct {
				SandboxID string `json:"sandbox_id"`
			}
			if json.Unmarshal(receipt.Result, &existing) == nil && existing.SandboxID != "" {
				candidates = append(candidates, receipt.Result)
			}
		}
		if len(candidates) == 0 {
			// Each read-only metadata observation may use a new query ID; the
			// original allocation identity remains immutable and is never retried.
			query, queryErr := client.Execute(ctx, cloudexecutor.Operation{OperationID: fmt.Sprintf("reconcile-%s-%d", item.BindingID, item.Version), OwnerScope: item.OwnerScope, WorkspaceRef: item.WorkspaceRef, Action: "sandbox.reconcile", Input: map[string]any{"create_operation_id": item.CreateOperationID}})
			if queryErr == nil && query.State == cloudexecutor.StateSucceeded {
				var result struct {
					CreateOperationID  string            `json:"create_operation_id"`
					Candidates         []json.RawMessage `json:"candidates"`
					CleanupOnly        bool              `json:"cleanup_only"`
					AutomaticRetrySafe *bool             `json:"automatic_retry_safe"`
				}
				if json.Unmarshal(query.Result, &result) == nil && result.CleanupOnly && result.AutomaticRetrySafe != nil && !*result.AutomaticRetrySafe && result.CreateOperationID == item.CreateOperationID && len(result.Candidates) <= 20 {
					candidates = result.Candidates
				}
			}
		}
		version := item.Version
		for _, candidate := range candidates {
			var info cloudWorkspaceSDKInfo
			if json.Unmarshal(candidate, &info) != nil || !cloudToolIdentifier.MatchString(info.SandboxID) {
				continue
			}
			binding, _ := store.RecordCloudWorkspaceReceipt(ctx, item.UserID, item.BindingID, item.CreateOperationID, version, CloudWorkspaceReceipt{SandboxID: info.SandboxID, State: CloudWorkspaceUnknown, StartedAt: info.StartedAt, ExpiresAt: info.ExpiresAt})
			if binding != nil {
				version = binding.Version
			}
		}
		if len(candidates) > 0 {
			next, err := store.RequestCloudWorkspaceCleanup(ctx, item.UserID, item.BindingID)
			if err == nil {
				for _, row := range next {
					if row.SandboxID != "" {
						r.cleanupWorkspace(ctx, client, store, row)
					}
				}
			}
			return
		}
		// An empty eventually-consistent listing is not proof of no allocation.
		_ = store.CommitCloudWorkspaceCleanup(ctx, item.UserID, item.ID, item.Version, false, "allocation_unknown")
		return
	}
	receipt, err := client.Execute(ctx, cloudexecutor.Operation{OperationID: item.CleanupOperationID, OwnerScope: item.OwnerScope, WorkspaceRef: item.WorkspaceRef, Action: "sandbox.kill", SandboxID: item.SandboxID})
	var result struct {
		SandboxID  string `json:"sandbox_id"`
		Terminated bool   `json:"sandbox_terminated"`
	}
	closed := err == nil && receipt.State == cloudexecutor.StateSucceeded && json.Unmarshal(receipt.Result, &result) == nil && result.SandboxID == item.SandboxID && result.Terminated
	code := ""
	if !closed {
		code = "cleanup_unknown"
	}
	if store.CommitCloudWorkspaceCleanup(ctx, item.UserID, item.ID, item.Version, closed, code) == nil && closed {
		acknowledgeCloudSDKReceipt(ctx, client, receipt, scope)
	}
}
