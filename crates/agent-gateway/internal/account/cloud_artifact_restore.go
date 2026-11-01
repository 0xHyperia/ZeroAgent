package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

// A user restore is a distinct operation; it cannot grant or renew an executor lease.
type CloudArtifactRestoreStore interface {
	ReserveCloudArtifactRestore(context.Context, int64, string, string, string) (*CloudArtifactVersion, bool, error)
	UpdateCloudArtifactRestore(context.Context, int64, string, int64, CloudArtifactUpdate) (*CloudArtifactVersion, error)
}
type cloudArtifactRestoreIntent struct {
	SourceID string `json:"source_id"`
	HeadID   string `json:"head_id"`
}

func prepareCloudArtifactRestore(ctx context.Context, store CloudArtifactStore, userID int64, sourceID, headID, requestID string) (*CloudArtifactVersion, *cloudArtifactRestoreIntent, error) {
	for _, id := range []string{sourceID, headID, requestID} {
		if _, err := uuid.Parse(id); err != nil {
			return nil, nil, ErrCloudArtifactInvalid
		}
	}
	source, err := store.GetCloudArtifactVersion(ctx, userID, sourceID)
	if err != nil {
		return nil, nil, err
	}
	if source.State != CloudArtifactReady || source.DeletedAt != nil {
		return nil, nil, ErrNotFound
	}
	// Site ZIPs require a release/manifest restore transaction, not merely a byte copy.
	if strings.HasSuffix(strings.ToLower(source.Name), ".zip") {
		return nil, nil, ErrCloudArtifactInvalid
	}
	intent := &cloudArtifactRestoreIntent{SourceID: sourceID, HeadID: headID}
	digest := sha256.Sum256([]byte("restore-v1:" + sourceID + ":" + headID))
	journal, _ := json.Marshal(cloudArtifactJournal{Restore: intent})
	copy := *source
	copy.ID = uuid.NewString()
	copy.ToolOperationID = uuid.NewSHA1(uuid.NameSpaceOID, []byte("zeroagent-restore:"+strconv.FormatInt(userID, 10)+":"+requestID)).String()
	copy.RequestHash = hex.EncodeToString(digest[:])
	copy.Journal = journal
	return &copy, intent, nil
}
func isCloudArtifactRestore(v CloudArtifactVersion) bool {
	var j cloudArtifactJournal
	return json.Unmarshal(v.Journal, &j) == nil && j.Restore != nil && j.Restore.SourceID != "" && j.Restore.HeadID != ""
}
func validCloudArtifactRestore(v CloudArtifactVersion, u CloudArtifactUpdate) bool {
	var j cloudArtifactJournal
	data := v.Journal
	if u.Journal != nil {
		data = u.Journal
	}
	return isCloudArtifactRestore(v) && json.Unmarshal(data, &j) == nil && j.Restore != nil && j.PutStarted && j.ObjectVerified
}

func (s *Service) RestoreCloudArtifact(ctx context.Context, userID int64, sourceID, headID, requestID string) (result *CloudArtifactVersion, err error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	store, err := s.artifactStore()
	if err != nil {
		return nil, err
	}
	restores, ok := store.(CloudArtifactRestoreStore)
	if !ok {
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
	version, created, err := restores.ReserveCloudArtifactRestore(ctx, userID, sourceID, headID, requestID)
	if err != nil {
		return nil, err
	}
	if !created {
		return existingCloudArtifactOutcome(version)
	}
	var journal cloudArtifactJournal
	if json.Unmarshal(version.Journal, &journal) != nil || journal.Restore == nil {
		return nil, ErrCloudArtifactInvalid
	}
	checkpoint := func(state string, code string) error {
		data, _ := json.Marshal(journal)
		next, writeErr := restores.UpdateCloudArtifactRestore(ctx, userID, version.ID, version.Version, CloudArtifactUpdate{State: state, ErrorCode: code, Journal: data})
		if writeErr == nil {
			version = next
		}
		return writeErr
	}
	putAcknowledged := false
	defer func() {
		if err == nil {
			return
		}
		repair, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		latest, readErr := store.GetCloudArtifactVersion(repair, userID, version.ID)
		if readErr != nil || latest.State == CloudArtifactReady {
			return
		}
		if latest.DeletedAt != nil {
			code := ""
			if journal.PutStarted && !putAcknowledged {
				code = "late_write_unknown"
			}
			pending, updateErr := store.UpdateCloudArtifact(repair, userID, latest.ID, latest.Version, "", 0, CloudArtifactUpdate{State: CloudArtifactDeleting, ErrorCode: code})
			if updateErr == nil && (putAcknowledged || !journal.PutStarted) {
				if deleteErr := provider.objects.Delete(repair, pending.ObjectKey); deleteErr == nil || errors.Is(deleteErr, objectstore.ErrNotFound) {
					_, _ = store.UpdateCloudArtifact(repair, userID, pending.ID, pending.Version, "", 0, CloudArtifactUpdate{State: CloudArtifactDeleted})
				}
			}
			return
		}
		state := CloudArtifactFailed
		code := "restore_failed"
		if journal.PutStarted {
			state = CloudArtifactUnknown
			code = "restore_copy_unknown"
		}
		data, _ := json.Marshal(journal)
		_, _ = restores.UpdateCloudArtifactRestore(repair, userID, version.ID, latest.Version, CloudArtifactUpdate{State: state, ErrorCode: code, Journal: data})
	}()
	source, err := store.GetCloudArtifactVersion(ctx, userID, sourceID)
	if err != nil {
		return nil, err
	}
	if source.State != CloudArtifactReady || source.DeletedAt != nil {
		return nil, ErrNotFound
	}
	staged, err := os.CreateTemp("", "zeroagent-artifact-restore-*")
	if err != nil {
		return nil, objectstore.ErrUnavailable
	}
	defer func() { staged.Close(); os.Remove(staged.Name()) }()
	if err = verifyCloudArtifactObject(ctx, provider.objects, source, staged); err != nil {
		return nil, err
	}
	if _, err = staged.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	journal.PutStarted = true
	if err = checkpoint(CloudArtifactStaging, ""); err != nil {
		return nil, err
	}
	_, err = provider.objects.Put(ctx, version.ObjectKey, staged, version.Size, objectstore.PutOptions{ContentType: version.MIME, SHA256: version.SHA256, Metadata: cloudArtifactObjectMetadata(version)})
	if err != nil {
		return nil, err
	}
	putAcknowledged = true
	if err = verifyCloudArtifactObject(ctx, provider.objects, version, nil); err != nil {
		return nil, err
	}
	journal.ObjectVerified = true
	if err = checkpoint(CloudArtifactReady, ""); err != nil {
		return nil, err
	}
	return publicCloudArtifact(version), nil
}

// A lost HTTP response is resolved read-only by the same client request ID.
func (s *Service) CloudArtifactRestoreReceipt(ctx context.Context, userID int64, requestID string) (*CloudArtifactVersion, error) {
	if _, err := uuid.Parse(requestID); err != nil {
		return nil, ErrCloudArtifactInvalid
	}
	store, err := s.artifactStore()
	if err != nil {
		return nil, err
	}
	operation := uuid.NewSHA1(uuid.NameSpaceOID, []byte("zeroagent-restore:"+strconv.FormatInt(userID, 10)+":"+requestID)).String()
	v, err := store.GetCloudArtifactByOperation(ctx, userID, operation)
	if err != nil {
		return nil, err
	}
	if !isCloudArtifactRestore(*v) || v.DeletedAt != nil {
		return nil, ErrNotFound
	}
	return publicCloudArtifact(v), nil
}
