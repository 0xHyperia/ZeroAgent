package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"os"
	"path"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

type cloudArtifactJournal struct {
	Operations     map[string]cloudArtifactOperationFact `json:"operations"`
	PutStarted     bool                                  `json:"put_started"`
	ObjectVerified bool                                  `json:"object_verified"`
}
type cloudArtifactOperationFact struct {
	RequestHash string          `json:"request_hash"`
	State       string          `json:"state"`
	Action      string          `json:"action"`
	Result      json.RawMessage `json:"result,omitempty"`
}

func publicCloudArtifact(input *CloudArtifactVersion) *CloudArtifactVersion {
	copy := cloneCloudArtifact(*input)
	if copy.State == CloudArtifactReady && copy.DeletedAt == nil {
		copy.DownloadPath = "/api/web-chat/artifacts/versions/" + copy.ID + "/download"
	}
	return &copy
}
func existingCloudArtifactOutcome(input *CloudArtifactVersion) (*CloudArtifactVersion, error) {
	public := publicCloudArtifact(input)
	if input.DeletedAt != nil {
		return public, ErrCloudArtifactConflict
	}
	if input.State == CloudArtifactReady {
		return public, nil
	}
	if input.State == CloudArtifactStaging || input.State == CloudArtifactUnknown {
		return public, &cloudexecutor.UnknownOutcomeError{Receipt: cloudexecutor.Receipt{OperationID: input.ToolOperationID, Action: "publish_artifact", State: cloudexecutor.StateUnknown}}
	}
	return public, ErrCloudArtifactConflict
}
func (s *Service) artifactStore() (CloudArtifactStore, error) {
	store, ok := s.store.(CloudArtifactStore)
	if !ok {
		return nil, objectstore.ErrDisabled
	}
	return store, nil
}

func (s *Service) authorizeCloudArtifact(ctx context.Context, userID int64, pub CloudArtifactPublication) (*CloudWorkspaceBinding, error) {
	runs, ok := s.store.(CloudRunStore)
	if !ok {
		return nil, ErrCloudArtifactInvalid
	}
	run, err := runs.GetCloudRun(ctx, userID, pub.RunID)
	if err != nil {
		return nil, err
	}
	if run.ConversationID != pub.ConversationID {
		return nil, ErrCloudArtifactInvalid
	}
	if run.State != CloudRunRunning {
		return nil, ErrCloudRunLeaseLost
	}
	if err = validateCloudRunLease(run, pub.LeaseOwner, pub.ExecutionAttempt, time.Now()); err != nil {
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
	identity, err := s.Session(ctx, session.ID)
	if err != nil {
		return nil, err
	}
	if identity == nil || identity.UserID != userID {
		return nil, ErrNotFound
	}
	tools, ok := s.store.(CloudToolStore)
	if !ok {
		return nil, ErrCloudArtifactInvalid
	}
	op, err := tools.GetCloudToolOperation(ctx, userID, pub.ToolOperationID)
	if err != nil {
		return nil, err
	}
	if op.Name != "publish_artifact" || op.RunID != run.ID || op.ConversationID != run.ConversationID || op.State != CloudToolExecuting || op.ExecutionAttempt != pub.ExecutionAttempt {
		return nil, ErrCloudArtifactConflict
	}
	var input struct {
		Path     string `json:"path"`
		Name     string `json:"name"`
		MIME     string `json:"mime"`
		FamilyID string `json:"family_id"`
	}
	if json.Unmarshal(op.Input, &input) != nil || input.Path != pub.Path || input.Name != pub.Name || input.FamilyID != pub.FamilyID || (input.MIME != "" && pub.MIME != "" && input.MIME != pub.MIME) {
		return nil, ErrCloudArtifactConflict
	}
	binding, err := tools.GetCloudWorkspace(ctx, userID, pub.ConversationID)
	if err != nil {
		return nil, err
	}
	if binding.State != CloudWorkspaceReady || !binding.ExpiresAt.After(time.Now()) || binding.WorkspaceRef != pub.WorkspaceRef || binding.SandboxID != pub.SandboxID || binding.OwnerScope != cloudFileParserOwner(userID) {
		return nil, ErrCloudArtifactConflict
	}
	return binding, nil
}
func artifactPublicationHash(pub CloudArtifactPublication) string {
	// Only the semantic request and its server-authorized resource binding enter
	// the fingerprint; VM-derived size/digest are independently recorded later.
	data, _ := json.Marshal([]any{pub.ConversationID, pub.RunID, pub.ToolOperationID, pub.FamilyID, pub.Name, pub.MIME, pub.WorkspaceRef, pub.SandboxID, pub.Path})
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}
func artifactMIME(name, requested string) (string, error) {
	if requested == "" {
		requested = map[string]string{".csv": "text/csv", ".md": "text/markdown", ".txt": "text/plain", ".json": "application/json", ".pdf": "application/pdf", ".png": "image/png", ".svg": "image/svg+xml", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"}[strings.ToLower(path.Ext(name))]
		if requested == "" {
			requested = "application/octet-stream"
		}
	}
	media, params, err := mime.ParseMediaType(requested)
	if err != nil || len(params) > 0 || len(media) > 128 {
		return "", ErrCloudArtifactInvalid
	}
	return media, nil
}

// PublishCloudArtifact never exposes a VM path as a deliverable. Only a verified
// immutable object and atomically-ready version receives a download URL.
func (s *Service) PublishCloudArtifact(ctx context.Context, userID int64, pub CloudArtifactPublication) (result *CloudArtifactVersion, resultErr error) {
	ctx, cancelPublication := context.WithTimeout(ctx, 5*time.Minute)
	defer cancelPublication()
	store, err := s.artifactStore()
	if err != nil {
		return nil, err
	}
	if !validCloudFileName(pub.Name) || pub.Path == "" || len(pub.Path) > 1024 {
		return nil, ErrCloudArtifactInvalid
	}
	fingerprint := artifactPublicationHash(pub)
	if existing, err := store.GetCloudArtifactByOperation(ctx, userID, pub.ToolOperationID); err == nil {
		if existing.RequestHash != fingerprint {
			return nil, ErrCloudArtifactConflict
		}
		return existingCloudArtifactOutcome(existing)
	} else if !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	binding, err := s.authorizeCloudArtifact(ctx, userID, pub)
	if err != nil {
		return nil, err
	}
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
	scope := cloudexecutor.Scope{OwnerScope: binding.OwnerScope, WorkspaceRef: binding.WorkspaceRef}
	info, statReceipt, err := client.InspectFile(ctx, parserOperationID(pub.ToolOperationID, "artifact-stat"), scope, binding.SandboxID, pub.Path)
	if err != nil {
		return nil, err
	}
	if (pub.Size != 0 && pub.Size != info.Size) || (pub.SHA256 != "" && pub.SHA256 != info.SHA256) {
		return nil, ErrCloudArtifactConflict
	}
	media, err := artifactMIME(pub.Name, pub.MIME)
	if err != nil {
		return nil, err
	}
	familyID := pub.FamilyID
	if familyID == "" {
		familyID = uuid.NewString()
	}
	version, created, err := store.ReserveCloudArtifact(ctx, userID, pub.LeaseOwner, pub.ExecutionAttempt, &CloudArtifactVersion{ID: uuid.NewString(), FamilyID: familyID, ConversationID: pub.ConversationID, SourceRunID: pub.RunID, ToolOperationID: pub.ToolOperationID, RequestHash: fingerprint, Name: pub.Name, MIME: media, Size: info.Size, SHA256: info.SHA256})
	if err != nil {
		return nil, err
	}
	acknowledgeCloudSDKReceipt(ctx, client, statReceipt, scope)
	if !created {
		return existingCloudArtifactOutcome(version)
	}
	journal := cloudArtifactJournal{Operations: map[string]cloudArtifactOperationFact{}}
	putAcknowledged := false
	checkpoint := func(change func(*cloudArtifactJournal)) error {
		current, err := store.GetCloudArtifactVersion(ctx, userID, version.ID)
		if err != nil {
			return err
		}
		if current.DeletedAt != nil || current.State != CloudArtifactStaging {
			return ErrCloudArtifactConflict
		}
		change(&journal)
		encoded, _ := json.Marshal(journal)
		updated, updateErr := store.UpdateCloudArtifact(ctx, userID, version.ID, current.Version, pub.LeaseOwner, pub.ExecutionAttempt, CloudArtifactUpdate{State: CloudArtifactStaging, Journal: encoded})
		if updateErr == nil {
			version = updated
		}
		err = updateErr
		return err
	}
	defer func() {
		if resultErr == nil {
			return
		}
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		latest, getErr := store.GetCloudArtifactVersion(cleanupCtx, userID, version.ID)
		if getErr != nil || latest.State == CloudArtifactReady {
			return
		}
		if latest.DeletedAt != nil {
			code := ""
			if journal.PutStarted && !putAcknowledged {
				code = "late_write_unknown"
			}
			pending, err := store.UpdateCloudArtifact(cleanupCtx, userID, latest.ID, latest.Version, "", 0, CloudArtifactUpdate{State: CloudArtifactDeleting, ErrorCode: code})
			if err == nil && (putAcknowledged || !journal.PutStarted) {
				if err = provider.objects.Delete(cleanupCtx, pending.ObjectKey); err == nil || errors.Is(err, objectstore.ErrNotFound) {
					_, _ = store.UpdateCloudArtifact(cleanupCtx, userID, pending.ID, pending.Version, "", 0, CloudArtifactUpdate{State: CloudArtifactDeleted})
				}
			}
			return
		}
		state := CloudArtifactFailed
		code := "artifact_publication_failed"
		var unknown *cloudexecutor.UnknownOutcomeError
		if journal.PutStarted || errors.As(resultErr, &unknown) {
			state = CloudArtifactUnknown
			code = "artifact_publication_unknown"
		}
		updated, _ := store.UpdateCloudArtifact(cleanupCtx, userID, version.ID, latest.Version, pub.LeaseOwner, pub.ExecutionAttempt, CloudArtifactUpdate{State: state, ErrorCode: code})
		if updated != nil {
			result = publicCloudArtifact(updated)
		}
	}()
	tracked := client.WithOperationRunner(func(stepCtx context.Context, op cloudexecutor.Operation) (cloudexecutor.Receipt, error) {
		if _, err := s.authorizeCloudArtifact(stepCtx, userID, pub); err != nil {
			return cloudexecutor.Receipt{}, err
		}
		encoded, _ := json.Marshal(op)
		hash := sha256.Sum256(encoded)
		fact := cloudArtifactOperationFact{RequestHash: hex.EncodeToString(hash[:]), State: cloudexecutor.StateExecuting, Action: op.Action}
		if err := checkpoint(func(j *cloudArtifactJournal) { j.Operations[op.OperationID] = fact }); err != nil {
			return cloudexecutor.Receipt{}, err
		}
		receipt, err := client.Execute(stepCtx, op)
		fact.State = receipt.State
		// Byte payloads stay in the bounded private adapter journal and temporary
		// transport file, not in artifact database execution metadata.
		var metadata map[string]any
		if json.Unmarshal(receipt.Result, &metadata) == nil {
			delete(metadata, "data_base64")
			fact.Result, _ = json.Marshal(metadata)
		}
		if saveErr := checkpoint(func(j *cloudArtifactJournal) { j.Operations[op.OperationID] = fact }); saveErr != nil {
			return receipt, saveErr
		}
		acknowledgeCloudSDKReceipt(stepCtx, client, receipt, op.Scope())
		return receipt, err
	})
	staged, err := os.CreateTemp("", "zeroagent-artifact-*")
	if err != nil {
		return nil, objectstore.ErrUnavailable
	}
	defer func() { staged.Close(); os.Remove(staged.Name()) }()
	transfer := sha256.Sum256([]byte(pub.ToolOperationID + ":artifact-download"))
	transferID := pub.TransferID
	if transferID == "" {
		transferID = hex.EncodeToString(transfer[:16])
	}
	if _, err = tracked.Download(ctx, cloudexecutor.TransferSpec{Scope: scope, SandboxID: binding.SandboxID, TransferID: transferID, Path: pub.Path, TotalBytes: info.Size, SHA256: info.SHA256}, staged); err != nil {
		return nil, err
	}
	if _, err = staged.Seek(0, io.SeekStart); err != nil {
		return nil, objectstore.ErrUnavailable
	}
	if _, err = s.authorizeCloudArtifact(ctx, userID, pub); err != nil {
		return nil, err
	}
	if err = checkpoint(func(j *cloudArtifactJournal) { j.PutStarted = true }); err != nil {
		return nil, err
	}
	_, err = provider.objects.Put(ctx, version.ObjectKey, staged, info.Size, objectstore.PutOptions{ContentType: media, SHA256: info.SHA256, Metadata: cloudArtifactObjectMetadata(version)})
	if err != nil {
		return nil, err
	}
	putAcknowledged = true
	if err = verifyCloudArtifactObject(ctx, provider.objects, version, nil); err != nil {
		return nil, err
	}
	if err = checkpoint(func(j *cloudArtifactJournal) { j.ObjectVerified = true }); err != nil {
		return nil, err
	}
	if _, err = s.authorizeCloudArtifact(ctx, userID, pub); err != nil {
		return nil, err
	}
	ready, err := store.UpdateCloudArtifact(ctx, userID, version.ID, version.Version, pub.LeaseOwner, pub.ExecutionAttempt, CloudArtifactUpdate{State: CloudArtifactReady})
	if err != nil {
		return nil, err
	}
	return publicCloudArtifact(ready), nil
}

func cloudArtifactObjectMetadata(version *CloudArtifactVersion) map[string]string {
	return map[string]string{"artifact-version": version.ID, "artifact-family": version.FamilyID, "owner-scope": cloudFileParserOwner(version.UserID)}
}
func verifyCloudArtifactObject(ctx context.Context, objects objectstore.Store, version *CloudArtifactVersion, destination io.Writer) error {
	object, err := objects.Get(ctx, version.ObjectKey)
	if err != nil {
		return err
	}
	defer object.Body.Close()
	if object.Size != version.Size || object.ContentType != version.MIME || object.SHA256 != version.SHA256 {
		return objectstore.ErrIntegrity
	}
	for key, value := range cloudArtifactObjectMetadata(version) {
		if object.Metadata[key] != value {
			return objectstore.ErrIntegrity
		}
	}
	hash := sha256.New()
	var target io.Writer = hash
	if destination != nil {
		target = io.MultiWriter(hash, destination)
	}
	count, err := io.Copy(target, io.LimitReader(object.Body, CloudArtifactMaxBytes+1))
	if err != nil {
		return err
	}
	if count != version.Size || hex.EncodeToString(hash.Sum(nil)) != version.SHA256 {
		return objectstore.ErrIntegrity
	}
	return nil
}

func (s *Service) ReconcileCloudArtifacts(ctx context.Context, limit int) error {
	store, err := s.artifactStore()
	if err != nil {
		return err
	}
	provider, err := s.cloudFileProvider()
	if err != nil {
		return err
	}
	versions, err := store.ListCloudArtifactCleanup(ctx, limit)
	if err != nil {
		return err
	}
	var first error
	for _, version := range versions {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		current, err := store.UpdateCloudArtifact(ctx, version.UserID, version.ID, version.Version, "", 0, CloudArtifactUpdate{State: CloudArtifactDeleting})
		if err != nil {
			if first == nil {
				first = err
			}
			continue
		}
		if err = provider.objects.Delete(ctx, current.ObjectKey); err != nil && !errors.Is(err, objectstore.ErrNotFound) {
			if first == nil {
				first = err
			}
			continue
		}
		if current.ErrorCode == "late_write_unknown" {
			continue
		}
		_, err = store.UpdateCloudArtifact(ctx, current.UserID, current.ID, current.Version, "", 0, CloudArtifactUpdate{State: CloudArtifactDeleted})
		if err != nil && first == nil {
			first = err
		}
	}
	return first
}
