package account

import "context"

// Public metadata and download ownership checks never need multi-MiB parsed
// bodies or execution journals. Keep this optional to retain store adapters.
func cloudFileMetadata(ctx context.Context, store CloudFileStore, userID int64, id string) (*CloudFile, error) {
	if metadata, ok := store.(interface {
		GetCloudFileMetadata(context.Context, int64, string) (*CloudFile, error)
	}); ok {
		return metadata.GetCloudFileMetadata(ctx, userID, id)
	}
	return store.GetCloudFile(ctx, userID, id)
}
func (s *MemoryStore) GetCloudFileMetadata(ctx context.Context, userID int64, id string) (*CloudFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	canonical, err := canonicalCloudFileID(id)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	file, ok := s.cloudFiles[canonical]
	if !ok || file.UserID != userID {
		return nil, ErrNotFound
	}
	file.Text = ""
	file.Segments = nil
	file.ParseTask = nil
	copy := cloneCloudFile(file)
	return &copy, nil
}
func (s *PersistentStore) GetCloudFileMetadata(ctx context.Context, userID int64, id string) (*CloudFile, error) {
	canonical, err := canonicalCloudFileID(id)
	if err != nil {
		return nil, err
	}
	return scanCloudFile(s.db.QueryRowContext(ctx, "SELECT "+cloudFileMetadataColumns+" FROM zeroagent_cloud_files f WHERE f.id=$1 AND f.user_id=$2", canonical, userID))
}
