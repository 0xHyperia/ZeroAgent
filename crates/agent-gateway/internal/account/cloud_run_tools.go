package account

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

const cloudToolResultBytes = 64 << 10
const cloudWorkspaceAllocationSeconds = int64(300)
const cloudWorkspaceDailySeconds = int64(3600)

type cloudToolRunError struct {
	code    string
	unknown bool
	cause   error
}

func (e *cloudToolRunError) Error() string { return e.code }
func (e *cloudToolRunError) Unwrap() error { return e.cause }

type cloudRunToolExecution struct {
	runtime         *cloudRunRuntime
	run             *CloudRun
	owner           string
	store           CloudToolStore
	client          *cloudexecutor.Client
	workspace       *CloudWorkspaceBinding
	protected       []string
	executorEnabled bool
	calls           int
	historyBoundary CloudMessageHead
	historySources  map[string]string // source ID -> selected canonical message ID
	researchScope   *cloudRunResearchScope
	skillPackages   []CloudExtension // private execution snapshot; never sent to public research
}

func (e *cloudRunToolExecution) rememberSecrets(values ...string) {
	for _, value := range values {
		if value == "" {
			continue
		}
		found := false
		for _, known := range e.protected {
			if value == known {
				found = true
				break
			}
		}
		if !found {
			e.protected = append(e.protected, value)
		}
	}
}

func (e *cloudRunToolExecution) authorize(ctx context.Context) (*Session, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	current, err := e.runtime.store.GetCloudRun(ctx, e.run.UserID, e.run.ID)
	if err != nil {
		return nil, err
	}
	if current.State != CloudRunRunning {
		return nil, ErrCloudRunLeaseLost
	}
	if err = validateCloudRunLease(current, e.owner, e.run.Attempt, e.runtime.service.now()); err != nil {
		return nil, err
	}
	session, err := e.runtime.sessions.GetCloudRunSession(ctx, e.run.SessionRef)
	if err != nil {
		return nil, err
	}
	if session.UserID != e.run.UserID {
		return nil, sessionMissingError()
	}
	session, err = e.runtime.service.Session(ctx, session.ID)
	if err != nil {
		return nil, err
	}
	if session.UserID != e.run.UserID {
		return nil, sessionMissingError()
	}
	e.rememberSecrets(session.ID, session.AccessToken, session.RefreshToken)
	return session, nil
}

func (e *cloudRunToolExecution) hasSecret(value any) bool {
	guard := newCloudModelStream(e.protected)
	var visit func(any) bool
	visit = func(value any) bool {
		switch v := value.(type) {
		case string:
			return guard.hasSecret(v) || cloudResearchSourceHasSecret(v, e.protected)
		case json.RawMessage:
			var decoded any
			if json.Unmarshal(v, &decoded) != nil {
				return true
			}
			return visit(decoded)
		case []any:
			for _, part := range v {
				if visit(part) {
					return true
				}
			}
		case map[string]any:
			for key, part := range v {
				if guard.hasSecret(key) || visit(part) {
					return true
				}
			}
		}
		return false
	}
	return visit(value)
}

func cloudToolFunction(name, description string, properties map[string]any, required ...string) map[string]any {
	return map[string]any{"type": "function", "function": map[string]any{"name": name, "description": description, "parameters": map[string]any{"type": "object", "properties": properties, "required": required, "additionalProperties": false}}}
}
func cloudToolString(description string) map[string]any {
	return map[string]any{"type": "string", "description": description}
}

func (e *cloudRunToolExecution) schemas() []map[string]any {
	if e.store == nil {
		return nil
	}
	timeout := map[string]any{"type": "integer", "minimum": 1, "maximum": 120000, "description": "Execution timeout in milliseconds; default 30000."}
	tools := []map[string]any{
		cloudToolFunction("extract_archive", "Extract a verified ZIP file inside the isolated workspace into a fresh directory. Bounded regular files only; rejects traversal, links, duplicates and oversized archives. Existing destinations are never overwritten. Load the upload first; no extraction occurs on the Gateway host.", map[string]any{"path": cloudToolString("Relative workspace ZIP file path."), "destination": cloudToolString("Optional new relative directory; defaults to a unique operation directory.")}, "path"),
		cloudToolFunction("execute_code", "Run code in the account-owned isolated cloud workspace. Network egress is denied. Variables do not survive between cells; files are temporary until explicitly published.", map[string]any{"code": cloudToolString("Source code, at most 64 KiB."), "language": map[string]any{"type": "string", "enum": []string{"python", "javascript", "typescript", "bash", "r", "java"}}, "timeout_ms": timeout}, "code"),
		cloudToolFunction("execute_command", "Run a command inside the isolated cloud VM as its unprivileged user; never on the Gateway host or user's devices.", map[string]any{"command": cloudToolString("Command, at most 64 KiB."), "cwd": cloudToolString("Optional relative workspace directory."), "timeout_ms": timeout}, "command"),
		cloudToolFunction("read_file", "Read a small file from the isolated cloud workspace. Text responses are bounded; binary data must be processed with code or published as an artifact.", map[string]any{"path": cloudToolString("Relative workspace file path.")}, "path"),
		cloudToolFunction("write_file", "Write UTF-8 text into the isolated cloud workspace. This is temporary VM storage, not a durable download.", map[string]any{"path": cloudToolString("Relative workspace file path."), "content": cloudToolString("UTF-8 text content.")}, "path", "content"),
	}
	if _, ok := any(e.runtime.service).(cloudToolArtifactPublisher); ok {
		if _, err := e.runtime.service.cloudFileProvider(); err == nil {
			tools = append(tools, cloudToolFunction("publish_artifact", "Publish a sandbox file to durable account storage. Only a successful ready result is downloadable; cite its immutable version ID as 【成果:VERSION_ID】, never invent a link. Supply the owned family_id to save a new version of an existing artifact.", map[string]any{"path": cloudToolString("Relative workspace file path."), "name": cloudToolString("Download filename."), "mime": cloudToolString("Optional MIME type."), "family_id": cloudToolString("Optional owned artifact family UUID for a new immutable version.")}, "path", "name"))
			if _, err := e.runtime.service.siteProvider(); err == nil {
				tools = append(tools, cloudToolFunction("publish_site", "Save a built static website directory as a private durable site version. Build first using workspace tools; use index.html, bundled local assets and relative base './'. This packages only the selected subdirectory, never the whole workspace. Hidden configuration, links, node_modules and server code are rejected. Cite a successful ready artifact as 【成果:VERSION_ID】. It does not create a public link; the user controls sharing. Supply the owned family_id to continue an existing site.", map[string]any{"path": cloudToolString("Selected relative build output directory, for example project/dist; not '.' or the workspace root."), "name": cloudToolString("Download filename ending in .zip."), "family_id": cloudToolString("Optional owned artifact family UUID for a new immutable site version.")}, "path", "name"))
			}
		}
	}
	if _, ok := any(e.runtime.service).(cloudToolWorkspaceLoader); ok {
		if _, err := e.runtime.service.cloudFileProvider(); err == nil {
			load := cloudToolFunction("load_uploaded_file", "Load verified bytes of an owned upload or ready artifact version into the current isolated workspace. Supply exactly one source ID; use artifact_version_id to continue editing after the previous VM expired. The result supplies the real temporary path and existing family_id for publishing a new version.", map[string]any{"file_id": cloudToolString("Owned uploaded file UUID; mutually exclusive with artifact_version_id."), "artifact_version_id": cloudToolString("Owned ready immutable artifact version UUID; mutually exclusive with file_id."), "path": cloudToolString("Optional relative destination file path.")})
			load["function"].(map[string]any)["parameters"].(map[string]any)["oneOf"] = []any{map[string]any{"required": []string{"file_id"}, "not": map[string]any{"required": []string{"artifact_version_id"}}}, map[string]any{"required": []string{"artifact_version_id"}, "not": map[string]any{"required": []string{"file_id"}}}}
			tools = append(tools, load)
		}
	}
	if !e.executorEnabled {
		tools = nil
	}
	tools = append(tools, e.researchSchemas()...)
	tools = append(tools, e.historySchemas()...)
	tools = append(tools, e.visualSchemas()...)
	tools = append(tools, e.extensionDraftSchema()...)
	return tools
}

func decodeCloudToolArguments(raw string, out any) error {
	if len(raw) > cloudModelMaxArguments || !utf8.ValidString(raw) {
		return &cloudToolRunError{code: "model_tool_invalid"}
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(out) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		return &cloudToolRunError{code: "model_tool_invalid"}
	}
	return nil
}

func validCloudToolPath(value string) bool {
	if value == "" || len(value) > 1024 || !utf8.ValidString(value) || strings.ContainsAny(value, "\\\x00") || strings.HasPrefix(value, "/") {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if part == "" || part == "." || part == ".." || part == ".zeroagent-transfers" {
			return false
		}
	}
	return true
}

type cloudToolInvocation struct {
	action   string
	input    map[string]any
	timeout  time.Duration
	artifact *struct{ Path, Name, MIME, FamilyID string }
	load     *struct{ FileID, ArtifactVersionID, Path string }
	archive  *struct{ Path, Destination string }
	site     *struct{ Path, Name, FamilyID string }
}

func parseCloudToolInvocation(call cloudModelToolCall) (cloudToolInvocation, error) {
	invalid := func() (cloudToolInvocation, error) {
		return cloudToolInvocation{}, &cloudToolRunError{code: "model_tool_invalid"}
	}
	invocation := cloudToolInvocation{timeout: 40 * time.Second}
	switch call.Name {
	case "execute_code":
		var args struct {
			Code      string `json:"code"`
			Language  string `json:"language"`
			TimeoutMS int    `json:"timeout_ms"`
		}
		if err := decodeCloudToolArguments(call.Arguments, &args); err != nil {
			return invocation, err
		}
		if args.Language == "" {
			args.Language = "python"
		}
		switch args.Language {
		case "python", "javascript", "typescript", "bash", "r", "java":
		default:
			return invalid()
		}
		if args.Code == "" || len(args.Code) > 64<<10 {
			return invalid()
		}
		if args.TimeoutMS == 0 {
			args.TimeoutMS = 30000
		}
		if args.TimeoutMS < 1 || args.TimeoutMS > 120000 {
			return invalid()
		}
		invocation.action = "code.run"
		invocation.input = map[string]any{"code": args.Code, "language": args.Language, "timeout_ms": args.TimeoutMS}
		invocation.timeout = time.Duration(args.TimeoutMS)*time.Millisecond + 10*time.Second
	case "execute_command":
		var args struct {
			Command   string `json:"command"`
			Cwd       string `json:"cwd"`
			TimeoutMS int    `json:"timeout_ms"`
		}
		if err := decodeCloudToolArguments(call.Arguments, &args); err != nil {
			return invocation, err
		}
		if args.Command == "" || len(args.Command) > 64<<10 || (args.Cwd != "" && !validCloudToolPath(args.Cwd)) {
			return invalid()
		}
		if args.TimeoutMS == 0 {
			args.TimeoutMS = 30000
		}
		if args.TimeoutMS < 1 || args.TimeoutMS > 120000 {
			return invalid()
		}
		invocation.action = "command.run"
		invocation.input = map[string]any{"command": args.Command, "timeout_ms": args.TimeoutMS}
		if args.Cwd != "" {
			invocation.input["cwd"] = args.Cwd
		}
		invocation.timeout = time.Duration(args.TimeoutMS)*time.Millisecond + 10*time.Second
	case "extract_archive":
		var args struct {
			Path        string `json:"path"`
			Destination string `json:"destination"`
		}
		if err := decodeCloudToolArguments(call.Arguments, &args); err != nil {
			return invocation, err
		}
		if !validCloudToolPath(args.Path) || (args.Destination != "" && !validCloudToolPath(args.Destination)) {
			return invalid()
		}
		invocation.archive = &struct{ Path, Destination string }{args.Path, args.Destination}
		invocation.timeout = 50 * time.Second
	case "read_file":
		var args struct {
			Path string `json:"path"`
		}
		if err := decodeCloudToolArguments(call.Arguments, &args); err != nil {
			return invocation, err
		}
		if !validCloudToolPath(args.Path) {
			return invalid()
		}
		invocation.action = "file.read"
		invocation.input = map[string]any{"path": args.Path}
	case "write_file":
		var args struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		}
		if err := decodeCloudToolArguments(call.Arguments, &args); err != nil {
			return invocation, err
		}
		if !validCloudToolPath(args.Path) || !utf8.ValidString(args.Content) || len(args.Content) > 64<<10 {
			return invalid()
		}
		invocation.action = "file.write"
		invocation.input = map[string]any{"path": args.Path, "data_base64": base64.StdEncoding.EncodeToString([]byte(args.Content))}
	case "publish_artifact":
		var args struct {
			Path     string `json:"path"`
			Name     string `json:"name"`
			MIME     string `json:"mime"`
			FamilyID string `json:"family_id"`
		}
		if err := decodeCloudToolArguments(call.Arguments, &args); err != nil {
			return invocation, err
		}
		if !validCloudToolPath(args.Path) || !validCloudFileName(args.Name) || len(args.MIME) > 200 {
			return invalid()
		}
		if args.FamilyID != "" {
			if _, err := uuid.Parse(args.FamilyID); err != nil {
				return invalid()
			}
		}
		invocation.artifact = &struct{ Path, Name, MIME, FamilyID string }{args.Path, args.Name, args.MIME, args.FamilyID}
		invocation.input = map[string]any{"path": args.Path, "name": args.Name, "mime": args.MIME, "family_id": args.FamilyID}
		invocation.timeout = 2 * time.Minute
	case "publish_site":
		var args struct {
			Path     string `json:"path"`
			Name     string `json:"name"`
			FamilyID string `json:"family_id"`
		}
		if err := decodeCloudToolArguments(call.Arguments, &args); err != nil {
			return invocation, err
		}
		if !cloudexecutor.ValidSiteSourcePath(args.Path) || !validCloudFileName(args.Name) || !strings.HasSuffix(strings.ToLower(args.Name), ".zip") {
			return invalid()
		}
		if args.FamilyID != "" {
			family, err := uuid.Parse(args.FamilyID)
			if err != nil {
				return invalid()
			}
			args.FamilyID = family.String()
		}
		invocation.site = &struct{ Path, Name, FamilyID string }{args.Path, args.Name, args.FamilyID}
		invocation.input = map[string]any{"path": args.Path, "name": args.Name, "family_id": args.FamilyID}
		invocation.timeout = 2 * time.Minute
	case "load_uploaded_file":
		var args struct {
			FileID            string `json:"file_id"`
			ArtifactVersionID string `json:"artifact_version_id"`
			Path              string `json:"path"`
		}
		if err := decodeCloudToolArguments(call.Arguments, &args); err != nil {
			return invocation, err
		}
		if (args.FileID == "") == (args.ArtifactVersionID == "") || (args.Path != "" && !validCloudToolPath(args.Path)) {
			return invalid()
		}
		id := args.FileID
		if id == "" {
			id = args.ArtifactVersionID
		}
		if _, err := uuid.Parse(id); err != nil {
			return invalid()
		}
		invocation.load = &struct{ FileID, ArtifactVersionID, Path string }{args.FileID, args.ArtifactVersionID, args.Path}
		invocation.timeout = 2 * time.Minute
	default:
		return invalid()
	}
	return invocation, nil
}

func (e *cloudRunToolExecution) emit(ctx context.Context, operation *CloudToolOperation, call cloudModelToolCall, round int, state string) error {
	// CommitCloudTool writes public terminal facts atomically with its receipt.
	// Emitting them afterwards would reintroduce a crash window and duplicate
	// events. Preparation/execution still have their separate progress events.
	if _, public := cloudPublicToolRound(operation); public && (state == "completed" || state == "failed" || state == "unknown" || state == "cancelled") {
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	canonical, status := state, "准备执行"
	switch state {
	case "started":
		canonical = CloudToolExecuting
		status = "正在执行"
		switch call.Name {
		case "execute_code":
			status = "正在运行代码"
		case "execute_command":
			status = "正在运行云端命令"
		case "read_file":
			status = "正在读取工作区文件"
		case "write_file":
			status = "正在写入工作区文件"
		case "publish_artifact":
			status = "正在保存成果"
		case "publish_site":
			status = "正在保存站点"
		case "load_uploaded_file":
			status = "正在载入工作文件"
		case "extract_archive":
			status = "正在解包代码资料"
		case "read_history":
			status = "正在查阅当前会话历史"
		case "web_search":
			status = "正在搜索网页"
		case "fetch_page":
			status = "正在读取网页"
		}
	case "completed":
		canonical = CloudToolSucceeded
		status = "已完成"
	case "failed":
		status = "执行失败"
	case "unknown":
		status = "结果待确认"
	}
	_, err := e.runtime.store.CommitCloudRun(ctx, e.run.UserID, e.run.ID, e.owner, e.run.Attempt, CloudRunCommit{OperationID: fmt.Sprintf("tool-event:%s:%s", operation.ID, state), EventType: "tool." + state, Payload: cloudJSON(map[string]any{"tool_id": operation.ID, "operation_id": operation.ID, "tool_call_id": call.ID, "name": call.Name, "state": canonical, "status": status, "round": round, "index": call.Index})})
	return err
}

func (e *cloudRunToolExecution) prepare(ctx context.Context, key, name string, input map[string]any, id string) (*CloudToolOperation, bool, error) {
	if _, err := e.authorize(ctx); err != nil {
		return nil, false, err
	}
	if e.hasSecret(input) {
		return nil, false, &cloudToolRunError{code: "model_secret_reflection"}
	}
	return e.store.PrepareCloudTool(ctx, e.run.UserID, e.run.ID, e.owner, e.run.Attempt, &CloudToolOperation{ID: id, CallKey: key, Name: name, Input: cloudJSON(input)})
}

func sdkCloudToolError(err error) *cloudToolRunError {
	var unknown *cloudexecutor.UnknownOutcomeError
	if errors.As(err, &unknown) {
		return &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true}
	}
	var api *cloudexecutor.APIError
	if errors.As(err, &api) && api.MayHaveExecuted {
		return &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true}
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return &cloudToolRunError{code: "cloud_tool_cancelled", unknown: true}
	}
	return &cloudToolRunError{code: "cloud_tool_failed"}
}

// The operation has already been durably prepared. Only prepared may transition
// to executing and Submit; any uncertain existing execution only queries its ID.
func (e *cloudRunToolExecution) sdk(ctx context.Context, op *CloudToolOperation, operation cloudexecutor.Operation, started ...func() error) (cloudexecutor.Receipt, error) {
	operation.OperationID = op.ID
	if op.State == CloudToolPrepared {
		if _, err := e.authorize(ctx); err != nil {
			return cloudexecutor.Receipt{}, err
		}
		if _, err := e.store.StartCloudTool(ctx, e.run.UserID, op.ID, e.owner, e.run.Attempt); err != nil {
			return cloudexecutor.Receipt{}, err
		}
		if len(started) > 0 {
			if err := started[0](); err != nil {
				return cloudexecutor.Receipt{}, err
			}
		}
		if _, err := e.authorize(ctx); err != nil {
			return cloudexecutor.Receipt{}, err
		}
		return e.client.Execute(ctx, operation)
	}
	if op.State == CloudToolSucceeded || op.State == CloudToolFailed || op.State == CloudToolCancelled {
		return cloudexecutor.Receipt{OperationID: op.ID, Action: operation.Action, State: op.State, Result: op.Result}, nil
	}
	receipt, err := e.client.Get(ctx, op.ID, operation.Scope())
	if err != nil {
		return receipt, &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true}
	}
	if receipt.Action != operation.Action || !receipt.Terminal() || receipt.State == cloudexecutor.StateUnknown {
		return receipt, &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true}
	}
	return receipt, nil
}

func (e *cloudRunToolExecution) commit(ctx context.Context, op *CloudToolOperation, state string, result json.RawMessage, code string) error {
	if len(result) > 0 && e.hasSecret(result) {
		state, result, code = CloudToolFailed, nil, "model_secret_reflection"
	}
	commitCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, err := e.store.CommitCloudTool(commitCtx, e.run.UserID, op.ID, e.owner, e.run.Attempt, state, result, code)
	if err != nil {
		return &cloudToolRunError{code: "cloud_tool_result_persistence_failed", unknown: true, cause: err}
	}
	if code == "model_secret_reflection" {
		return &cloudToolRunError{code: code}
	}
	return nil
}

type cloudWorkspaceSDKInfo struct {
	SandboxID string    `json:"sandbox_id"`
	State     string    `json:"state"`
	StartedAt time.Time `json:"started_at"`
	ExpiresAt time.Time `json:"expires_at"`
	Network   struct {
		Outbound     string `json:"outbound"`
		PublicAccess *bool  `json:"public_access"`
	} `json:"network"`
	AutoResume *bool `json:"auto_resume"`
}

func (e *cloudRunToolExecution) validWorkspaceInfo(info cloudWorkspaceSDKInfo, binding *CloudWorkspaceBinding) bool {
	return cloudToolIdentifier.MatchString(info.SandboxID) && !e.hasSecret(info.SandboxID) && info.State == "running" && info.Network.Outbound == "denied" && info.Network.PublicAccess != nil && !*info.Network.PublicAccess && info.AutoResume != nil && !*info.AutoResume && !info.StartedAt.IsZero() && info.ExpiresAt.After(e.runtime.service.now()) && info.ExpiresAt.After(info.StartedAt) && info.ExpiresAt.Sub(info.StartedAt) <= time.Duration(binding.ReservedSeconds)*time.Second
}

func (e *cloudRunToolExecution) observeCreate(ctx context.Context, binding *CloudWorkspaceBinding, receipt cloudexecutor.Receipt, knownFailure bool) (*CloudWorkspaceBinding, error) {
	observation := CloudWorkspaceReceipt{State: CloudWorkspaceUnknown}
	var info cloudWorkspaceSDKInfo
	_ = json.Unmarshal(receipt.Result, &info)
	if info.SandboxID != "" && cloudToolIdentifier.MatchString(info.SandboxID) && !e.hasSecret(info.SandboxID) {
		observation.SandboxID = info.SandboxID
		observation.StartedAt = info.StartedAt
		observation.ExpiresAt = info.ExpiresAt
		if receipt.State == cloudexecutor.StateSucceeded && e.validWorkspaceInfo(info, binding) {
			observation.State = CloudWorkspaceReady
		}
	}
	if observation.SandboxID == "" && knownFailure {
		observation.State = CloudWorkspaceClosed
	}
	recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	return e.store.RecordCloudWorkspaceReceipt(recordCtx, e.run.UserID, binding.ID, binding.CreateOperationID, binding.Version, observation)
}

func (e *cloudRunToolExecution) ensureWorkspace(ctx context.Context, round, index int) (*CloudWorkspaceBinding, error) {
	if _, err := e.authorize(ctx); err != nil {
		return nil, err
	}
	binding, created, err := e.store.ReserveCloudWorkspace(ctx, e.run.UserID, e.run.ID, e.owner, e.run.Attempt, cloudWorkspaceAllocationSeconds, cloudWorkspaceDailySeconds)
	if err != nil {
		return nil, err
	}
	e.workspace = binding
	if created {
		input := map[string]any{"owner_scope": binding.OwnerScope, "workspace_ref": binding.WorkspaceRef}
		op, _, err := e.prepare(ctx, "workspace:"+binding.ID+":create", "sandbox.create", input, binding.CreateOperationID)
		if err != nil {
			return nil, err
		}
		receipt, executeErr := e.sdk(ctx, op, cloudexecutor.Operation{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef, Action: "sandbox.create"})
		var api *cloudexecutor.APIError
		knownFailure := errors.As(executeErr, &api) && !api.MayHaveExecuted
		var recordErr error
		binding, recordErr = e.observeCreate(ctx, binding, receipt, knownFailure)
		if binding != nil {
			e.workspace = binding
		}
		state := receipt.State
		if state == "" {
			state = CloudToolUnknown
		}
		if state != CloudToolSucceeded && state != CloudToolFailed && state != CloudToolCancelled {
			state = CloudToolUnknown
		}
		code := ""
		if executeErr != nil {
			code = sdkCloudToolError(executeErr).code
		}
		commitErr := e.commit(ctx, op, state, receipt.Result, code)
		if commitErr != nil && executeErr == nil {
			executeErr = commitErr
		}
		if commitErr == nil && recordErr == nil {
			acknowledgeCloudSDKReceipt(ctx, e.client, receipt, cloudexecutor.Scope{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef})
		}
		if recordErr != nil {
			return nil, recordErr
		}
		if executeErr != nil {
			return nil, executeErr
		}
		if receipt.State != CloudToolSucceeded || binding.State != CloudWorkspaceReady {
			return nil, &cloudToolRunError{code: "cloud_workspace_unavailable", unknown: binding.State == CloudWorkspaceUnknown}
		}
	} else if binding.State != CloudWorkspaceReady {
		receipt, getErr := e.client.Get(ctx, binding.CreateOperationID, cloudexecutor.Scope{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef})
		if getErr == nil && receipt.Action == "sandbox.create" {
			updated, observeErr := e.observeCreate(ctx, binding, receipt, false)
			if updated != nil {
				binding = updated
				e.workspace = updated
			}
			if observeErr != nil {
				return nil, observeErr
			}
		}
		if binding.State != CloudWorkspaceReady {
			return nil, &cloudToolRunError{code: "cloud_workspace_allocation_unknown", unknown: true}
		}
	}
	input := map[string]any{"owner_scope": binding.OwnerScope, "workspace_ref": binding.WorkspaceRef, "sandbox_id": binding.SandboxID}
	op, _, err := e.prepare(ctx, fmt.Sprintf("round:%d:call:%d:info", round, index), "sandbox.info", input, "")
	if err != nil {
		return nil, err
	}
	receipt, err := e.sdk(ctx, op, cloudexecutor.Operation{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef, Action: "sandbox.info", SandboxID: binding.SandboxID})
	if err != nil {
		_ = e.commit(ctx, op, CloudToolUnknown, nil, sdkCloudToolError(err).code)
		return nil, err
	}
	var info cloudWorkspaceSDKInfo
	if receipt.State != CloudToolSucceeded || json.Unmarshal(receipt.Result, &info) != nil || info.SandboxID != binding.SandboxID || !e.validWorkspaceInfo(info, binding) {
		if e.commit(ctx, op, CloudToolFailed, nil, "cloud_workspace_policy_invalid") == nil {
			acknowledgeCloudSDKReceipt(ctx, e.client, receipt, cloudexecutor.Scope{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef})
		}
		return nil, &cloudToolRunError{code: "cloud_workspace_policy_invalid"}
	}
	if err = e.commit(ctx, op, CloudToolSucceeded, receipt.Result, ""); err != nil {
		return nil, err
	}
	acknowledgeCloudSDKReceipt(ctx, e.client, receipt, cloudexecutor.Scope{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef})
	return binding, nil
}

func cloudBoundToolString(text string, max int) (string, bool) {
	if len(text) <= max {
		return text, false
	}
	text = text[:max]
	for !utf8.ValidString(text) && len(text) > 0 {
		text = text[:len(text)-1]
	}
	return text, true
}

func (e *cloudRunToolExecution) normalizeResult(invocation cloudToolInvocation, receipt cloudexecutor.Receipt) (json.RawMessage, error) {
	var result map[string]any
	if len(receipt.Result) > 0 && json.Unmarshal(receipt.Result, &result) != nil {
		return nil, &cloudToolRunError{code: "cloud_tool_invalid_result"}
	}
	if result == nil {
		result = map[string]any{}
	}
	if e.hasSecret(result) {
		return nil, &cloudToolRunError{code: "model_secret_reflection"}
	}
	clean := map[string]any{"status": receipt.State, "temporary_workspace": true, "durable": false}
	if receipt.State != CloudToolSucceeded {
		clean["error"] = "The isolated tool did not complete successfully. Earlier effects may remain."
		return cloudJSON(clean), nil
	}
	switch invocation.action {
	case "file.read":
		encoded, ok := result["data_base64"].(string)
		if !ok {
			return nil, &cloudToolRunError{code: "cloud_tool_invalid_result"}
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(data) > 1<<20 {
			return nil, &cloudToolRunError{code: "cloud_tool_invalid_result"}
		}
		if e.hasSecret(string(data)) {
			return nil, &cloudToolRunError{code: "model_secret_reflection"}
		}
		digest := sha256.Sum256(data)
		clean["bytes"], clean["sha256"], clean["path"] = len(data), hex.EncodeToString(digest[:]), invocation.input["path"]
		if utf8.Valid(data) {
			text, truncated := cloudBoundToolString(string(data), cloudToolResultBytes/2)
			clean["text"], clean["truncated"] = text, truncated
		} else {
			clean["binary"] = true
			clean["message"] = "Binary file retained only in the temporary VM; use code to inspect it or publish_artifact for a durable copy."
		}
	case "file.write":
		clean["path"] = invocation.input["path"]
		clean["bytes"] = result["bytes"]
	default:
		for _, key := range []string{"stdout", "stderr", "exit_code", "error", "logs", "results", "output_bytes"} {
			if value, ok := result[key]; ok {
				clean[key] = value
			}
		}
		data := cloudJSON(clean)
		if len(data) > cloudToolResultBytes {
			prefix, truncated := cloudBoundToolString(string(data), cloudToolResultBytes/2)
			clean = map[string]any{"status": receipt.State, "temporary_workspace": true, "durable": false, "output_excerpt": prefix, "truncated": truncated}
		}
	}
	return cloudJSON(clean), nil
}

type cloudToolArtifactPublisher interface {
	PublishCloudArtifact(context.Context, int64, CloudArtifactPublication) (*CloudArtifactVersion, error)
}

type cloudToolWorkspaceLoader interface {
	LoadCloudFileToWorkspace(context.Context, int64, CloudFileWorkspaceLoad) (*CloudWorkspaceLoadedFile, error)
}

func (e *cloudRunToolExecution) execute(ctx context.Context, round int, call cloudModelToolCall) (json.RawMessage, error) {
	if ctx.Value(cloudResearchScopeContextKey{}) != nil || (e.researchScope != nil && !e.researchScope.closed.Load()) {
		if _, err := e.authorizedResearchScope(ctx); err != nil {
			return nil, err
		}
		if !cloudPublicResearchTool(call.Name) {
			return nil, &cloudToolRunError{code: "model_tool_invalid"}
		}
	}
	e.calls++
	if e.calls > e.runtime.config.MaxToolCalls {
		return nil, &cloudToolRunError{code: "cloud_tool_call_limit"}
	}
	if e.store == nil {
		return nil, &cloudToolRunError{code: "cloud_tool_unavailable"}
	}
	if call.Name == "web_search" || call.Name == "fetch_page" || call.Name == "read_source" {
		return e.executeResearch(ctx, round, call)
	}
	if call.Name == "read_history" {
		return e.executeHistory(ctx, round, call)
	}
	if call.Name == "read_skill" {
		return e.executeSkill(ctx, round, call)
	}
	if call.Name == prepareExtensionTool {
		return e.executeExtensionDraft(ctx, round, call)
	}
	if call.Name == "generate_image" {
		if _, err := e.resolveSkill(ctx, "imagegen", "imagegen", ""); err != nil {
			return nil, &cloudToolRunError{code: "skill_unavailable"}
		}
		return e.executeImage(ctx, round, call)
	}
	if !e.executorEnabled {
		return nil, &cloudToolRunError{code: "cloud_tool_unavailable"}
	}
	invocation, err := parseCloudToolInvocation(call)
	if err != nil {
		return nil, err
	}
	var args map[string]any
	if json.Unmarshal([]byte(call.Arguments), &args) != nil || e.hasSecret(args) {
		return nil, &cloudToolRunError{code: "model_secret_reflection"}
	}
	op, _, err := e.prepare(ctx, fmt.Sprintf("round:%d:call:%d", round, call.Index), call.Name, args, "")
	if err != nil {
		return nil, err
	}
	if op.State == CloudToolSucceeded || op.State == CloudToolFailed || op.State == CloudToolCancelled {
		return op.Result, nil
	}
	if err = e.emit(ctx, op, call, round, "prepared"); err != nil {
		return nil, err
	}
	binding, err := e.ensureWorkspace(ctx, round, call.Index)
	if err != nil {
		_ = e.commit(ctx, op, CloudToolFailed, nil, "cloud_workspace_unavailable")
		return nil, err
	}
	deadline := time.Now().Add(invocation.timeout)
	workspaceDeadline := binding.ExpiresAt.Add(-time.Second)
	if workspaceDeadline.Before(deadline) {
		deadline = workspaceDeadline
	}
	toolCtx, cancel := context.WithDeadline(ctx, deadline)
	defer cancel()
	var receipt cloudexecutor.Receipt
	if invocation.site != nil {
		return e.executeSite(toolCtx, round, call, op, binding, invocation.site.Path, invocation.site.Name, invocation.site.FamilyID)
	}
	if invocation.archive != nil {
		return e.executeArchive(toolCtx, round, call, op, binding, invocation.archive.Path, invocation.archive.Destination)
	}
	if invocation.load != nil {
		loader, ok := any(e.runtime.service).(cloudToolWorkspaceLoader)
		if !ok {
			return nil, &cloudToolRunError{code: "cloud_file_unavailable"}
		}
		if op.State != CloudToolPrepared {
			return nil, &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true}
		}
		if _, err = e.store.StartCloudTool(toolCtx, e.run.UserID, op.ID, e.owner, e.run.Attempt); err != nil {
			return nil, err
		}
		if _, err = e.authorize(toolCtx); err != nil {
			return nil, err
		}
		if err = e.emit(toolCtx, op, call, round, "started"); err != nil {
			return nil, err
		}
		loaded, loadErr := loader.LoadCloudFileToWorkspace(toolCtx, e.run.UserID, CloudFileWorkspaceLoad{ConversationID: e.run.ConversationID, RunID: e.run.ID, ToolOperationID: op.ID, LeaseOwner: e.owner, ExecutionAttempt: e.run.Attempt, FileID: invocation.load.FileID, ArtifactVersionID: invocation.load.ArtifactVersionID, Path: invocation.load.Path})
		if loadErr != nil {
			code := sdkCloudToolError(loadErr)
			if !code.unknown {
				code.code = "cloud_file_load_failed"
			}
			state, event := CloudToolFailed, "failed"
			if code.unknown {
				state, event = CloudToolUnknown, "unknown"
			}
			_ = e.commit(toolCtx, op, state, nil, code.code)
			_ = e.emit(context.WithoutCancel(toolCtx), op, call, round, event)
			return nil, code
		}
		if loaded == nil || !validCloudToolPath(loaded.Path) || loaded.SHA256 == "" || loaded.Size < 0 {
			_ = e.commit(toolCtx, op, CloudToolUnknown, nil, "cloud_file_load_unknown")
			return nil, &cloudToolRunError{code: "cloud_file_load_unknown", unknown: true}
		}
		result := cloudJSON(map[string]any{"file": loaded, "temporary_workspace": true, "durable": false})
		if err = e.commit(toolCtx, op, CloudToolSucceeded, result, ""); err != nil {
			return nil, err
		}
		if err = e.emit(toolCtx, op, call, round, "completed"); err != nil {
			return nil, err
		}
		return result, nil
	}
	if invocation.artifact != nil {
		publisher, ok := any(e.runtime.service).(cloudToolArtifactPublisher)
		if !ok {
			return nil, &cloudToolRunError{code: "cloud_artifact_unavailable"}
		}
		if op.State != CloudToolPrepared {
			return nil, &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true}
		}
		if _, err = e.store.StartCloudTool(toolCtx, e.run.UserID, op.ID, e.owner, e.run.Attempt); err != nil {
			return nil, err
		}
		if _, err = e.authorize(toolCtx); err != nil {
			return nil, err
		}
		_ = e.emit(toolCtx, op, call, round, "started")
		transfer := sha256.Sum256([]byte(op.ID + ":publish"))
		published, publishErr := publisher.PublishCloudArtifact(toolCtx, e.run.UserID, CloudArtifactPublication{ConversationID: e.run.ConversationID, RunID: e.run.ID, ToolOperationID: op.ID, LeaseOwner: e.owner, ExecutionAttempt: e.run.Attempt, FamilyID: invocation.artifact.FamilyID, Name: invocation.artifact.Name, MIME: invocation.artifact.MIME, WorkspaceRef: binding.WorkspaceRef, SandboxID: binding.SandboxID, Path: invocation.artifact.Path, TransferID: hex.EncodeToString(transfer[:16])})
		if publishErr != nil {
			unknown := sdkCloudToolError(publishErr).unknown || (published != nil && (published.State == CloudArtifactUnknown || published.State == CloudArtifactStaging))
			state, event, code := CloudToolFailed, "failed", "cloud_artifact_publication_failed"
			if unknown {
				state, event, code = CloudToolUnknown, "unknown", "cloud_artifact_publication_unknown"
			}
			_ = e.commit(toolCtx, op, state, nil, code)
			_ = e.emit(context.WithoutCancel(toolCtx), op, call, round, event)
			return nil, &cloudToolRunError{code: code, unknown: unknown}
		}
		if published == nil || published.State != CloudArtifactReady || published.DownloadPath == "" {
			_ = e.commit(toolCtx, op, CloudToolUnknown, nil, "cloud_artifact_publication_unknown")
			return nil, &cloudToolRunError{code: "cloud_artifact_publication_unknown", unknown: true}
		}
		result := cloudJSON(map[string]any{"artifact": published, "durable": true})
		if err = e.commit(toolCtx, op, CloudToolSucceeded, result, ""); err != nil {
			return nil, err
		}
		if err = e.emit(toolCtx, op, call, round, "completed"); err != nil {
			return nil, err
		}
		return result, nil
	}
	receipt, err = e.sdk(toolCtx, op, cloudexecutor.Operation{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef, Action: invocation.action, SandboxID: binding.SandboxID, Input: invocation.input}, func() error { return e.emit(toolCtx, op, call, round, "started") })
	if err != nil {
		if errors.Is(err, ErrCloudRunLeaseLost) || errors.Is(err, ErrNotFound) {
			return nil, err
		}
		code := sdkCloudToolError(err)
		state, event := CloudToolFailed, "failed"
		if code.unknown {
			state, event = CloudToolUnknown, "unknown"
		}
		_ = e.commit(toolCtx, op, state, nil, code.code)
		_ = e.emit(context.WithoutCancel(toolCtx), op, call, round, event)
		return nil, code
	}
	result, err := e.normalizeResult(invocation, receipt)
	if err != nil {
		code := "cloud_tool_invalid_result"
		var failure *cloudToolRunError
		if errors.As(err, &failure) {
			code = failure.code
		}
		if e.commit(toolCtx, op, CloudToolFailed, nil, code) == nil {
			acknowledgeCloudSDKReceipt(toolCtx, e.client, receipt, cloudexecutor.Scope{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef})
		}
		return nil, err
	}
	state := receipt.State
	if state != CloudToolSucceeded && state != CloudToolFailed && state != CloudToolCancelled {
		_ = e.commit(toolCtx, op, CloudToolUnknown, nil, "cloud_tool_outcome_unknown")
		return nil, &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true}
	}
	if err = e.commit(toolCtx, op, state, result, ""); err != nil {
		return nil, err
	}
	acknowledgeCloudSDKReceipt(toolCtx, e.client, receipt, cloudexecutor.Scope{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef})
	event := "completed"
	if state != CloudToolSucceeded {
		event = "failed"
	}
	if err = e.emit(toolCtx, op, call, round, event); err != nil {
		return nil, err
	}
	return result, nil
}

func (e *cloudRunToolExecution) cleanup(ctx context.Context) {
	if e.workspace == nil || e.store == nil || e.client == nil {
		return
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	items, err := e.store.RequestCloudWorkspaceCleanup(cleanupCtx, e.run.UserID, e.workspace.ID)
	if err != nil {
		return
	}
	for _, item := range items {
		if cleanupCtx.Err() != nil {
			return
		}
		e.runtime.cleanupWorkspace(cleanupCtx, e.client, e.store, item)
	}
}
