package account

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

type cloudFileParser struct {
	service    *Service
	client     *cloudexecutor.Client
	provider   *cloudFileService
	store      CloudFileParserStore
	instance   string
	mu         sync.Mutex
	active     map[string]context.CancelFunc
	activeDone map[string]chan struct{}
	cancel     context.CancelFunc
	done       chan struct{}
	wg         sync.WaitGroup
}

func (s *Service) SetCloudExecutor(client *cloudexecutor.Client) error {
	s.cloudFileMu.Lock()
	defer s.cloudFileMu.Unlock()
	if s.cloudFileParser != nil {
		return ErrCloudFileConflict
	}
	s.cloudExecutor = client
	return nil
}

func (s *Service) CloudExecutor() *cloudexecutor.Client {
	s.cloudFileMu.RLock()
	defer s.cloudFileMu.RUnlock()
	return s.cloudExecutor
}

func (s *Service) StartCloudFileParser(ctx context.Context) error {
	s.cloudFileMu.Lock()
	defer s.cloudFileMu.Unlock()
	if s.cloudExecutor == nil {
		return nil
	}
	if s.cloudFileParser != nil {
		return ErrCloudFileConflict
	}
	if s.cloudFiles == nil {
		return objectstore.ErrDisabled
	}
	store, ok := s.store.(CloudFileParserStore)
	if !ok {
		return ErrCloudFileInvalid
	}
	workerCtx, cancel := context.WithCancel(ctx)
	parser := &cloudFileParser{service: s, client: s.cloudExecutor, provider: s.cloudFiles, store: store, instance: uuid.NewString(), active: map[string]context.CancelFunc{}, activeDone: map[string]chan struct{}{}, cancel: cancel, done: make(chan struct{})}
	s.cloudFileParser = parser
	go parser.loop(workerCtx)
	return nil
}

func (s *Service) CloseCloudFileParser() {
	s.cloudFileMu.RLock()
	parser := s.cloudFileParser
	s.cloudFileMu.RUnlock()
	if parser == nil {
		return
	}
	parser.cancel()
	<-parser.done
	s.cloudFileMu.Lock()
	if s.cloudFileParser == parser {
		s.cloudFileParser = nil
	}
	s.cloudFileMu.Unlock()
}

func cloudFileParserOwner(userID int64) string {
	hash := sha256.Sum256([]byte(strconv.FormatInt(userID, 10)))
	return "account-" + hex.EncodeToString(hash[:16])
}
func cloudFileParserWorkspace(fileID, taskID string) string { return "file-" + fileID + "-" + taskID }
func cloudFileParserFormat(file CloudFile) string {
	switch extension := strings.ToLower(path.Ext(file.Name)); extension {
	case ".pdf", ".docx", ".xlsx", ".pptx":
		return extension[1:]
	}
	return ""
}
func cloudFileNeedsParser(file CloudFile) bool {
	if file.ParseTask != nil && !file.ParseTask.VMStopped {
		return true
	}
	return file.DeletedAt == nil && file.State == CloudFileUploaded && file.ParseTask == nil && cloudFileParserFormat(file) != ""
}

func (p *cloudFileParser) loop(ctx context.Context) {
	defer close(p.done)
	defer p.wg.Wait()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		health, err := p.client.Health(ctx)
		if err == nil && health.Enabled {
			files, err := p.store.ListCloudFileParserCandidates(ctx, 20)
			if err == nil {
				for _, file := range files {
					p.mu.Lock()
					_, exists := p.active[file.ID]
					if exists || len(p.active) >= 2 {
						p.mu.Unlock()
						continue
					}
					if file.ParseTask != nil && file.ParseTask.State == "running" && file.DeletedAt == nil && file.ParseTask.LeaseUntil.After(time.Now()) && file.ParseTask.LeaseOwner != p.instance {
						p.mu.Unlock()
						continue
					}
					workCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
					p.active[file.ID] = cancel
					p.activeDone[file.ID] = make(chan struct{})
					p.wg.Add(1)
					p.mu.Unlock()
					go func(file CloudFile) {
						defer p.wg.Done()
						defer cancel()
						defer func() {
							p.mu.Lock()
							close(p.activeDone[file.ID])
							delete(p.activeDone, file.ID)
							delete(p.active, file.ID)
							p.mu.Unlock()
						}()
						_ = p.process(workCtx, file.UserID, file.ID)
					}(file)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func parserOperationID(taskID, step string) string {
	hash := sha256.Sum256([]byte(taskID + ":" + step))
	return "fileparse-" + hex.EncodeToString(hash[:])
}

type fileParseExecution struct {
	parser                     *cloudFileParser
	userID                     int64
	fileID, taskID, leaseOwner string
	allowDeleted               bool
}

func (e *fileParseExecution) load(ctx context.Context) (*CloudFile, error) {
	file, err := e.parser.provider.metadata.GetCloudFile(ctx, e.userID, e.fileID)
	if err != nil {
		return nil, err
	}
	if file.ParseTask == nil || file.ParseTask.ID != e.taskID || file.ParseTask.LeaseOwner != e.leaseOwner || (!e.allowDeleted && file.DeletedAt != nil) {
		return nil, ErrCloudFileConflict
	}
	return file, nil
}
func (e *fileParseExecution) persist(ctx context.Context, change func(*CloudFileParseTask)) (*CloudFile, error) {
	for attempt := 0; attempt < 3; attempt++ {
		file, err := e.load(ctx)
		if err != nil {
			return nil, err
		}
		task := cloneCloudFileParse(file.ParseTask)
		change(task)
		if !e.allowDeleted {
			task.LeaseUntil = time.Now().Add(6 * time.Minute)
		}
		result, err := e.parser.provider.metadata.UpdateCloudFile(ctx, e.userID, e.fileID, file.Version, CloudFileUpdate{State: file.State, ProcessingStage: file.ProcessingStage, ErrorCode: file.ErrorCode, ParseTask: task})
		if !errors.Is(err, ErrCloudFileConflict) {
			return result, err
		}
	}
	return nil, ErrCloudFileConflict
}
func (e *fileParseExecution) operation(ctx context.Context, operation cloudexecutor.Operation) (cloudexecutor.Receipt, error) {
	file, err := e.load(ctx)
	if err != nil {
		return cloudexecutor.Receipt{}, err
	}
	if operation.OwnerScope != file.ParseTask.OwnerScope || operation.WorkspaceRef != file.ParseTask.WorkspaceRef {
		return cloudexecutor.Receipt{}, ErrCloudFileInvalid
	}
	encoded, _ := json.Marshal(operation)
	hash := sha256.Sum256(encoded)
	fingerprint := hex.EncodeToString(hash[:])
	fact, known := file.ParseTask.Operations[operation.OperationID]
	if known && fact.RequestHash != fingerprint {
		return cloudexecutor.Receipt{}, ErrCloudFileConflict
	}
	var receipt cloudexecutor.Receipt
	if known && fact.Receipt.Terminal() {
		if fact.Receipt.State == cloudexecutor.StateUnknown {
			return fact.Receipt, &cloudexecutor.UnknownOutcomeError{Receipt: fact.Receipt}
		}
		acknowledgeCloudSDKReceipt(ctx, e.parser.client, fact.Receipt, operation.Scope())
		return fact.Receipt, nil
	}
	if known && fact.Dispatched {
		// Restart recovery only queries the original ID. Missing receipts and
		// unknown provider effects never become a new Submit.
		receipt, err = e.parser.client.Get(ctx, operation.OperationID, operation.Scope())
		if err != nil {
			receipt = cloudexecutor.Receipt{OperationID: operation.OperationID, Action: operation.Action, State: cloudexecutor.StateUnknown}
			err = &cloudexecutor.UnknownOutcomeError{Receipt: receipt}
		}
		if err == nil && !receipt.Terminal() {
			receipt.State = cloudexecutor.StateUnknown
			err = &cloudexecutor.UnknownOutcomeError{Receipt: receipt}
		}
	} else {
		if operation.Action == "sandbox.create" {
			allocations, ok := e.parser.provider.metadata.(CloudAllocationStore)
			if !ok {
				return cloudexecutor.Receipt{}, ErrCloudFileInvalid
			}
			if _, _, err = allocations.ReserveCloudAllocation(ctx, e.userID, operation.OperationID, "file_parser", 300, CloudAllocationDefaultDailySeconds); err != nil {
				return cloudexecutor.Receipt{}, err
			}
		}
		_, err = e.persist(ctx, func(task *CloudFileParseTask) {
			if task.Operations == nil {
				task.Operations = map[string]CloudFileParseOperation{}
			}
			task.Operations[operation.OperationID] = CloudFileParseOperation{RequestHash: fingerprint, Dispatched: true, Receipt: cloudexecutor.Receipt{OperationID: operation.OperationID, Action: operation.Action, State: cloudexecutor.StateExecuting}}
		})
		if err != nil {
			return cloudexecutor.Receipt{}, err
		}
		receipt, err = e.parser.client.Execute(ctx, operation)
		if receipt.OperationID == "" {
			receipt = cloudexecutor.Receipt{OperationID: operation.OperationID, Action: operation.Action, State: cloudexecutor.StateFailed}
			var api *cloudexecutor.APIError
			if errors.As(err, &api) && api.MayHaveExecuted {
				receipt.State = cloudexecutor.StateUnknown
			}
		}
	}
	if receipt.State == cloudexecutor.StateUnknown && err == nil {
		err = &cloudexecutor.UnknownOutcomeError{Receipt: receipt}
	}
	checkpointCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, saveErr := e.persist(checkpointCtx, func(task *CloudFileParseTask) {
		task.Operations[operation.OperationID] = CloudFileParseOperation{RequestHash: fingerprint, Dispatched: true, Receipt: receipt}
		if operation.Action == "sandbox.create" {
			var result struct {
				SandboxID string `json:"sandbox_id"`
			}
			if json.Unmarshal(receipt.Result, &result) == nil && result.SandboxID != "" {
				task.SandboxID = result.SandboxID
			}
		}
	})
	if saveErr != nil {
		return receipt, saveErr
	}
	acknowledgeCloudSDKReceipt(ctx, e.parser.client, receipt, operation.Scope())
	return receipt, err
}

func (p *cloudFileParser) process(ctx context.Context, userID int64, id string) error {
	file, err := p.provider.metadata.GetCloudFile(ctx, userID, id)
	if err != nil {
		return err
	}
	if file.ParseTask != nil && (file.DeletedAt != nil || file.ParseTask.State == "complete" || file.ParseTask.State == "failed" || file.ParseTask.State == "unknown") {
		return p.cleanup(ctx, file)
	}
	if file.ParseTask == nil {
		if file.State != CloudFileUploaded || file.DeletedAt != nil || cloudFileParserFormat(*file) == "" {
			return nil
		}
		taskID := uuid.NewString()
		task := &CloudFileParseTask{ID: taskID, FileID: file.ID, SourceSHA256: file.SHA256, OwnerScope: cloudFileParserOwner(userID), WorkspaceRef: cloudFileParserWorkspace(file.ID, taskID), State: "running", Stage: "creating_sandbox", LeaseOwner: p.instance, LeaseUntil: time.Now().Add(6 * time.Minute), Operations: map[string]CloudFileParseOperation{}}
		file, err = p.provider.metadata.UpdateCloudFile(ctx, userID, id, file.Version, CloudFileUpdate{State: CloudFileProcessing, ProcessingStage: task.Stage, ParseTask: task})
		if err != nil {
			return err
		}
	} else {
		if file.ParseTask.LeaseOwner != p.instance && file.ParseTask.LeaseUntil.After(time.Now()) {
			return ErrCloudFileBusy
		}
		task := cloneCloudFileParse(file.ParseTask)
		task.LeaseOwner = p.instance
		task.LeaseUntil = time.Now().Add(6 * time.Minute)
		file, err = p.provider.metadata.UpdateCloudFile(ctx, userID, id, file.Version, CloudFileUpdate{State: CloudFileProcessing, ProcessingStage: "reconciling_parser", ParseTask: task})
		if err != nil {
			return err
		}
	}
	execution := &fileParseExecution{parser: p, userID: userID, fileID: id, taskID: file.ParseTask.ID, leaseOwner: p.instance}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		latest, getErr := p.provider.metadata.GetCloudFile(cleanupCtx, userID, id)
		if getErr == nil {
			_ = p.cleanup(cleanupCtx, latest)
		}
	}()
	err = p.extract(ctx, execution, file)
	if err != nil {
		failCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		latest, getErr := execution.load(failCtx)
		if getErr == nil && latest.DeletedAt == nil {
			task := cloneCloudFileParse(latest.ParseTask)
			task.State = "failed"
			code := "parse_failed"
			var unknown *cloudexecutor.UnknownOutcomeError
			if errors.As(err, &unknown) {
				task.State = "unknown"
				code = "parse_unknown"
			} else if errors.Is(err, ErrCloudToolQuota) {
				code = "allocation_limit"
			} else if errors.Is(err, context.DeadlineExceeded) {
				code = "parse_timeout"
			} else if errors.Is(err, context.Canceled) {
				code = "cancelled"
			}
			_, _ = p.provider.metadata.UpdateCloudFile(failCtx, userID, id, latest.Version, CloudFileUpdate{State: CloudFileFailed, ErrorCode: code, ParseTask: task})
		}
	}
	return err
}

func (p *cloudFileParser) extract(ctx context.Context, e *fileParseExecution, file *CloudFile) error {
	task := file.ParseTask
	create := cloudexecutor.Operation{OperationID: parserOperationID(task.ID, "create"), OwnerScope: task.OwnerScope, WorkspaceRef: task.WorkspaceRef, Action: "sandbox.create"}
	receipt, err := e.operation(ctx, create)
	if err != nil {
		return err
	}
	if receipt.State != cloudexecutor.StateSucceeded {
		return &cloudexecutor.OutcomeError{Receipt: receipt}
	}
	var vm struct {
		SandboxID string `json:"sandbox_id"`
	}
	if json.Unmarshal(receipt.Result, &vm) != nil || vm.SandboxID == "" {
		return ErrCloudFileInvalid
	}
	setStage := func(stage string) error {
		current, err := e.load(ctx)
		if err != nil {
			return err
		}
		updated := cloneCloudFileParse(current.ParseTask)
		updated.Stage = stage
		updated.SandboxID = vm.SandboxID
		_, err = p.provider.metadata.UpdateCloudFile(ctx, e.userID, e.fileID, current.Version, CloudFileUpdate{State: CloudFileProcessing, ProcessingStage: stage, ParseTask: updated})
		return err
	}
	if err = setStage("uploading_to_sandbox"); err != nil {
		return err
	}
	staged, err := p.provider.stageDownload(ctx, file)
	if err != nil {
		return err
	}
	defer func() { staged.Close(); os.Remove(staged.Name()) }()
	client := p.client.WithOperationRunner(e.operation)
	transferID := sha256.Sum256([]byte(task.ID + ":original"))
	sourcePath := "original/document." + cloudFileParserFormat(*file)
	spec := cloudexecutor.TransferSpec{Scope: create.Scope(), SandboxID: vm.SandboxID, TransferID: hex.EncodeToString(transferID[:16]), Path: sourcePath, TotalBytes: file.Size, SHA256: file.SHA256}
	if _, err = client.Upload(ctx, spec, staged); err != nil {
		return err
	}
	if err = setStage("isolated_parsing"); err != nil {
		return err
	}
	parsed, _, err := client.Parse(ctx, cloudexecutor.ParseSpec{Scope: create.Scope(), OperationID: parserOperationID(task.ID, "parse"), SandboxID: vm.SandboxID, Path: sourcePath, OutputPath: "derived/text.json", Format: cloudFileParserFormat(*file), SourceSHA256: file.SHA256})
	if err != nil {
		return err
	}
	if err = setStage("retrieving_segments"); err != nil {
		return err
	}
	downloadID := sha256.Sum256([]byte(task.ID + ":result"))
	output := bytes.Buffer{}
	_, err = client.Download(ctx, cloudexecutor.TransferSpec{Scope: create.Scope(), SandboxID: vm.SandboxID, TransferID: hex.EncodeToString(downloadID[:16]), Path: parsed.OutputPath, TotalBytes: parsed.Bytes, SHA256: parsed.SHA256}, &output)
	if err != nil {
		return err
	}
	document, text, err := validateCloudFileParsedOutput(output.Bytes(), file, vm.SandboxID, parsed)
	if err != nil {
		return err
	}
	latest, err := e.load(ctx)
	if err != nil {
		return err
	}
	completed := cloneCloudFileParse(latest.ParseTask)
	completed.State = "complete"
	completed.Stage = "complete"
	completed.Truncated = document.Truncated
	completed.Warnings = document.Warnings
	_, err = p.provider.metadata.UpdateCloudFile(ctx, e.userID, e.fileID, latest.Version, CloudFileUpdate{State: CloudFileReady, ProcessingStage: "complete", Text: &text, Segments: &document.Segments, ParseTask: completed})
	return err
}

func (p *cloudFileParser) cleanup(ctx context.Context, file *CloudFile) error {
	latest, err := p.provider.metadata.GetCloudFile(ctx, file.UserID, file.ID)
	if err != nil {
		return err
	}
	file = latest
	if file.ParseTask == nil || file.ParseTask.VMStopped {
		return nil
	}
	task := file.ParseTask
	e := &fileParseExecution{parser: p, userID: file.UserID, fileID: file.ID, taskID: task.ID, leaseOwner: task.LeaseOwner, allowDeleted: true}
	if task.SandboxID == "" {
		id := parserOperationID(task.ID, "create")
		fact, exists := task.Operations[id]
		if !exists {
			task = cloneCloudFileParse(task)
			task.VMStopped = true
			_, err := p.provider.metadata.UpdateCloudFile(ctx, file.UserID, file.ID, file.Version, CloudFileUpdate{State: file.State, ProcessingStage: file.ProcessingStage, ErrorCode: file.ErrorCode, ParseTask: task})
			return err
		}
		receipt := fact.Receipt
		if !receipt.Terminal() || receipt.State == cloudexecutor.StateUnknown {
			if current, getErr := p.client.Get(ctx, id, cloudexecutor.Scope{OwnerScope: task.OwnerScope, WorkspaceRef: task.WorkspaceRef}); getErr == nil {
				receipt = current
			}
		}
		var result struct {
			SandboxID string `json:"sandbox_id"`
		}
		_ = json.Unmarshal(receipt.Result, &result)
		if cloudToolIdentifier.MatchString(result.SandboxID) {
			file, err = e.persist(ctx, func(task *CloudFileParseTask) { task.SandboxID = result.SandboxID })
		} else {
			file, err = e.reconcileSandboxes(ctx, file)
		}
		if err != nil {
			return err
		}
		task = file.ParseTask
	}
	ids := append([]string(nil), task.CleanupSandboxIDs...)
	contains := false
	for _, id := range ids {
		if id == task.SandboxID {
			contains = true
		}
	}
	if !contains {
		ids = append(ids, task.SandboxID)
	}
	if !validCloudParserCleanupIDs(ids) {
		return ErrCloudFileInvalid
	}
	if len(task.CleanupSandboxIDs) != len(ids) {
		file, err = e.persist(ctx, func(task *CloudFileParseTask) { task.CleanupSandboxIDs = ids })
		if err != nil {
			return err
		}
		task = file.ParseTask
	}
	for _, sandboxID := range ids {
		step := "kill:" + sandboxID
		if sandboxID == task.SandboxID {
			step = "kill"
		}
		receipt, err := e.operation(ctx, cloudexecutor.Operation{OperationID: parserOperationID(task.ID, step), OwnerScope: task.OwnerScope, WorkspaceRef: task.WorkspaceRef, Action: "sandbox.kill", SandboxID: sandboxID})
		if err != nil {
			return err
		}
		var result struct {
			SandboxID  string `json:"sandbox_id"`
			Terminated bool   `json:"sandbox_terminated"`
		}
		if receipt.State != cloudexecutor.StateSucceeded || json.Unmarshal(receipt.Result, &result) != nil || result.SandboxID != sandboxID || !result.Terminated {
			return ErrCloudFileConflict
		}
	}
	_, err = e.persist(ctx, func(task *CloudFileParseTask) { task.VMStopped = true })
	return err
}

func (s *Service) cancelCloudFileParser(ctx context.Context, file *CloudFile) error {
	s.cloudFileMu.RLock()
	p := s.cloudFileParser
	client := s.cloudExecutor
	provider := s.cloudFiles
	s.cloudFileMu.RUnlock()
	if file.ParseTask == nil || file.ParseTask.VMStopped {
		return nil
	}
	if p != nil {
		p.mu.Lock()
		cancel := p.active[file.ID]
		done := p.activeDone[file.ID]
		p.mu.Unlock()
		if cancel != nil {
			cancel()
			if done != nil {
				select {
				case <-ctx.Done():
					return ctx.Err()
				case <-done:
				}
			}
		}
		return p.cleanup(ctx, file)
	}
	if client == nil || provider == nil {
		return objectstore.ErrUnavailable
	}
	return (&cloudFileParser{service: s, client: client, provider: provider}).cleanup(ctx, file)
}
