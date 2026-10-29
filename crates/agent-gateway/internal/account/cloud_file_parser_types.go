package account

import (
	"context"
	"encoding/json"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

type CloudFileSegment struct {
	ID      string           `json:"id"`
	Locator CloudFileLocator `json:"locator"`
	Text    string           `json:"text"`
}
type CloudFileLocator struct {
	Page       int    `json:"page,omitempty"`
	Part       string `json:"part,omitempty"`
	Paragraph  int    `json:"paragraph,omitempty"`
	Sheet      string `json:"sheet,omitempty"`
	SheetIndex int    `json:"sheet_index,omitempty"`
	Cell       string `json:"cell,omitempty"`
	Slide      int    `json:"slide,omitempty"`
	CharStart  int    `json:"char_start"`
}

// ParseTask and operation receipts are private durable execution facts, never
// credential storage or public events. One task owns one independent VM.
type CloudFileParseTask struct {
	ID                   string                             `json:"id"`
	FileID               string                             `json:"file_id"`
	SourceSHA256         string                             `json:"source_sha256"`
	OwnerScope           string                             `json:"owner_scope"`
	WorkspaceRef         string                             `json:"workspace_ref"`
	State                string                             `json:"state"`
	Stage                string                             `json:"stage"`
	LeaseOwner           string                             `json:"lease_owner"`
	LeaseUntil           time.Time                          `json:"lease_until"`
	SandboxID            string                             `json:"sandbox_id,omitempty"`
	CleanupSandboxIDs    []string                           `json:"cleanup_sandbox_ids,omitempty"`
	ReconcileOperationID string                             `json:"reconcile_operation_id,omitempty"`
	ReconcileReceipt     cloudexecutor.Receipt              `json:"reconcile_receipt,omitempty"`
	ReconcileAfter       time.Time                          `json:"reconcile_after,omitempty"`
	VMStopped            bool                               `json:"vm_stopped"`
	Truncated            bool                               `json:"truncated"`
	Warnings             []string                           `json:"warnings,omitempty"`
	Operations           map[string]CloudFileParseOperation `json:"operations"`
}
type CloudFileParseOperation struct {
	RequestHash string                `json:"request_hash"`
	Receipt     cloudexecutor.Receipt `json:"receipt"`
	Dispatched  bool                  `json:"dispatched"`
}
type CloudFileParserStore interface {
	ListCloudFileParserCandidates(context.Context, int) ([]CloudFile, error)
}

func cloneCloudFileParse(task *CloudFileParseTask) *CloudFileParseTask {
	if task == nil {
		return nil
	}
	encoded, _ := json.Marshal(task)
	var copy CloudFileParseTask
	_ = json.Unmarshal(encoded, &copy)
	return &copy
}
func redactCloudFileTaskBytes(task *CloudFileParseTask) {
	if task == nil {
		return
	}
	for id, operation := range task.Operations {
		if operation.Receipt.Action == "file.download.chunk" {
			var result map[string]any
			if json.Unmarshal(operation.Receipt.Result, &result) == nil {
				delete(result, "data_base64")
				operation.Receipt.Result, _ = json.Marshal(result)
			}
			task.Operations[id] = operation
		}
	}
}
