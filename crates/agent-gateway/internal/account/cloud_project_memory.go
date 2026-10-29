package account

import (
	"context"
	"sort"
	"time"

	"github.com/google/uuid"
)

type cloudProjectMemoryState struct {
	projects      map[string]CloudProject
	conversations map[string]CloudProjectConversation
	files         map[string]map[string]bool
}

func (s *MemoryStore) cloudProjectStateLocked() *cloudProjectMemoryState {
	if s.cloudProjects == nil {
		s.cloudProjects = &cloudProjectMemoryState{projects: map[string]CloudProject{}, conversations: map[string]CloudProjectConversation{}, files: map[string]map[string]bool{}}
	}
	return s.cloudProjects
}

func (s *MemoryStore) cloudProjectLocked(userID int64, id string) (*CloudProject, error) {
	canonical, err := cloudProjectID(id)
	if err != nil {
		return nil, err
	}
	project, ok := s.cloudProjectStateLocked().projects[canonical]
	if !ok || project.UserID != userID {
		return nil, ErrNotFound
	}
	return &project, nil
}

func (s *MemoryStore) CreateCloudProject(ctx context.Context, input *CloudProject) (*CloudProject, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if input == nil || input.UserID <= 0 || !validCloudProject(CloudProjectUpdate{input.Name, input.Description, input.Instructions}) {
		return nil, ErrCloudProjectInvalid
	}
	project := *input
	var err error
	if project.ID == "" {
		project.ID = uuid.NewString()
	} else if project.ID, err = cloudProjectID(project.ID); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.cloudProjectStateLocked()
	if _, ok := state.projects[project.ID]; ok {
		return nil, ErrCloudProjectConflict
	}
	count := 0
	for _, other := range state.projects {
		if other.UserID == project.UserID {
			count++
		}
	}
	if count >= CloudProjectMaxAccountProjects {
		return nil, ErrCloudProjectQuota
	}
	project.Version = 1
	project.CreatedAt = s.now().UTC()
	project.UpdatedAt = project.CreatedAt
	state.projects[project.ID] = project
	return &project, nil
}

func (s *MemoryStore) GetCloudProject(ctx context.Context, userID int64, id string) (*CloudProject, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cloudProjectLocked(userID, id)
}

func cloudProjectEarlier(at time.Time, id string, beforeAt time.Time, beforeID string) bool {
	return at.Before(beforeAt) || at.Equal(beforeAt) && id < beforeID
}

func (s *MemoryStore) ListCloudProjects(ctx context.Context, userID int64, before string, limit int) ([]CloudProject, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	before, err := cloudProjectListInput(userID, before, limit)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.cloudProjectStateLocked()
	var anchor *CloudProject
	if before != "" {
		anchor, err = s.cloudProjectLocked(userID, before)
		if err != nil {
			return nil, err
		}
	}
	items := []CloudProject{}
	for _, project := range state.projects {
		if project.UserID == userID && (anchor == nil || cloudProjectEarlier(project.CreatedAt, project.ID, anchor.CreatedAt, anchor.ID)) {
			items = append(items, project)
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

func (s *MemoryStore) UpdateCloudProject(ctx context.Context, userID int64, id string, version int64, update CloudProjectUpdate) (*CloudProject, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !validCloudProject(update) {
		return nil, ErrCloudProjectInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	project, err := s.cloudProjectLocked(userID, id)
	if err != nil {
		return nil, err
	}
	if version < 1 || project.Version != version {
		return nil, ErrCloudProjectConflict
	}
	project.Name, project.Description, project.Instructions = update.Name, update.Description, update.Instructions
	project.Version++
	project.UpdatedAt = s.now().UTC()
	s.cloudProjects.projects[project.ID] = *project
	return project, nil
}

func (s *MemoryStore) DeleteCloudProject(ctx context.Context, userID int64, id string, version int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	project, err := s.cloudProjectLocked(userID, id)
	if err != nil {
		return err
	}
	if version < 1 || project.Version != version {
		return ErrCloudProjectConflict
	}
	for id, binding := range s.cloudProjects.conversations {
		if binding.ProjectID == project.ID {
			binding.ProjectID = ""
			binding.Version++
			s.cloudProjects.conversations[id] = binding
		}
	}
	delete(s.cloudProjects.projects, project.ID)
	delete(s.cloudProjects.files, project.ID)
	return nil
}

func (s *MemoryStore) cloudConversationProjectLocked(userID int64, id string) (*CloudProjectConversation, error) {
	id, err := cloudProjectID(id)
	if err != nil {
		return nil, err
	}
	conversation, ok := s.cloudConversations[id]
	if !ok || conversation.UserID != userID {
		return nil, ErrNotFound
	}
	binding, ok := s.cloudProjectStateLocked().conversations[id]
	if !ok {
		binding = CloudProjectConversation{ConversationID: id, CreatedAt: conversation.CreatedAt}
	}
	binding.Conversation = &conversation
	return &binding, nil
}

func (s *MemoryStore) deleteCloudProjectConversationLocked(id string) {
	if s.cloudProjects != nil {
		delete(s.cloudProjects.conversations, id)
	}
}

func (s *MemoryStore) GetCloudConversationProject(ctx context.Context, userID int64, id string) (*CloudProjectConversation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cloudConversationProjectLocked(userID, id)
}

func (s *MemoryStore) SetCloudConversationProject(ctx context.Context, userID int64, conversationID, projectID string, version int64) (*CloudProjectConversation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, err := s.cloudConversationProjectLocked(userID, conversationID)
	if err != nil {
		return nil, err
	}
	if projectID != "" {
		project, err := s.cloudProjectLocked(userID, projectID)
		if err != nil {
			return nil, err
		}
		projectID = project.ID
	}
	if version < 0 || binding.Version != version {
		return nil, ErrCloudProjectConflict
	}
	if binding.Version == 0 {
		binding.CreatedAt = s.now().UTC()
	}
	binding.Version++
	binding.ProjectID = projectID
	stored := *binding
	stored.Conversation = nil
	s.cloudProjects.conversations[binding.ConversationID] = stored
	return binding, nil
}

func (s *MemoryStore) ListCloudProjectConversations(ctx context.Context, userID int64, projectID, before string, limit int) ([]CloudProjectConversation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	before, err := cloudProjectListInput(userID, before, limit)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	project, err := s.cloudProjectLocked(userID, projectID)
	if err != nil {
		return nil, err
	}
	var anchor *CloudProjectConversation
	if before != "" {
		anchor, err = s.cloudConversationProjectLocked(userID, before)
		if err != nil || anchor.ProjectID != project.ID {
			return nil, ErrNotFound
		}
	}
	items := []CloudProjectConversation{}
	for id, binding := range s.cloudProjects.conversations {
		if binding.ProjectID != project.ID || (anchor != nil && !cloudProjectEarlier(binding.CreatedAt, id, anchor.CreatedAt, anchor.ConversationID)) {
			continue
		}
		current, err := s.cloudConversationProjectLocked(userID, id)
		if err == nil {
			items = append(items, *current)
		}
	}
	sort.Slice(items, func(i, j int) bool {
		return cloudProjectEarlier(items[j].CreatedAt, items[j].ConversationID, items[i].CreatedAt, items[i].ConversationID)
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items, nil
}

func (s *MemoryStore) SetCloudProjectFile(ctx context.Context, userID int64, projectID, fileID string, version int64, attached bool) (*CloudProject, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	fileID, err := cloudProjectID(fileID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	project, err := s.cloudProjectLocked(userID, projectID)
	if err != nil {
		return nil, err
	}
	if version < 1 || project.Version != version {
		return nil, ErrCloudProjectConflict
	}
	file, ok := s.cloudFiles[fileID]
	if !ok || file.UserID != userID {
		return nil, ErrNotFound
	}
	if attached && (file.State != CloudFileReady || file.DeletedAt != nil) {
		return nil, ErrCloudProjectInvalid
	}
	refs := s.cloudProjects.files[project.ID]
	if refs == nil {
		refs = map[string]bool{}
	}
	if attached && !refs[fileID] {
		count := 0
		for otherID := range refs {
			other, exists := s.cloudFiles[otherID]
			if exists && other.DeletedAt == nil && other.State != CloudFileDeleted {
				count++
			}
		}
		if count >= CloudProjectMaxFiles {
			return nil, ErrCloudProjectQuota
		}
	}
	if attached {
		refs[fileID] = true
	} else {
		delete(refs, fileID)
	}
	s.cloudProjects.files[project.ID] = refs
	project.Version++
	project.UpdatedAt = s.now().UTC()
	s.cloudProjects.projects[project.ID] = *project
	return project, nil
}

func (s *MemoryStore) ListCloudProjectFiles(ctx context.Context, userID int64, projectID, before string, limit int) ([]CloudFile, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	before, err := cloudProjectListInput(userID, before, limit)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	project, err := s.cloudProjectLocked(userID, projectID)
	if err != nil {
		return nil, err
	}
	refs := s.cloudProjects.files[project.ID]
	var anchor *CloudFile
	if before != "" {
		file, ok := s.cloudFiles[before]
		if !ok || file.UserID != userID || !refs[before] {
			return nil, ErrNotFound
		}
		anchor = &file
	}
	items := []CloudFile{}
	for id := range refs {
		file, ok := s.cloudFiles[id]
		if ok && file.UserID == userID && file.DeletedAt == nil && file.State != CloudFileDeleted && (anchor == nil || cloudProjectEarlier(file.CreatedAt, id, anchor.CreatedAt, anchor.ID)) {
			items = append(items, cloneCloudFile(file))
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
