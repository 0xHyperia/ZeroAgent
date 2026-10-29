package account

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

type CloudToolStore interface {
	PrepareCloudTool(context.Context, int64, string, string, int64, *CloudToolOperation) (*CloudToolOperation, bool, error)
	GetCloudToolOperation(context.Context, int64, string) (*CloudToolOperation, error)
	ListCloudToolOperations(context.Context, int64, string, int) ([]CloudToolOperation, error)
	StartCloudTool(context.Context, int64, string, string, int64) (*CloudToolOperation, error)
	CommitCloudTool(context.Context, int64, string, string, int64, string, json.RawMessage, string) (*CloudToolOperation, error)
	ReserveCloudWorkspace(context.Context, int64, string, string, int64, int64, int64) (*CloudWorkspaceBinding, bool, error)
	GetCloudWorkspace(context.Context, int64, string) (*CloudWorkspaceBinding, error)
	RecordCloudWorkspaceReceipt(context.Context, int64, string, string, int64, CloudWorkspaceReceipt) (*CloudWorkspaceBinding, error)
	ListCloudWorkspaceCleanup(context.Context, int) ([]CloudWorkspaceCleanup, error)
	RequestCloudWorkspaceCleanup(context.Context, int64, string) ([]CloudWorkspaceCleanup, error)
	// Cleanup uses observation ID (not binding ID) and its independent version.
	// It only records an acknowledged kill/absence or a retryable cleanup failure.
	CommitCloudWorkspaceCleanup(context.Context, int64, string, int64, bool, string) error
}

var cloudToolIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
var cloudToolErrorCode = regexp.MustCompile(`^[a-z][a-z0-9_]{0,79}$`)

func CloudToolRequestHash(name string, input json.RawMessage) (string, error) {
	if !cloudToolIdentifier.MatchString(name) || !json.Valid(input) || !utf8.Valid(input) || len(input) > CloudToolMaxInput {
		return "", ErrCloudToolInvalid
	}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return "", ErrCloudToolInvalid
	}
	canonical, err := json.Marshal(struct {
		Name  string `json:"name"`
		Input any    `json:"input"`
	}{name, value})
	if err != nil {
		return "", ErrCloudToolInvalid
	}
	hash := sha256.Sum256(canonical)
	return hex.EncodeToString(hash[:]), nil
}

func prepareCloudTool(input *CloudToolOperation, userID int64, run *CloudRun, now time.Time) (*CloudToolOperation, error) {
	if input == nil || userID <= 0 || !cloudToolIdentifier.MatchString(input.CallKey) {
		return nil, ErrCloudToolInvalid
	}
	hash, err := CloudToolRequestHash(input.Name, input.Input)
	if err != nil {
		return nil, err
	}
	if input.RequestHash != "" && input.RequestHash != hash {
		return nil, ErrCloudToolInvalid
	}
	op := *input
	if op.ID == "" {
		op.ID = uuid.NewString()
	} else {
		parsed, err := uuid.Parse(op.ID)
		if err != nil {
			return nil, ErrCloudToolInvalid
		}
		op.ID = parsed.String()
	}
	op.UserID, op.ConversationID, op.RunID = userID, run.ConversationID, run.ID
	op.RequestHash = hash
	op.Input = append(json.RawMessage(nil), input.Input...)
	op.State = CloudToolPrepared
	op.Result = nil
	op.ErrorCode = ""
	op.ExecutionAttempt = run.Attempt
	op.Version = 1
	op.CreatedAt = now.UTC()
	op.UpdatedAt = op.CreatedAt
	return &op, nil
}

func cloneCloudTool(op CloudToolOperation) CloudToolOperation {
	op.Input = append(json.RawMessage(nil), op.Input...)
	op.Result = append(json.RawMessage(nil), op.Result...)
	return op
}

func commitCloudTool(op CloudToolOperation, state string, result json.RawMessage, errorCode string, now time.Time) (*CloudToolOperation, error) {
	if state != CloudToolSucceeded && state != CloudToolFailed && state != CloudToolCancelled && state != CloudToolUnknown {
		return nil, ErrCloudToolInvalid
	}
	if len(result) > CloudToolMaxResult || (len(result) > 0 && (!json.Valid(result) || !utf8.Valid(result))) || (errorCode != "" && !cloudToolErrorCode.MatchString(errorCode)) {
		return nil, ErrCloudToolInvalid
	}
	if op.State == state && equalCloudToolJSON(op.Result, result) && op.ErrorCode == errorCode {
		copy := cloneCloudTool(op)
		return &copy, nil
	}
	if op.State != CloudToolExecuting && op.State != CloudToolUnknown && !(op.State == CloudToolPrepared && (state == CloudToolCancelled || state == CloudToolFailed)) {
		return nil, ErrCloudToolConflict
	}
	op.State, op.Result, op.ErrorCode = state, append(json.RawMessage(nil), result...), errorCode
	op.Version++
	op.UpdatedAt = now.UTC()
	return &op, nil
}

func equalCloudToolJSON(a, b json.RawMessage) bool {
	if len(a) == 0 || len(b) == 0 {
		return len(a) == len(b)
	}
	left, err := CloudToolRequestHash("result", a)
	if err != nil {
		return false
	}
	right, err := CloudToolRequestHash("result", b)
	return err == nil && left == right
}

func validCloudWorkspaceReservation(seconds, limit int64) bool {
	return seconds > 0 && seconds <= CloudWorkspaceMaxAllocation && limit >= seconds && limit <= CloudWorkspaceMaxDailyAllocation
}

func newCloudWorkspace(run *CloudRun, seconds int64, now time.Time) *CloudWorkspaceBinding {
	id := uuid.NewString()
	owner := sha256.Sum256([]byte(strconv.FormatInt(run.UserID, 10)))
	return &CloudWorkspaceBinding{ID: id, UserID: run.UserID, ConversationID: run.ConversationID, RunID: run.ID, LeaseOwner: run.LeaseOwner, ExecutionAttempt: run.Attempt, CreateOperationID: uuid.NewString(), OwnerScope: "account-" + hex.EncodeToString(owner[:16]), WorkspaceRef: "chat-" + id, State: CloudWorkspacePrepared, AllocationDay: now.UTC().Format("2006-01-02"), ReservedSeconds: seconds, Version: 1, CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
}

func validCloudWorkspaceReceipt(receipt CloudWorkspaceReceipt) bool {
	if receipt.State != CloudWorkspaceReady && receipt.State != CloudWorkspaceUnknown && receipt.State != CloudWorkspaceClosed {
		return false
	}
	if receipt.SandboxID != "" && !cloudToolIdentifier.MatchString(receipt.SandboxID) {
		return false
	}
	if receipt.State == CloudWorkspaceReady && (receipt.SandboxID == "" || receipt.StartedAt.IsZero() || !receipt.ExpiresAt.After(receipt.StartedAt)) {
		return false
	}
	if receipt.State == CloudWorkspaceClosed && receipt.SandboxID != "" {
		return false
	}
	return true
}

func applyCloudWorkspaceReceipt(binding CloudWorkspaceBinding, version int64, receipt CloudWorkspaceReceipt, authorized bool, now time.Time) (*CloudWorkspaceBinding, bool, bool) {
	// A confirmed immutable creation already recorded on this binding is not
	// downgraded by a later unknown reply or by its original Run finishing.
	if receipt.SandboxID != "" && binding.SandboxID == receipt.SandboxID && (binding.State == CloudWorkspaceReady || binding.State == CloudWorkspaceClosed) {
		return &binding, false, false
	}
	if receipt.SandboxID == "" && (binding.State == CloudWorkspaceReady || binding.State == CloudWorkspaceClosed) {
		return &binding, false, false
	}
	if version < 1 || binding.Version != version || binding.State == CloudWorkspaceClosed || (binding.SandboxID != "" && receipt.SandboxID != "" && binding.SandboxID != receipt.SandboxID) {
		return &binding, receipt.SandboxID != "", true
	}
	if receipt.SandboxID != "" {
		binding.SandboxID = receipt.SandboxID
		binding.StartedAt = receipt.StartedAt
		binding.ExpiresAt = receipt.ExpiresAt
	}
	cleanup := receipt.SandboxID != "" && (!authorized || receipt.State != CloudWorkspaceReady || !receipt.ExpiresAt.After(now) || binding.State == CloudWorkspaceCleanupPending)
	if receipt.SandboxID != "" && receipt.ExpiresAt.Sub(receipt.StartedAt) > time.Duration(binding.ReservedSeconds)*time.Second {
		cleanup = true
	}
	if cleanup {
		binding.State = CloudWorkspaceCleanupPending
	} else if receipt.State == CloudWorkspaceReady && authorized {
		binding.State = CloudWorkspaceReady
	} else if receipt.State == CloudWorkspaceClosed {
		binding.State = CloudWorkspaceClosed
	} else {
		binding.State = CloudWorkspaceUnknown
	}
	binding.Version++
	binding.UpdatedAt = now.UTC()
	return &binding, cleanup, false
}

func newCloudWorkspaceObservation(binding CloudWorkspaceBinding, sandboxID string, cleanup bool, now time.Time) CloudWorkspaceCleanup {
	state := "observed"
	if cleanup {
		state = CloudWorkspaceCleanupPending
	}
	return CloudWorkspaceCleanup{ID: uuid.NewString(), UserID: binding.UserID, BindingID: binding.ID, ConversationID: binding.ConversationID, CreateOperationID: binding.CreateOperationID, CleanupOperationID: uuid.NewString(), OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef, SandboxID: sandboxID, State: state, Version: 1, CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
}

func unallocatedCloudWorkspaceCleanup(binding CloudWorkspaceBinding) CloudWorkspaceCleanup {
	return CloudWorkspaceCleanup{ID: binding.ID, UserID: binding.UserID, BindingID: binding.ID, ConversationID: binding.ConversationID, CreateOperationID: binding.CreateOperationID, CleanupOperationID: "cleanup-" + binding.ID, OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef, State: CloudWorkspaceUnknown, Version: binding.Version, CreatedAt: binding.CreatedAt, UpdatedAt: binding.UpdatedAt}
}
