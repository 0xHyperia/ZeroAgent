package account

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"
)

func canonicalCloudFileID(id string) (string, error) {
	parsed, err := uuid.Parse(id)
	if err != nil {
		return "", ErrCloudFileInvalid
	}
	return parsed.String(), nil
}

func prepareCloudFile(input *CloudFile, now time.Time) (*CloudFile, error) {
	if err := validateCloudFile(input); err != nil {
		return nil, err
	}
	file := cloneCloudFile(*input)
	file.ID, _ = canonicalCloudFileID(file.ID)
	file.ConversationID, _ = canonicalCloudFileID(file.ConversationID)
	file.Text, file.TextBytes, file.ErrorCode = "", 0, ""
	file.ParseTask, file.Segments = nil, nil
	file.ParseTruncated = false
	file.Version, file.CreatedAt, file.UpdatedAt = 1, now.UTC(), now.UTC()
	file.UploadedAt, file.DeletedAt = nil, nil
	file.ProcessingStage = "uploading"
	return &file, nil
}

func validateCloudFileList(conversationID, beforeID string, limit int) (string, string, error) {
	var err error
	if conversationID != "" {
		conversationID, err = canonicalCloudFileID(conversationID)
		if err != nil {
			return "", "", err
		}
	}
	if beforeID != "" {
		beforeID, err = canonicalCloudFileID(beforeID)
		if err != nil {
			return "", "", err
		}
	}
	if limit < 1 || limit > 101 {
		return "", "", ErrCloudFileInvalid
	}
	return conversationID, beforeID, nil
}

func (s *MemoryStore) CreateCloudFile(ctx context.Context, input *CloudFile) (*CloudFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	file, err := prepareCloudFile(input, s.now())
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	conversation, exists := s.cloudConversations[file.ConversationID]
	if !exists || conversation.UserID != file.UserID {
		return nil, ErrNotFound
	}
	if s.cloudFiles == nil {
		s.cloudFiles = make(map[string]CloudFile)
	}
	if _, exists := s.cloudFiles[file.ID]; exists {
		return nil, ErrCloudFileConflict
	}
	var usedBytes int64
	count := 0
	for _, other := range s.cloudFiles {
		if other.ObjectKey == file.ObjectKey {
			return nil, ErrCloudFileConflict
		}
		if other.UserID == file.UserID && other.State != CloudFileDeleted {
			count++
			usedBytes += other.Size
		}
	}
	if count >= CloudFileMaxAccountFiles || usedBytes+file.Size > CloudFileMaxAccountBytes {
		return nil, ErrCloudFileQuota
	}
	s.cloudFiles[file.ID] = cloneCloudFile(*file)
	return file, nil
}

func (s *MemoryStore) GetCloudFile(ctx context.Context, userID int64, id string) (*CloudFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id, err := canonicalCloudFileID(id)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	file, exists := s.cloudFiles[id]
	if !exists || file.UserID != userID {
		return nil, ErrNotFound
	}
	copy := cloneCloudFile(file)
	return &copy, nil
}

func (s *MemoryStore) ListCloudFiles(ctx context.Context, userID int64, conversationID, beforeID string, limit int) ([]CloudFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	conversationID, beforeID, err := validateCloudFileList(conversationID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if conversationID != "" {
		conversation, exists := s.cloudConversations[conversationID]
		if !exists || conversation.UserID != userID {
			return nil, ErrNotFound
		}
	}
	var before CloudFile
	if beforeID != "" {
		var exists bool
		before, exists = s.cloudFiles[beforeID]
		if !exists || before.UserID != userID || conversationID != "" && before.ConversationID != conversationID {
			return nil, ErrNotFound
		}
	}
	files := make([]CloudFile, 0)
	for _, file := range s.cloudFiles {
		if file.UserID != userID || file.DeletedAt != nil || conversationID != "" && file.ConversationID != conversationID {
			continue
		}
		if beforeID != "" && (!file.CreatedAt.Before(before.CreatedAt) && !(file.CreatedAt.Equal(before.CreatedAt) && file.ID < before.ID)) {
			continue
		}
		metadata := file
		metadata.Text = ""
		metadata.Segments = nil
		metadata.ParseTask = nil
		files = append(files, cloneCloudFile(metadata))
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].CreatedAt.Equal(files[j].CreatedAt) {
			return files[i].ID > files[j].ID
		}
		return files[i].CreatedAt.After(files[j].CreatedAt)
	})
	if len(files) > limit {
		files = files[:limit]
	}
	return files, nil
}

func (s *MemoryStore) UpdateCloudFile(ctx context.Context, userID int64, id string, version int64, update CloudFileUpdate) (*CloudFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id, err := canonicalCloudFileID(id)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file, exists := s.cloudFiles[id]
	if !exists || file.UserID != userID {
		return nil, ErrNotFound
	}
	result, err := updateCloudFile(file, version, update, s.now().UTC())
	if err != nil {
		return nil, err
	}
	s.cloudFiles[id] = cloneCloudFile(*result)
	return result, nil
}

func (s *MemoryStore) ListCloudFileCleanup(ctx context.Context, limit int) ([]CloudFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 100 {
		return nil, ErrCloudFileInvalid
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	files := make([]CloudFile, 0)
	for _, file := range s.cloudFiles {
		if file.State == CloudFileDeleting || (file.State == CloudFileUploading || file.State == CloudFileProcessing) && file.UpdatedAt.Before(s.now().Add(-15*time.Minute)) {
			files = append(files, cloneCloudFile(file))
		}
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].UpdatedAt.Equal(files[j].UpdatedAt) {
			return files[i].ID < files[j].ID
		}
		return files[i].UpdatedAt.Before(files[j].UpdatedAt)
	})
	if len(files) > limit {
		files = files[:limit]
	}
	return files, nil
}

var _ CloudFileStore = (*MemoryStore)(nil)

func (s *MemoryStore) ListCloudFileParserCandidates(ctx context.Context, limit int) ([]CloudFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 100 {
		return nil, ErrCloudFileInvalid
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := []CloudFile{}
	for _, file := range s.cloudFiles {
		if cloudFileNeedsParser(file) {
			candidate := file
			candidate.Text = ""
			candidate.Segments = nil
			if file.ParseTask != nil {
				task := file.ParseTask
				candidate.ParseTask = &CloudFileParseTask{ID: task.ID, State: task.State, VMStopped: task.VMStopped, LeaseOwner: task.LeaseOwner, LeaseUntil: task.LeaseUntil}
			}
			result = append(result, candidate)
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].UpdatedAt.Equal(result[j].UpdatedAt) {
			return result[i].ID < result[j].ID
		}
		return result[i].UpdatedAt.Before(result[j].UpdatedAt)
	})
	if len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}
