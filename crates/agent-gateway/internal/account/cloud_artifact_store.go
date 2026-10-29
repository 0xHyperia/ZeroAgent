package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"mime"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

type CloudArtifactStore interface {
	ReserveCloudArtifact(context.Context, int64, string, int64, *CloudArtifactVersion) (*CloudArtifactVersion, bool, error)
	GetCloudArtifactVersion(context.Context, int64, string) (*CloudArtifactVersion, error)
	GetCloudArtifactByOperation(context.Context, int64, string) (*CloudArtifactVersion, error)
	ListCloudArtifacts(context.Context, int64, string, string, string, int) (*CloudArtifactPage, error)
	UpdateCloudArtifact(context.Context, int64, string, int64, string, int64, CloudArtifactUpdate) (*CloudArtifactVersion, error)
	DeleteCloudArtifactFamily(context.Context, int64, string) ([]CloudArtifactVersion, error)
	ListCloudArtifactCleanup(context.Context, int) ([]CloudArtifactVersion, error)
}

func cloudArtifactObjectKey(userID int64, familyID, versionID string) string {
	hash := sha256.Sum256([]byte(strconv.FormatInt(userID, 10)))
	return "accounts/" + hex.EncodeToString(hash[:16]) + "/artifacts/" + familyID + "/" + versionID + "/content"
}

func prepareCloudArtifact(input *CloudArtifactVersion, userID int64, now time.Time) (*CloudArtifactVersion, error) {
	if input == nil || userID <= 0 || !validCloudFileName(input.Name) || input.Size < 0 || input.Size > CloudArtifactMaxBytes {
		return nil, ErrCloudArtifactInvalid
	}
	version := *input
	for _, id := range []string{version.ID, version.FamilyID, version.ConversationID, version.SourceRunID, version.ToolOperationID} {
		if _, err := uuid.Parse(id); err != nil {
			return nil, ErrCloudArtifactInvalid
		}
	}
	for _, digest := range []string{version.SHA256, version.RequestHash} {
		data, err := hex.DecodeString(digest)
		if err != nil || len(data) != 32 || strings.ToLower(digest) != digest {
			return nil, ErrCloudArtifactInvalid
		}
	}
	if media, params, err := mime.ParseMediaType(version.MIME); err != nil || media != version.MIME || len(params) > 0 || len(version.MIME) > 128 {
		return nil, ErrCloudArtifactInvalid
	}
	version.UserID = userID
	version.Number = 0
	version.State = CloudArtifactStaging
	version.ErrorCode = ""
	version.Version = 1
	version.CreatedAt = now.UTC()
	version.UpdatedAt = version.CreatedAt
	version.DeletedAt = nil
	version.DownloadPath = ""
	version.ObjectKey = cloudArtifactObjectKey(userID, version.FamilyID, version.ID)
	if len(version.Journal) > 2<<20 || (len(version.Journal) > 0 && !json.Valid(version.Journal)) {
		return nil, ErrCloudArtifactInvalid
	}
	version.Journal = append(json.RawMessage(nil), version.Journal...)
	return &version, nil
}
func cloneCloudArtifact(input CloudArtifactVersion) CloudArtifactVersion {
	input.Journal = append(json.RawMessage(nil), input.Journal...)
	if input.DeletedAt != nil {
		value := *input.DeletedAt
		input.DeletedAt = &value
	}
	input.DownloadPath = ""
	return input
}
func updateCloudArtifact(version CloudArtifactVersion, expected int64, update CloudArtifactUpdate, now time.Time) (*CloudArtifactVersion, error) {
	if expected <= 0 || version.Version != expected {
		return nil, ErrCloudArtifactConflict
	}
	if version.DeletedAt != nil && update.State != CloudArtifactDeleting && update.State != CloudArtifactDeleted {
		return nil, ErrCloudArtifactConflict
	}
	switch update.State {
	case CloudArtifactStaging, CloudArtifactReady, CloudArtifactFailed, CloudArtifactUnknown, CloudArtifactDeleting, CloudArtifactDeleted:
	default:
		return nil, ErrCloudArtifactInvalid
	}
	if version.State == CloudArtifactReady && update.State != CloudArtifactReady && update.State != CloudArtifactDeleting {
		return nil, ErrCloudArtifactConflict
	}
	if version.State == CloudArtifactDeleted && update.State != CloudArtifactDeleted && update.State != CloudArtifactDeleting {
		return nil, ErrCloudArtifactConflict
	}
	if update.State == CloudArtifactReady && version.State != CloudArtifactStaging && version.State != CloudArtifactReady {
		return nil, ErrCloudArtifactConflict
	}
	if len(update.ErrorCode) > 80 || len(update.Journal) > 2<<20 || (len(update.Journal) > 0 && !json.Valid(update.Journal)) {
		return nil, ErrCloudArtifactInvalid
	}
	if update.Journal != nil {
		version.Journal = append(json.RawMessage(nil), update.Journal...)
	}
	if update.State == CloudArtifactDeleting || update.State == CloudArtifactDeleted {
		var journal cloudArtifactJournal
		if update.State == CloudArtifactDeleting && json.Unmarshal(version.Journal, &journal) == nil && journal.PutStarted && !journal.ObjectVerified {
			update.ErrorCode = "late_write_unknown"
		}
		if version.DeletedAt == nil {
			value := now.UTC()
			version.DeletedAt = &value
		}
	}
	version.State = update.State
	version.ErrorCode = update.ErrorCode
	version.Version++
	version.UpdatedAt = now.UTC()
	return &version, nil
}
