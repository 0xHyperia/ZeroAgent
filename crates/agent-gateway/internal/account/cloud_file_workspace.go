package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

func (s *Service) authorizeCloudWorkspaceLoad(ctx context.Context, userID int64, load CloudFileWorkspaceLoad) (*CloudWorkspaceBinding, error) {
	if (load.FileID == "") == (load.ArtifactVersionID == "") {
		return nil, ErrCloudFileInvalid
	}
	runs, ok := s.store.(CloudRunStore)
	if !ok {
		return nil, ErrCloudFileInvalid
	}
	run, err := runs.GetCloudRun(ctx, userID, load.RunID)
	if err != nil {
		return nil, err
	}
	if run.ConversationID != load.ConversationID || run.State != CloudRunRunning {
		return nil, ErrCloudRunLeaseLost
	}
	if err = validateCloudRunLease(run, load.LeaseOwner, load.ExecutionAttempt, time.Now()); err != nil {
		return nil, err
	}
	sessions, ok := s.store.(cloudRunSessionStore)
	if !ok {
		return nil, ErrNotFound
	}
	session, err := sessions.GetCloudRunSession(ctx, run.SessionRef)
	if err != nil {
		return nil, err
	}
	if session == nil || session.UserID != userID {
		return nil, ErrNotFound
	}
	current, err := s.Session(ctx, session.ID)
	if err != nil {
		return nil, err
	}
	if current == nil || current.UserID != userID {
		return nil, ErrNotFound
	}
	tools, ok := s.store.(CloudToolStore)
	if !ok {
		return nil, ErrCloudFileInvalid
	}
	operation, err := tools.GetCloudToolOperation(ctx, userID, load.ToolOperationID)
	if err != nil {
		return nil, err
	}
	if operation.Name != "load_uploaded_file" || operation.RunID != run.ID || operation.ConversationID != run.ConversationID || operation.ExecutionAttempt != load.ExecutionAttempt || operation.State != CloudToolExecuting {
		return nil, ErrCloudFileConflict
	}
	var args struct {
		FileID            string `json:"file_id"`
		ArtifactVersionID string `json:"artifact_version_id"`
		Path              string `json:"path"`
	}
	if json.Unmarshal(operation.Input, &args) != nil || args.FileID != load.FileID || args.ArtifactVersionID != load.ArtifactVersionID || args.Path != load.Path {
		return nil, ErrCloudFileConflict
	}
	binding, err := tools.GetCloudWorkspace(ctx, userID, run.ConversationID)
	if err != nil {
		return nil, err
	}
	if binding.State != CloudWorkspaceReady || binding.OwnerScope != cloudFileParserOwner(userID) || !binding.ExpiresAt.After(time.Now().Add(time.Second)) {
		return nil, ErrCloudFileConflict
	}
	return binding, nil
}

// LoadCloudFileToWorkspace reads a canonical owned resource, not an old VM.
// Parsing/text readiness is independent from verified raw-byte availability.
func (s *Service) LoadCloudFileToWorkspace(ctx context.Context, userID int64, load CloudFileWorkspaceLoad) (result *CloudWorkspaceLoadedFile, resultErr error) {
	binding, err := s.authorizeCloudWorkspaceLoad(ctx, userID, load)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithDeadline(ctx, binding.ExpiresAt.Add(-time.Second))
	defer cancel()
	client := s.CloudExecutor()
	if client == nil {
		return nil, objectstore.ErrDisabled
	}
	provider, err := s.cloudFileProvider()
	if err != nil {
		return nil, err
	}
	if err = acquireCloudFileSlot(ctx, provider.downloads); err != nil {
		return nil, err
	}
	defer func() { <-provider.downloads }()
	loaded := &CloudWorkspaceLoadedFile{}
	var staged *os.File
	var stillOwned func(context.Context) bool
	if load.FileID != "" {
		file, err := provider.metadata.GetCloudFile(ctx, userID, load.FileID)
		if err != nil {
			return nil, err
		}
		if file.DeletedAt != nil || file.UploadedAt == nil || file.State == CloudFileUploading || file.State == CloudFileDeleting || file.State == CloudFileDeleted {
			return nil, ErrNotFound
		}
		staged, err = provider.stageDownload(ctx, file)
		if err != nil {
			return nil, err
		}
		loaded.FileID = file.ID
		loaded.Name = file.Name
		loaded.MIME = file.MIME
		loaded.Size = file.Size
		loaded.SHA256 = file.SHA256
		stillOwned = func(ctx context.Context) bool {
			current, err := cloudFileMetadata(ctx, provider.metadata, userID, file.ID)
			return err == nil && current.DeletedAt == nil && current.UploadedAt != nil && current.SHA256 == file.SHA256
		}
	} else {
		version, err := s.ownedReadyCloudArtifact(ctx, userID, load.ArtifactVersionID)
		if err != nil {
			return nil, err
		}
		staged, err = os.CreateTemp("", "zeroagent-load-artifact-*")
		if err != nil {
			return nil, objectstore.ErrUnavailable
		}
		if err = verifyCloudArtifactObject(ctx, provider.objects, version, staged); err != nil {
			staged.Close()
			os.Remove(staged.Name())
			return nil, err
		}
		if _, err = staged.Seek(0, 0); err != nil {
			staged.Close()
			os.Remove(staged.Name())
			return nil, objectstore.ErrUnavailable
		}
		loaded.ArtifactVersionID = version.ID
		loaded.FamilyID = version.FamilyID
		loaded.Version = version.Number
		loaded.Name = version.Name
		loaded.MIME = version.MIME
		loaded.Size = version.Size
		loaded.SHA256 = version.SHA256
		stillOwned = func(ctx context.Context) bool {
			current, err := s.ownedReadyCloudArtifact(ctx, userID, version.ID)
			return err == nil && current.SHA256 == version.SHA256
		}
	}
	defer func() { staged.Close(); os.Remove(staged.Name()) }()
	loaded.Path = load.Path
	if loaded.Path == "" {
		id := loaded.FileID
		if id == "" {
			id = loaded.ArtifactVersionID
		}
		loaded.Path = "inputs/" + id + "/" + loaded.Name
	}
	if strings.HasPrefix(loaded.Path, "/") {
		return nil, ErrCloudFileInvalid
	}
	started := false
	defer func() {
		if resultErr == nil || !started {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if tools, ok := s.store.(CloudToolStore); ok {
			_, _ = tools.RequestCloudWorkspaceCleanup(cleanupCtx, userID, binding.ID)
		}
		s.signalCloudRun(load.RunID)
	}()
	tracked := client.WithOperationRunner(func(stepCtx context.Context, operation cloudexecutor.Operation) (cloudexecutor.Receipt, error) {
		current, err := s.authorizeCloudWorkspaceLoad(stepCtx, userID, load)
		if err != nil {
			return cloudexecutor.Receipt{}, err
		}
		if current.SandboxID != binding.SandboxID || current.WorkspaceRef != binding.WorkspaceRef || !stillOwned(stepCtx) {
			return cloudexecutor.Receipt{}, ErrCloudFileConflict
		}
		started = true
		return client.Execute(stepCtx, operation)
	})
	transfer := sha256.Sum256([]byte(load.ToolOperationID + ":load-resource"))
	_, err = tracked.Upload(ctx, cloudexecutor.TransferSpec{Scope: cloudexecutor.Scope{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef}, SandboxID: binding.SandboxID, TransferID: hex.EncodeToString(transfer[:16]), Path: loaded.Path, TotalBytes: loaded.Size, SHA256: loaded.SHA256}, staged)
	if err != nil {
		return nil, err
	}
	if !stillOwned(ctx) {
		return nil, ErrNotFound
	}
	if _, err = s.authorizeCloudWorkspaceLoad(ctx, userID, load); err != nil {
		return nil, err
	}
	return loaded, nil
}
