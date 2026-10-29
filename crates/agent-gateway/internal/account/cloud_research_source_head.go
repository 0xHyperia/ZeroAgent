package account

import "context"

// Availability is a cheap owner/tombstone lookup for each model round. It never
// loads source bodies, and does not authorize a stale Run to publish or execute.
func (s *MemoryStore) CloudResearchSourceAvailable(ctx context.Context, userID int64, id string) (bool, error) {
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	id, err := canonicalCloudFileID(id)
	if err != nil {
		return false, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.cloudResearchSources == nil {
		return false, nil
	}
	source, exists := s.cloudResearchSources.sources[id]
	return exists && source.UserID == userID && source.DeletedAt == nil, nil
}
func (s *PersistentStore) CloudResearchSourceAvailable(ctx context.Context, userID int64, id string) (bool, error) {
	id, err := canonicalCloudFileID(id)
	if err != nil {
		return false, err
	}
	var available bool
	err = s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_research_sources WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL)`, id, userID).Scan(&available)
	return available, err
}
