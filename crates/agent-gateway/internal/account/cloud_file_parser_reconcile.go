package account

import (
	"context"
	"encoding/json"
	"strconv"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

const cloudParserMaxCleanupSandboxes = 20

func validCloudParserCleanupIDs(ids []string) bool {
	if len(ids) > cloudParserMaxCleanupSandboxes {
		return false
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if !cloudToolIdentifier.MatchString(id) || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func cloudParserUnknownCreate(task *CloudFileParseTask) error {
	return &cloudexecutor.UnknownOutcomeError{Receipt: cloudexecutor.Receipt{OperationID: parserOperationID(task.ID, "create"), Action: "sandbox.create", State: cloudexecutor.StateUnknown}}
}

// Reconciliation observes the original allocation identity. It cannot allocate
// a replacement, and an empty eventually-consistent listing proves nothing.
// Keep only the latest read-only query fact; all observed VM identities and
// stable destructive-operation facts remain in the task until cleanup ends.
func (e *fileParseExecution) reconcileSandboxes(ctx context.Context, file *CloudFile) (*CloudFile, error) {
	task := file.ParseTask
	if task.ReconcileAfter.After(time.Now()) {
		return nil, cloudParserUnknownCreate(task)
	}
	createID := parserOperationID(task.ID, "create")
	queryID := parserOperationID(task.ID, "reconcile:"+strconv.FormatInt(file.Version, 10))
	operation := cloudexecutor.Operation{OperationID: queryID, OwnerScope: task.OwnerScope, WorkspaceRef: task.WorkspaceRef, Action: "sandbox.reconcile", Input: map[string]any{"create_operation_id": createID}}
	_, err := e.persist(ctx, func(task *CloudFileParseTask) {
		task.ReconcileOperationID = queryID
		task.ReconcileReceipt = cloudexecutor.Receipt{OperationID: queryID, Action: operation.Action, State: cloudexecutor.StateExecuting}
		task.ReconcileAfter = time.Now().Add(30 * time.Second)
	})
	if err != nil {
		return nil, err
	}
	receipt, queryErr := e.parser.client.Execute(ctx, operation)
	if receipt.OperationID == "" {
		receipt = cloudexecutor.Receipt{OperationID: queryID, Action: operation.Action, State: cloudexecutor.StateUnknown}
	}
	var result struct {
		CreateOperationID  string `json:"create_operation_id"`
		CleanupOnly        *bool  `json:"cleanup_only"`
		AutomaticRetrySafe *bool  `json:"automatic_retry_safe"`
		Candidates         []struct {
			SandboxID string `json:"sandbox_id"`
		} `json:"candidates"`
	}
	// The strongly authenticated SDK query checks signed owner/workspace and
	// original-create metadata. Its explicit cleanup-only result permits killing
	// owned VMs even if their network/envd policy drifted. It never authorizes
	// file/code execution, resume, or a replacement allocation.
	valid := queryErr == nil && receipt.OperationID == queryID && receipt.Action == operation.Action && receipt.State == cloudexecutor.StateSucceeded && json.Unmarshal(receipt.Result, &result) == nil && result.CreateOperationID == createID && result.CleanupOnly != nil && *result.CleanupOnly && result.AutomaticRetrySafe != nil && !*result.AutomaticRetrySafe && len(result.Candidates) <= cloudParserMaxCleanupSandboxes
	ids := append([]string(nil), task.CleanupSandboxIDs...)
	seen := map[string]bool{}
	for _, id := range ids {
		seen[id] = true
	}
	if valid {
		for _, candidate := range result.Candidates {
			if !cloudToolIdentifier.MatchString(candidate.SandboxID) {
				valid = false
				break
			}
			if !seen[candidate.SandboxID] {
				ids = append(ids, candidate.SandboxID)
				seen[candidate.SandboxID] = true
			}
		}
		valid = valid && validCloudParserCleanupIDs(ids)
	}
	checkpointCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	updated, saveErr := e.persist(checkpointCtx, func(task *CloudFileParseTask) {
		task.ReconcileReceipt = receipt
		if valid && len(result.Candidates) > 0 {
			task.CleanupSandboxIDs = ids
			if task.SandboxID == "" {
				task.SandboxID = ids[0]
			}
		}
	})
	if saveErr != nil {
		return nil, saveErr
	}
	acknowledgeCloudSDKReceipt(ctx, e.parser.client, receipt, operation.Scope())
	if !valid || len(result.Candidates) == 0 {
		return nil, cloudParserUnknownCreate(task)
	}
	return updated, nil
}
