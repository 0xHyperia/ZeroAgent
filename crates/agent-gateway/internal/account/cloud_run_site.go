package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

func (e *cloudRunToolExecution) siteFailure(ctx context.Context, op *CloudToolOperation, call cloudModelToolCall, round int, err error) error {
	failure := sdkCloudToolError(err)
	var tool *cloudToolRunError
	if errors.As(err, &tool) {
		copy := *tool
		failure = &copy
	}
	if !failure.unknown {
		failure.code = "cloud_site_publication_failed"
	} else {
		failure.code = "cloud_site_publication_unknown"
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

func (e *cloudRunToolExecution) executeSite(ctx context.Context, round int, call cloudModelToolCall, op *CloudToolOperation, binding *CloudWorkspaceBinding, path, name, familyID string) (json.RawMessage, error) {
	if op.State != CloudToolPrepared {
		return nil, &cloudToolRunError{code: "cloud_site_publication_unknown", unknown: true}
	}
	p, err := e.runtime.service.siteProvider()
	if err != nil {
		return nil, e.siteFailure(ctx, op, call, round, err)
	}
	output := cloudexecutor.SiteBundlePath(op.ID)
	child, _, err := e.prepare(ctx, fmt.Sprintf("site:%s:bundle", op.ID), "site.bundle", map[string]any{"path": path, "output_path": output}, "")
	if err != nil {
		return nil, err
	}
	if child.State != CloudToolPrepared {
		return nil, e.siteFailure(ctx, op, call, round, &cloudexecutor.UnknownOutcomeError{Receipt: cloudexecutor.Receipt{OperationID: child.ID, Action: "site.bundle", State: cloudexecutor.StateUnknown}})
	}
	if _, err = e.store.StartCloudTool(ctx, e.run.UserID, op.ID, e.owner, e.run.Attempt); err != nil {
		return nil, err
	}
	scope := cloudexecutor.Scope{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef}
	client := e.client.WithOperationRunner(func(stepCtx context.Context, operation cloudexecutor.Operation) (cloudexecutor.Receipt, error) {
		return e.sdk(stepCtx, child, operation, func() error { return e.emit(stepCtx, op, call, round, "started") })
	})
	bundle, receipt, err := client.BundleSite(ctx, cloudexecutor.SiteBundleSpec{Scope: scope, OperationID: child.ID, SandboxID: binding.SandboxID, Path: path, OutputPath: output})
	if err != nil {
		failure := sdkCloudToolError(err)
		var tool *cloudToolRunError
		if errors.As(err, &tool) {
			failure = tool
		}
		state := CloudToolFailed
		if failure.unknown {
			state = CloudToolUnknown
		}
		if commitErr := e.commit(ctx, child, state, nil, failure.code); commitErr != nil {
			return nil, commitErr
		}
		return nil, e.siteFailure(ctx, op, call, round, err)
	}
	if e.hasSecret(receipt.Result) {
		if err = e.commit(ctx, child, CloudToolFailed, nil, "model_secret_reflection"); err != nil {
			return nil, err
		}
		return nil, e.siteFailure(ctx, op, call, round, &cloudToolRunError{code: "model_secret_reflection"})
	}
	if err = e.commit(ctx, child, CloudToolSucceeded, receipt.Result, ""); err != nil {
		return nil, err
	}
	acknowledgeCloudSDKReceipt(ctx, e.client, receipt, scope)
	if _, err = e.authorize(ctx); err != nil {
		return nil, err
	}
	artifact, err := e.runtime.service.PublishCloudArtifact(ctx, e.run.UserID, CloudArtifactPublication{ConversationID: e.run.ConversationID, RunID: e.run.ID, ToolOperationID: op.ID, LeaseOwner: e.owner, ExecutionAttempt: e.run.Attempt, FamilyID: familyID, Name: name, MIME: "application/zip", WorkspaceRef: binding.WorkspaceRef, SandboxID: binding.SandboxID, Path: output, Size: bundle.Size, SHA256: bundle.SHA256, SiteSourcePath: path})
	if err != nil {
		// A returned error is not proof that a database commit or object write
		// failed. Inspect the original publication identity, never republish it.
		check, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		store, storeErr := e.runtime.service.artifactStore()
		if storeErr == nil {
			current, readErr := store.GetCloudArtifactByOperation(check, e.run.UserID, op.ID)
			if readErr != nil && !errors.Is(readErr, ErrNotFound) || readErr == nil && (current.State == CloudArtifactReady || current.State == CloudArtifactStaging || current.State == CloudArtifactUnknown) {
				err = errors.Join(err, &cloudexecutor.UnknownOutcomeError{Receipt: cloudexecutor.Receipt{OperationID: op.ID, State: cloudexecutor.StateUnknown}})
			}
		}
		cancel()
		return nil, e.siteFailure(ctx, op, call, round, err)
	}
	if artifact == nil || artifact.State != CloudArtifactReady || artifact.DownloadPath == "" {
		return nil, e.siteFailure(ctx, op, call, round, &cloudexecutor.UnknownOutcomeError{Receipt: cloudexecutor.Receipt{OperationID: op.ID, State: cloudexecutor.StateUnknown}})
	}
	release, err := p.store.GetCloudSiteRelease(ctx, e.run.UserID, artifact.ID)
	if err != nil {
		return nil, e.siteFailure(ctx, op, call, round, errors.Join(err, &cloudexecutor.UnknownOutcomeError{Receipt: cloudexecutor.Receipt{OperationID: op.ID, State: cloudexecutor.StateUnknown}}))
	}
	if release.SHA256 != artifact.SHA256 || release.SiteID != artifact.FamilyID {
		return nil, e.siteFailure(ctx, op, call, round, errors.Join(ErrCloudSiteConflict, &cloudexecutor.UnknownOutcomeError{Receipt: cloudexecutor.Receipt{OperationID: op.ID, State: cloudexecutor.StateUnknown}}))
	}
	result := cloudJSON(map[string]any{"artifact": artifact, "site": map[string]any{"site_id": release.SiteID, "release_id": release.ID, "entry_point": release.Manifest.EntryPoint, "file_count": len(release.Manifest.Entries)}, "durable": true, "shared": false})
	if err = e.commit(ctx, op, CloudToolSucceeded, result, ""); err != nil {
		return nil, err
	}
	if err = e.emit(ctx, op, call, round, "completed"); err != nil {
		return nil, err
	}
	return result, nil
}
