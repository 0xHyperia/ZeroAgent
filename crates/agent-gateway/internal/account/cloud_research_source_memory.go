package account

import (
	"context"
	"sort"
)

type cloudResearchSourceMemoryState struct {
	sources      map[string]CloudResearchSource
	publications map[string]cloudResearchPublication
	searches     map[string]cloudResearchSearchReservation
}

func (s *MemoryStore) cloudResearchSourceStateLocked() *cloudResearchSourceMemoryState {
	if s.cloudResearchSources == nil {
		s.cloudResearchSources = &cloudResearchSourceMemoryState{sources: map[string]CloudResearchSource{}, publications: map[string]cloudResearchPublication{}, searches: map[string]cloudResearchSearchReservation{}}
	}
	return s.cloudResearchSources
}
func (s *MemoryStore) researchOperationLocked(userID int64, runID, owner string, attempt int64, operationID string) (*CloudRun, *CloudToolOperation, error) {
	run, err := s.cloudToolRunLocked(userID, runID, owner, attempt, false)
	if err != nil {
		return nil, nil, err
	}
	op, err := s.cloudToolLocked(userID, operationID)
	if err != nil {
		return nil, nil, err
	}
	if op.RunID != run.ID || op.ExecutionAttempt != attempt || op.State != CloudToolExecuting || (op.Name != "web_search" && op.Name != "fetch_page") {
		return nil, nil, ErrCloudToolConflict
	}
	return run, op, nil
}
func (s *MemoryStore) publishedResearchLocked(userID int64, operationID string) ([]CloudResearchSource, error) {
	state := s.cloudResearchSourceStateLocked()
	publication, exists := state.publications[operationID]
	if !exists || publication.UserID != userID {
		return nil, ErrNotFound
	}
	result := make([]CloudResearchSource, 0, len(publication.IDs))
	for _, id := range publication.IDs {
		source, exists := state.sources[id]
		if !exists || source.UserID != userID || source.DeletedAt != nil {
			return nil, ErrNotFound
		}
		result = append(result, cloneCloudResearchSource(source))
	}
	return result, nil
}
func (s *MemoryStore) PersistCloudResearchSources(ctx context.Context, userID int64, runID, owner string, attempt int64, operationID string, inputs []CloudResearchSourceInput) ([]CloudResearchSource, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	prepared, hash, err := prepareCloudResearchInputs(inputs, s.now())
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run, op, err := s.researchOperationLocked(userID, runID, owner, attempt, operationID)
	if err != nil {
		return nil, err
	}
	for _, input := range prepared {
		if op.Name == "web_search" && input.Kind != CloudResearchSearchSnippet || op.Name == "fetch_page" && input.Kind != CloudResearchPage {
			return nil, ErrCloudResearchSourceInvalid
		}
	}
	state := s.cloudResearchSourceStateLocked()
	if old, exists := state.publications[op.ID]; exists {
		if old.UserID != userID || old.RunID != run.ID || old.Hash != hash {
			return nil, ErrCloudResearchSourceConflict
		}
		return s.publishedResearchLocked(userID, op.ID)
	}
	if op.Name == "web_search" {
		reservation, exists := state.searches[op.ID]
		if !exists || reservation.UserID != userID || reservation.RunID != run.ID {
			return nil, ErrCloudResearchSourceQuota
		}
	}
	count, used := 0, 0
	for _, source := range state.sources {
		if source.UserID == userID && source.DeletedAt == nil {
			count++
			used += source.TextBytes + len(source.Snippet)
		}
	}
	for _, input := range prepared {
		used += len(input.Text) + len(input.Snippet)
	}
	if count+len(prepared) > CloudResearchSourceMaxCount || used > CloudResearchSourceMaxAccountBytes {
		return nil, ErrCloudResearchSourceQuota
	}
	publication := cloudResearchPublication{UserID: userID, RunID: run.ID, Hash: hash, IDs: make([]string, 0, len(prepared))}
	result := make([]CloudResearchSource, 0, len(prepared))
	for i, input := range prepared {
		source := newCloudResearchSource(input, run, op.ID, i, s.now())
		state.sources[source.ID] = source
		publication.IDs = append(publication.IDs, source.ID)
		result = append(result, cloneCloudResearchSource(source))
	}
	state.publications[op.ID] = publication
	return result, nil
}
func (s *MemoryStore) GetCloudResearchSourcesForOperation(ctx context.Context, userID int64, operationID string) ([]CloudResearchSource, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	id, err := canonicalCloudFileID(operationID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.publishedResearchLocked(userID, id)
}
func (s *MemoryStore) GetCloudResearchSource(ctx context.Context, userID int64, id string) (*CloudResearchSource, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	id, err := canonicalCloudFileID(id)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.cloudResearchSources == nil {
		return nil, ErrNotFound
	}
	source, exists := s.cloudResearchSources.sources[id]
	if !exists || source.UserID != userID || source.DeletedAt != nil {
		return nil, ErrNotFound
	}
	copy := cloneCloudResearchSource(source)
	return &copy, nil
}
func (s *MemoryStore) ListCloudResearchSources(ctx context.Context, userID int64, conversationID, beforeID string, limit int) ([]CloudResearchSource, error) {
	if ctx.Err() != nil {
		return nil, ctx.Err()
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
	result := make([]CloudResearchSource, 0)
	if s.cloudResearchSources == nil {
		if beforeID != "" {
			return nil, ErrNotFound
		}
		return result, nil
	}
	var before CloudResearchSource
	if beforeID != "" {
		var exists bool
		before, exists = s.cloudResearchSources.sources[beforeID]
		if !exists || before.UserID != userID || conversationID != "" && before.ConversationID != conversationID {
			return nil, ErrNotFound
		}
	}
	for _, source := range s.cloudResearchSources.sources {
		if source.UserID != userID || source.DeletedAt != nil || conversationID != "" && source.ConversationID != conversationID {
			continue
		}
		if beforeID != "" && (!source.CreatedAt.Before(before.CreatedAt) && (!source.CreatedAt.Equal(before.CreatedAt) || source.ID >= before.ID)) {
			continue
		}
		copy := cloneCloudResearchSource(source)
		copy.Text = ""
		result = append(result, copy)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt.Equal(result[j].CreatedAt) {
			return result[i].ID > result[j].ID
		}
		return result[i].CreatedAt.After(result[j].CreatedAt)
	})
	if len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}
func (s *MemoryStore) DeleteCloudResearchSource(ctx context.Context, userID int64, id string, version int64) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	id, err := canonicalCloudFileID(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.cloudResearchSourceStateLocked()
	source, exists := state.sources[id]
	if !exists || source.UserID != userID {
		return ErrNotFound
	}
	if source.DeletedAt != nil {
		return nil
	}
	if version < 1 || source.Version != version {
		return ErrCloudResearchSourceConflict
	}
	now := s.now().UTC()
	source.DeletedAt = &now
	source.Text, source.Snippet = "", ""
	source.TextBytes, source.LineCount = 0, 0
	source.Version++
	state.sources[id] = source
	return nil
}
func (s *MemoryStore) ReserveCloudResearchSearch(ctx context.Context, userID int64, runID, owner string, attempt int64, operationID string, limit int64) (bool, error) {
	if ctx.Err() != nil {
		return false, ctx.Err()
	}
	if limit < 1 || limit > CloudResearchMaxDailySearches {
		return false, ErrCloudResearchSourceInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	run, op, err := s.researchOperationLocked(userID, runID, owner, attempt, operationID)
	if err != nil {
		return false, err
	}
	if op.Name != "web_search" {
		return false, ErrCloudResearchSourceInvalid
	}
	state := s.cloudResearchSourceStateLocked()
	if old, exists := state.searches[op.ID]; exists {
		if old.UserID != userID || old.RunID != run.ID {
			return false, ErrCloudResearchSourceConflict
		}
		return false, nil
	}
	day := s.now().UTC().Format("2006-01-02")
	var count int64
	for _, reservation := range state.searches {
		if reservation.UserID == userID && reservation.Day == day {
			count++
		}
	}
	if count >= limit {
		return false, ErrCloudResearchSourceQuota
	}
	state.searches[op.ID] = cloudResearchSearchReservation{UserID: userID, RunID: run.ID, Day: day}
	return true, nil
}

var _ CloudResearchSourceStore = (*MemoryStore)(nil)
