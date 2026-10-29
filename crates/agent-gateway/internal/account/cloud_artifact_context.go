package account

import (
	"context"
	"net/http"
)

func (s *Service) ownedReadyCloudArtifact(ctx context.Context, userID int64, id string) (*CloudArtifactVersion, error) {
	canonical, err := canonicalCloudFileID(id)
	if err != nil {
		return nil, ErrNotFound
	}
	store, err := s.artifactStore()
	if err != nil {
		return nil, err
	}
	version, err := store.GetCloudArtifactVersion(ctx, userID, canonical)
	if err != nil {
		return nil, err
	}
	if version.DeletedAt != nil {
		return nil, ErrNotFound
	}
	if version.State != CloudArtifactReady {
		return nil, &APIError{Status: http.StatusConflict, Reason: "artifact_not_ready", Message: "成果尚未完成验证，暂不能载入"}
	}
	return version, nil
}
