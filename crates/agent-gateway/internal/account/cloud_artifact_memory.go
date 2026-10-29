package account

import (
	"context"
	"sort"
	"time"
)

type cloudArtifactMemoryState struct {
	families   map[string]CloudArtifactFamily
	versions   map[string]CloudArtifactVersion
	operations map[string]string
}

func (s *MemoryStore) artifactState() *cloudArtifactMemoryState {
	if s.cloudArtifacts == nil {
		s.cloudArtifacts = &cloudArtifactMemoryState{families: map[string]CloudArtifactFamily{}, versions: map[string]CloudArtifactVersion{}, operations: map[string]string{}}
	}
	return s.cloudArtifacts
}
func (s *MemoryStore) ReserveCloudArtifact(ctx context.Context, userID int64, owner string, attempt int64, input *CloudArtifactVersion) (*CloudArtifactVersion, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	version, err := prepareCloudArtifact(input, userID, s.now())
	if err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.artifactState()
	if id, exists := state.operations[version.ToolOperationID]; exists {
		prior := state.versions[id]
		if prior.UserID != userID || prior.RequestHash != version.RequestHash {
			return nil, false, ErrCloudArtifactConflict
		}
		copy := cloneCloudArtifact(prior)
		return &copy, false, nil
	}
	if s.cloudRuns == nil {
		return nil, false, ErrNotFound
	}
	run, ok := s.cloudRuns.runs[version.SourceRunID]
	if !ok || run.UserID != userID || run.ConversationID != version.ConversationID {
		return nil, false, ErrNotFound
	}
	if run.State != CloudRunRunning {
		return nil, false, ErrCloudRunLeaseLost
	}
	if err = validateCloudRunLease(&run, owner, attempt, s.now()); err != nil {
		return nil, false, err
	}
	family, exists := state.families[version.FamilyID]
	if exists && (family.UserID != userID || family.DeletedAt != nil) {
		return nil, false, ErrCloudArtifactConflict
	}
	count := 0
	var used int64
	number := int64(1)
	for _, other := range state.versions {
		if other.UserID == userID && other.State != CloudArtifactDeleted {
			count++
			used += other.Size
		}
		if other.FamilyID == version.FamilyID && other.Number >= number {
			number = other.Number + 1
		}
	}
	if count >= CloudArtifactMaxAccountVersions || used+version.Size > CloudArtifactMaxAccountBytes || number > CloudArtifactMaxFamilyVersions {
		return nil, false, ErrCloudArtifactQuota
	}
	if !exists {
		state.families[version.FamilyID] = CloudArtifactFamily{ID: version.FamilyID, UserID: userID, ConversationID: version.ConversationID, CreatedAt: s.now()}
	}
	version.Number = number
	state.versions[version.ID] = cloneCloudArtifact(*version)
	state.operations[version.ToolOperationID] = version.ID
	return version, true, nil
}
func (s *MemoryStore) GetCloudArtifactVersion(ctx context.Context, userID int64, id string) (*CloudArtifactVersion, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.cloudArtifacts == nil {
		return nil, ErrNotFound
	}
	version, ok := s.cloudArtifacts.versions[id]
	if !ok || version.UserID != userID {
		return nil, ErrNotFound
	}
	copy := cloneCloudArtifact(version)
	return &copy, nil
}
func (s *MemoryStore) GetCloudArtifactByOperation(ctx context.Context, userID int64, id string) (*CloudArtifactVersion, error) {
	s.mu.RLock()
	var versionID string
	if s.cloudArtifacts != nil {
		versionID = s.cloudArtifacts.operations[id]
	}
	s.mu.RUnlock()
	return s.GetCloudArtifactVersion(ctx, userID, versionID)
}
func (s *MemoryStore) ListCloudArtifacts(ctx context.Context, userID int64, conversationID, familyID, before string, limit int) (*CloudArtifactPage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	conversationID, familyID, before, err := cloudArtifactListScope(userID, conversationID, familyID, before, limit)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := []CloudArtifactVersion{}
	if s.cloudArtifacts == nil {
		if before != "" {
			return nil, ErrNotFound
		}
		return cloudArtifactPage(result, limit), nil
	}
	var anchor CloudArtifactVersion
	if before != "" {
		var exists bool
		anchor, exists = s.cloudArtifacts.versions[before]
		// Tombstones retain their immutable ordering key so deleting a prior
		// page's last result does not strand the remaining account library.
		if !exists || anchor.UserID != userID || (conversationID != "" && anchor.ConversationID != conversationID) || (familyID != "" && anchor.FamilyID != familyID) {
			return nil, ErrNotFound
		}
	}
	for _, version := range s.cloudArtifacts.versions {
		if version.UserID == userID && version.DeletedAt == nil && (conversationID == "" || version.ConversationID == conversationID) && (familyID == "" || version.FamilyID == familyID) {
			if before != "" && (version.CreatedAt.After(anchor.CreatedAt) || (version.CreatedAt.Equal(anchor.CreatedAt) && version.ID >= anchor.ID)) {
				continue
			}
			metadata := version
			metadata.Journal = nil
			result = append(result, cloneCloudArtifact(metadata))
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt.Equal(result[j].CreatedAt) {
			return result[i].ID > result[j].ID
		}
		return result[i].CreatedAt.After(result[j].CreatedAt)
	})
	return cloudArtifactPage(result, limit), nil
}
func (s *MemoryStore) UpdateCloudArtifact(ctx context.Context, userID int64, id string, expected int64, owner string, attempt int64, update CloudArtifactUpdate) (*CloudArtifactVersion, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.artifactState()
	version, ok := state.versions[id]
	if !ok || version.UserID != userID {
		return nil, ErrNotFound
	}
	if update.State == CloudArtifactReady {
		run, ok := s.cloudRuns.runs[version.SourceRunID]
		if !ok {
			return nil, ErrNotFound
		}
		if run.State != CloudRunRunning {
			return nil, ErrCloudRunLeaseLost
		}
		if err := validateCloudRunLease(&run, owner, attempt, s.now()); err != nil {
			return nil, err
		}
		if state.families[version.FamilyID].DeletedAt != nil {
			return nil, ErrCloudArtifactConflict
		}
	}
	result, err := updateCloudArtifact(version, expected, update, s.now())
	if err != nil {
		return nil, err
	}
	state.versions[id] = cloneCloudArtifact(*result)
	return result, nil
}
func (s *MemoryStore) DeleteCloudArtifactFamily(ctx context.Context, userID int64, id string) ([]CloudArtifactVersion, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.artifactState()
	family, ok := state.families[id]
	if !ok || family.UserID != userID {
		return nil, ErrNotFound
	}
	now := s.now()
	family.DeletedAt = &now
	state.families[id] = family
	result := []CloudArtifactVersion{}
	for key, version := range state.versions {
		if version.FamilyID == id && version.State != CloudArtifactDeleted {
			updated, err := updateCloudArtifact(version, version.Version, CloudArtifactUpdate{State: CloudArtifactDeleting}, now)
			if err != nil {
				return nil, err
			}
			state.versions[key] = cloneCloudArtifact(*updated)
			result = append(result, *updated)
		}
	}
	return result, nil
}
func (s *MemoryStore) ListCloudArtifactCleanup(ctx context.Context, limit int) ([]CloudArtifactVersion, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if limit < 1 || limit > 100 {
		return nil, ErrCloudArtifactInvalid
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := []CloudArtifactVersion{}
	if s.cloudArtifacts == nil {
		return result, nil
	}
	for _, v := range s.cloudArtifacts.versions {
		if v.State == CloudArtifactDeleting || (v.State != CloudArtifactReady && v.State != CloudArtifactDeleted && v.UpdatedAt.Before(s.now().Add(-15*time.Minute))) {
			result = append(result, cloneCloudArtifact(v))
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].UpdatedAt.Before(result[j].UpdatedAt) })
	if len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}
