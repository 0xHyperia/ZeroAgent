package account

import (
	"context"
	"time"
)

func cloudFileHasVerifiedOriginal(file *CloudFile) bool {
	return file != nil && file.UploadedAt != nil && file.DeletedAt == nil && file.Size >= 0 && file.Size <= CloudFileMaxBytes && file.State != CloudFileUploading && file.State != CloudFileDeleting && file.State != CloudFileDeleted
}

// Health is read-only: this check never creates or resumes a sandbox. Fail
// closed when the adapter is disabled, unconfigured or temporarily unavailable.
func (s *Service) cloudFileWorkspaceEnabled(ctx context.Context) bool {
	client := s.CloudExecutor()
	if client == nil {
		return false
	}
	if _, err := s.cloudFileProvider(); err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	health, err := client.Health(ctx)
	return err == nil && health.Enabled
}

func (s *Service) cloudFileCapabilities(ctx context.Context, files ...*CloudFile) {
	enabled := false
	for _, file := range files {
		if cloudFileHasVerifiedOriginal(file) {
			enabled = s.cloudFileWorkspaceEnabled(ctx)
			break
		}
	}
	for _, file := range files {
		if file != nil {
			file.WorkspaceLoadable = enabled && cloudFileHasVerifiedOriginal(file)
		}
	}
}
