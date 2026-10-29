package account

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

type CloudFileStore interface {
	CreateCloudFile(context.Context, *CloudFile) (*CloudFile, error)
	GetCloudFile(context.Context, int64, string) (*CloudFile, error)
	// A blank conversationID lists the account library; beforeID is an opaque
	// cursor into (created_at,id) descending order. Results are always bounded.
	ListCloudFiles(context.Context, int64, string, string, int) ([]CloudFile, error)
	UpdateCloudFile(context.Context, int64, string, int64, CloudFileUpdate) (*CloudFile, error)
	// Internal cleanup/recovery only: deletion intents, and uploads/extractions
	// abandoned for 15 minutes. Never a cross-account public endpoint.
	ListCloudFileCleanup(context.Context, int) ([]CloudFile, error)
}

func validateCloudFile(file *CloudFile) error {
	if file == nil || file.UserID <= 0 || file.Size < 0 || file.Size > CloudFileMaxBytes ||
		file.State != CloudFileUploading || !validCloudFileName(file.Name) || file.MIME == "" {
		return ErrCloudFileInvalid
	}
	id, err := uuid.Parse(file.ID)
	if err != nil {
		return ErrCloudFileInvalid
	}
	if _, err := uuid.Parse(file.ConversationID); file.ConversationID != "" && err != nil {
		return ErrCloudFileInvalid
	}
	digest, err := hex.DecodeString(file.SHA256)
	if err != nil || len(digest) != 32 || strings.ToLower(file.SHA256) != file.SHA256 ||
		file.ObjectKey != cloudFileObjectKey(file.UserID, id.String()) {
		return ErrCloudFileInvalid
	}
	return nil
}

func validCloudFileName(name string) bool {
	if name == "" || name != strings.TrimSpace(name) || len(name) > 255 || !utf8.ValidString(name) || strings.ContainsAny(name, "/\\") {
		return false
	}
	for _, char := range name {
		if char < 32 || char == 127 || char >= 0x202a && char <= 0x202e || char >= 0x2066 && char <= 0x2069 {
			return false
		}
	}
	return name != "." && name != ".."
}

func updateCloudFile(file CloudFile, expectedVersion int64, update CloudFileUpdate, now time.Time) (*CloudFile, error) {
	if expectedVersion <= 0 || file.Version != expectedVersion {
		return nil, ErrCloudFileConflict
	}
	if file.DeletedAt != nil && update.State != CloudFileDeleting && update.State != CloudFileDeleted {
		return nil, ErrCloudFileConflict
	}
	if !cloudFileStateTransition(file.State, update.State) {
		return nil, ErrCloudFileInvalid
	}
	switch update.ErrorCode {
	case "", "storage_unavailable", "storage_integrity_failed", "unsupported_text_encoding", "text_extraction_limit", "parse_failed", "parse_timeout", "parse_unknown", "allocation_limit", "delete_failed", "cancelled":
	default:
		return nil, ErrCloudFileInvalid
	}
	switch update.ProcessingStage {
	case "", "uploading", "verifying", "extracting_text", "awaiting_isolated_parser", "workspace_only", "vision_ready", "creating_sandbox", "uploading_to_sandbox", "isolated_parsing", "retrieving_segments", "reconciling_parser", "complete":
	default:
		return nil, ErrCloudFileInvalid
	}
	if update.Text != nil {
		if len(*update.Text) > CloudFileMaxTextBytes || !utf8.ValidString(*update.Text) || strings.ContainsRune(*update.Text, 0) || update.State != CloudFileReady {
			return nil, ErrCloudFileInvalid
		}
		file.Text = *update.Text
		file.TextBytes = len(file.Text)
	}
	if update.ParseTask != nil {
		task := update.ParseTask
		encoded, err := json.Marshal(task)
		if err != nil || len(encoded) > 4<<20 || task.FileID != file.ID || task.SourceSHA256 != file.SHA256 || task.ID == "" || task.OwnerScope != cloudFileParserOwner(file.UserID) || task.WorkspaceRef != cloudFileParserWorkspace(file.ID, task.ID) || len(task.Operations) > 100 || !validCloudParserCleanupIDs(task.CleanupSandboxIDs) || (file.ParseTask != nil && file.ParseTask.ID != task.ID) {
			return nil, ErrCloudFileInvalid
		}
		file.ParseTask = cloneCloudFileParse(task)
		file.ParseTruncated = task.Truncated
		if task.State != "running" {
			redactCloudFileTaskBytes(file.ParseTask)
		}
	}
	if update.Segments != nil {
		encoded, err := json.Marshal(*update.Segments)
		if err != nil || len(encoded) > CloudFileMaxTextBytes || len(*update.Segments) > 5000 || update.State != CloudFileReady {
			return nil, ErrCloudFileInvalid
		}
		file.Segments = append([]CloudFileSegment(nil), (*update.Segments)...)
	}
	if update.MarkUploaded {
		if file.State != CloudFileUploading || update.State != CloudFileUploaded {
			return nil, ErrCloudFileInvalid
		}
		file.UploadedAt = &now
	}
	if (update.State == CloudFileReady || update.State == CloudFileProcessing) && file.UploadedAt == nil {
		return nil, ErrCloudFileInvalid
	}
	if update.State == CloudFileVisionReady && (file.UploadedAt == nil || file.Size <= 0 || file.Size > CloudFileMaxVisionBytes || !cloudFileVisionMIME(file.MIME) || file.Text != "" || len(file.Segments) > 0) {
		return nil, ErrCloudFileInvalid
	}
	if update.State == CloudFileDeleting && file.DeletedAt == nil {
		file.DeletedAt = &now
	}
	if update.State == CloudFileDeleting || update.State == CloudFileDeleted {
		// Keep a minimal deletion record, not the user's extracted document body.
		file.Text, file.TextBytes = "", 0
		file.Segments = nil
		file.ParseTruncated = false
		if file.ParseTask != nil {
			file.ParseTask = cloneCloudFileParse(file.ParseTask)
			redactCloudFileTaskBytes(file.ParseTask)
		}
	}
	file.State, file.ProcessingStage, file.ErrorCode = update.State, update.ProcessingStage, update.ErrorCode
	file.Version++
	file.UpdatedAt = now
	return &file, nil
}

func cloudFileStateTransition(from, to string) bool {
	if to == CloudFileDeleting {
		return true // including a terminal tombstone whose late PUT needs cleanup
	}
	switch from {
	case CloudFileUploading:
		return to == CloudFileUploaded || to == CloudFileFailed
	case CloudFileUploaded:
		return to == CloudFileProcessing || to == CloudFileReady || to == CloudFileVisionReady || to == CloudFileFailed
	case CloudFileProcessing:
		return to == CloudFileProcessing || to == CloudFileReady || to == CloudFileFailed
	case CloudFileFailed, CloudFileReady:
		return to == CloudFileProcessing || to == from
	case CloudFileVisionReady:
		return to == CloudFileVisionReady
	case CloudFileDeleting:
		return to == CloudFileDeleted
	case CloudFileDeleted:
		return to == CloudFileDeleted
	}
	return false
}

func cloneCloudFile(file CloudFile) CloudFile {
	file.ParseTask = cloneCloudFileParse(file.ParseTask)
	file.Segments = append([]CloudFileSegment(nil), file.Segments...)
	if file.UploadedAt != nil {
		value := *file.UploadedAt
		file.UploadedAt = &value
	}
	if file.DeletedAt != nil {
		value := *file.DeletedAt
		file.DeletedAt = &value
	}
	return file
}
