package account

import (
	"context"
	"sort"

	"github.com/google/uuid"
)

func (s *MemoryStore) cloudMemoryLocked(userID int64, id string) (*CloudMemory, error) {
	id, err := cloudProjectID(id)
	if err != nil {
		return nil, err
	}
	memory, ok := s.cloudMemories[id]
	if !ok || memory.UserID != userID {
		return nil, ErrNotFound
	}
	return &memory, nil
}

func (s *MemoryStore) CreateCloudMemory(ctx context.Context, input *CloudMemory) (*CloudMemory, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if input == nil || input.UserID <= 0 || !cloudProjectText(input.Content, CloudMemoryMaxContent, true) {
		return nil, ErrCloudProjectInvalid
	}
	memory := *input
	var err error
	if memory.ID == "" {
		memory.ID = uuid.NewString()
	} else if memory.ID, err = cloudProjectID(memory.ID); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cloudMemories == nil {
		s.cloudMemories = map[string]CloudMemory{}
	}
	if _, ok := s.cloudMemories[memory.ID]; ok {
		return nil, ErrCloudProjectConflict
	}
	count := 0
	for _, other := range s.cloudMemories {
		if other.UserID == memory.UserID {
			count++
		}
	}
	if count >= CloudMemoryMaxEntries {
		return nil, ErrCloudProjectQuota
	}
	memory.Version = 1
	memory.CreatedAt = s.now().UTC()
	memory.UpdatedAt = memory.CreatedAt
	s.cloudMemories[memory.ID] = memory
	return &memory, nil
}

func (s *MemoryStore) GetCloudMemory(ctx context.Context, userID int64, id string) (*CloudMemory, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cloudMemoryLocked(userID, id)
}

func (s *MemoryStore) ListCloudMemories(ctx context.Context, userID int64, before string, limit int) ([]CloudMemory, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	before, err := cloudProjectListInput(userID, before, limit)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	var anchor *CloudMemory
	if before != "" {
		anchor, err = s.cloudMemoryLocked(userID, before)
		if err != nil {
			return nil, err
		}
	}
	items := []CloudMemory{}
	for _, memory := range s.cloudMemories {
		if memory.UserID == userID && (anchor == nil || cloudProjectEarlier(memory.CreatedAt, memory.ID, anchor.CreatedAt, anchor.ID)) {
			items = append(items, memory)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		return cloudProjectEarlier(items[j].CreatedAt, items[j].ID, items[i].CreatedAt, items[i].ID)
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *MemoryStore) UpdateCloudMemory(ctx context.Context, userID int64, id string, version int64, content string, enabled bool) (*CloudMemory, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !cloudProjectText(content, CloudMemoryMaxContent, true) {
		return nil, ErrCloudProjectInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	memory, err := s.cloudMemoryLocked(userID, id)
	if err != nil {
		return nil, err
	}
	if version < 1 || memory.Version != version {
		return nil, ErrCloudProjectConflict
	}
	memory.Content, memory.Enabled = content, enabled
	memory.Version++
	memory.UpdatedAt = s.now().UTC()
	s.cloudMemories[memory.ID] = *memory
	return memory, nil
}

func (s *MemoryStore) DeleteCloudMemory(ctx context.Context, userID int64, id string, version int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	memory, err := s.cloudMemoryLocked(userID, id)
	if err != nil {
		return err
	}
	if version < 1 || memory.Version != version {
		return ErrCloudProjectConflict
	}
	delete(s.cloudMemories, memory.ID)
	return nil
}

func (s *MemoryStore) GetCloudMemorySettings(ctx context.Context, userID int64) (*CloudMemorySettings, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if userID <= 0 {
		return nil, ErrCloudProjectInvalid
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	settings := s.cloudMemorySettings[userID]
	return &settings, nil
}

func (s *MemoryStore) SetCloudMemorySettings(ctx context.Context, userID, version int64, enabled bool) (*CloudMemorySettings, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if userID <= 0 {
		return nil, ErrCloudProjectInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	settings := s.cloudMemorySettings[userID]
	if version < 0 || settings.Version != version {
		return nil, ErrCloudProjectConflict
	}
	if s.cloudMemorySettings == nil {
		s.cloudMemorySettings = map[int64]CloudMemorySettings{}
	}
	settings.Enabled = enabled
	settings.Version++
	settings.UpdatedAt = s.now().UTC()
	s.cloudMemorySettings[userID] = settings
	return &settings, nil
}

func boundedCloudMemoryContext(enabled bool, items []CloudMemory, maxBytes int) *CloudMemoryContext {
	result := &CloudMemoryContext{Enabled: enabled, Items: []CloudMemory{}}
	if !enabled {
		return result
	}
	sort.Slice(items, func(i, j int) bool {
		return cloudProjectEarlier(items[j].CreatedAt, items[j].ID, items[i].CreatedAt, items[i].ID)
	})
	used := 0
	for _, memory := range items {
		if !memory.Enabled {
			continue
		}
		if used+len(memory.Content) > maxBytes {
			result.Truncated = true
			continue
		}
		result.Items = append(result.Items, memory)
		used += len(memory.Content)
	}
	return result
}

func (s *MemoryStore) GetCloudMemoryContext(ctx context.Context, userID int64, maxBytes int) (*CloudMemoryContext, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if userID <= 0 || maxBytes < 1 || maxBytes > CloudMemoryMaxContext {
		return nil, ErrCloudProjectInvalid
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	enabled := s.cloudMemorySettings[userID].Enabled
	items := []CloudMemory{}
	if enabled {
		for _, memory := range s.cloudMemories {
			if memory.UserID == userID && memory.Enabled {
				items = append(items, memory)
			}
		}
	}
	return boundedCloudMemoryContext(enabled, items, maxBytes), nil
}
