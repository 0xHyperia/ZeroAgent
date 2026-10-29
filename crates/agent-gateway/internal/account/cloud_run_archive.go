package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

// The source digest is derived by the owned guest, never from model arguments.
// Both inspection and extraction have stable, fenced operation identities.
func (e *cloudRunToolExecution) executeArchive(ctx context.Context, round int, call cloudModelToolCall, op *CloudToolOperation, binding *CloudWorkspaceBinding, path, destination string) (json.RawMessage, error) {
	scope := cloudexecutor.Scope{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef}
	if destination == "" {
		destination = "extract-" + op.ID
	}
	inspected, _, err := e.prepare(ctx, fmt.Sprintf("archive:%s:inspect", op.ID), "file.inspect", map[string]any{"path": path}, "")
	if err != nil {
		return nil, err
	}
	inspector := e.client.WithOperationRunner(func(stepCtx context.Context, operation cloudexecutor.Operation) (cloudexecutor.Receipt, error) {
		receipt, err := e.sdk(stepCtx, inspected, operation)
		if err != nil {
			failure, ok := err.(*cloudToolRunError)
			if !ok {
				failure = sdkCloudToolError(err)
			}
			state := CloudToolFailed
			if failure.unknown {
				state = CloudToolUnknown
			}
			_ = e.commit(stepCtx, inspected, state, nil, failure.code)
			return receipt, err
		}
		if !receipt.Terminal() || receipt.State == cloudexecutor.StateUnknown {
			return receipt, &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true}
		}
		if err = e.commit(stepCtx, inspected, receipt.State, receipt.Result, ""); err != nil {
			return receipt, err
		}
		acknowledgeCloudSDKReceipt(stepCtx, e.client, receipt, scope)
		return receipt, nil
	})
	info, _, err := inspector.InspectFile(ctx, inspected.ID, scope, binding.SandboxID, path)
	if err == nil && (info.Size < 1 || info.Size > cloudexecutor.MaxTransferBytes) {
		err = &cloudToolRunError{code: "cloud_archive_invalid"}
	}
	if err != nil {
		return nil, e.failArchive(ctx, op, call, round, err)
	}
	extraction, _, err := e.prepare(ctx, fmt.Sprintf("archive:%s:extract", op.ID), "archive.extract", map[string]any{"path": path, "destination": destination, "source_sha256": info.SHA256}, "")
	if err != nil {
		return nil, err
	}
	if op.State == CloudToolPrepared {
		if _, err = e.store.StartCloudTool(ctx, e.run.UserID, op.ID, e.owner, e.run.Attempt); err != nil {
			return nil, err
		}
	} else if extraction.State == CloudToolPrepared {
		// An uncertain parent never creates a new external effect, even if the
		// child was only prepared when an earlier invocation lost authority.
		return nil, e.failArchive(ctx, op, call, round, &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true})
	}
	executor := e.client.WithOperationRunner(func(stepCtx context.Context, operation cloudexecutor.Operation) (cloudexecutor.Receipt, error) {
		return e.sdk(stepCtx, extraction, operation, func() error { return e.emit(stepCtx, op, call, round, "started") })
	})
	result, receipt, err := executor.ExtractArchive(ctx, cloudexecutor.ArchiveExtractSpec{Scope: scope, OperationID: extraction.ID, SandboxID: binding.SandboxID, Path: path, Destination: destination, SourceSHA256: info.SHA256})
	if err != nil {
		failure, ok := err.(*cloudToolRunError)
		if !ok {
			failure = sdkCloudToolError(err)
		}
		state := CloudToolFailed
		if failure.unknown {
			state = CloudToolUnknown
		}
		if commitErr := e.commit(ctx, extraction, state, nil, failure.code); commitErr != nil {
			return nil, commitErr
		}
		return nil, e.failArchive(ctx, op, call, round, err)
	}
	if e.hasSecret(receipt.Result) {
		if commitErr := e.commit(ctx, extraction, CloudToolFailed, nil, "model_secret_reflection"); commitErr != nil {
			return nil, commitErr
		}
		return nil, e.failArchive(ctx, op, call, round, &cloudToolRunError{code: "model_secret_reflection"})
	}
	// Keep the complete validated private manifest before retiring the SDK
	// receipt. The semantic parent remains bounded for model/replay consumption.
	if err = e.commit(ctx, extraction, CloudToolSucceeded, receipt.Result, ""); err != nil {
		return nil, err
	}
	output := cloudArchiveModelResult(result)
	if err = e.commit(ctx, op, CloudToolSucceeded, output, ""); err != nil {
		return nil, err
	}
	acknowledgeCloudSDKReceipt(ctx, e.client, receipt, scope)
	if err = e.emit(ctx, op, call, round, "completed"); err != nil {
		return nil, err
	}
	return output, nil
}

// The SDK validates the entire manifest. Its model projection has a separate
// budget and explicitly identifies an abbreviated listing, not partial extraction.
func cloudArchiveModelResult(result cloudexecutor.ArchiveExtractResult) json.RawMessage {
	digest := sha256.Sum256(cloudJSON(result.Files))
	files := result.Files
	clean := map[string]any{"status": cloudexecutor.StateSucceeded, "temporary_workspace": true, "durable": false, "source_sha256": result.SourceSHA256, "destination": result.Destination, "file_count": result.FileCount, "total_bytes": result.TotalBytes, "manifest_sha256": hex.EncodeToString(digest[:]), "files": files, "manifest_truncated": false}
	for len(cloudJSON(clean)) > cloudToolResultBytes && len(files) > 0 {
		files = files[:len(files)-1]
		clean["files"], clean["manifest_truncated"] = files, true
	}
	return cloudJSON(clean)
}

func (e *cloudRunToolExecution) failArchive(ctx context.Context, op *CloudToolOperation, call cloudModelToolCall, round int, err error) error {
	failure, ok := err.(*cloudToolRunError)
	if !ok {
		failure = sdkCloudToolError(err)
	}
	state, event := CloudToolFailed, "failed"
	if failure.unknown {
		state, event = CloudToolUnknown, "unknown"
	}
	if commitErr := e.commit(ctx, op, state, nil, failure.code); commitErr != nil {
		return commitErr
	}
	_ = e.emit(context.WithoutCancel(ctx), op, call, round, event)
	return failure
}
