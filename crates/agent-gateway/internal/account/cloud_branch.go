package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Edits and regenerations branch from an immutable prefix. The original
// conversation remains available, including any later messages or outputs.
type CloudBranchInput struct {
	ClientRequestID string          `json:"client_request_id"`
	MessageID       string          `json:"message_id"`
	Action          string          `json:"action"`
	Content         json.RawMessage `json:"content,omitempty"`
}

type CloudBranch struct {
	Conversation         *CloudConversation `json:"conversation"`
	SourceConversationID string             `json:"source_conversation_id"`
	SourceMessageID      string             `json:"source_message_id"`
	Action               string             `json:"action"`
	DraftContent         json.RawMessage    `json:"draft_content,omitempty"`
}

type cloudBranchReceipt struct {
	Hash   string
	Result CloudBranch
}

type CloudBranchStore interface {
	CreateCloudBranch(context.Context, int64, string, CloudBranchInput) (*CloudBranch, bool, error)
	GetCloudBranch(context.Context, int64, string) (*CloudBranch, error)
}

func validateCloudBranch(userID int64, sourceID string, input CloudBranchInput) (string, CloudBranchInput, string, error) {
	if userID <= 0 || strings.TrimSpace(input.ClientRequestID) == "" || len(input.ClientRequestID) > 128 {
		return "", input, "", ErrCloudRunInvalid
	}
	source, err := uuid.Parse(sourceID)
	if err != nil {
		return "", input, "", ErrCloudRunInvalid
	}
	anchor, err := uuid.Parse(input.MessageID)
	if err != nil {
		return "", input, "", ErrCloudRunInvalid
	}
	input.MessageID = anchor.String()
	switch input.Action {
	case "edit":
		input.Content, err = validateCloudContent(input.Content)
		if err != nil {
			return "", input, "", err
		}
	case "regenerate", "fork":
		if len(input.Content) != 0 && string(input.Content) != "null" {
			return "", input, "", ErrCloudRunInvalid
		}
		input.Content = nil
	default:
		return "", input, "", ErrCloudRunInvalid
	}
	digest := sha256.Sum256(cloudJSON(struct {
		Source string
		Input  CloudBranchInput
	}{source.String(), input}))
	return source.String(), input, hex.EncodeToString(digest[:]), nil
}

func buildCloudBranch(source CloudConversation, messages []CloudMessage, input CloudBranchInput, now time.Time) (*CloudBranch, []CloudMessage, error) {
	anchor := -1
	for i, m := range messages {
		if i >= 10000 {
			return nil, nil, ErrCloudRunLimit
		}
		if m.ID == input.MessageID {
			anchor = i
			break
		}
	}
	if anchor < 0 {
		return nil, nil, ErrNotFound
	}
	cut := anchor + 1
	var draft json.RawMessage
	switch input.Action {
	case "edit":
		if messages[anchor].Role != "user" {
			return nil, nil, ErrCloudRunInvalid
		}
		cut = anchor
		draft = append(json.RawMessage(nil), input.Content...)
	case "regenerate":
		if messages[anchor].Role != "assistant" && messages[anchor].Role != "user" {
			return nil, nil, ErrCloudRunInvalid
		}
		user := anchor
		for user >= 0 && messages[user].Role != "user" {
			user--
		}
		if user < 0 {
			return nil, nil, ErrCloudRunInvalid
		}
		cut = user
		draft = append(json.RawMessage(nil), messages[user].Content...)
	}
	baseTitle := strings.TrimSpace(source.Title)
	for strings.HasSuffix(baseTitle, " · 分支") {
		baseTitle = strings.TrimSuffix(baseTitle, " · 分支")
	}
	if input.Action == "edit" {
		if editedTitle := cloudConversationTitle(draft); editedTitle != "新对话" {
			baseTitle = editedTitle
		}
	}
	title := []rune(baseTitle)
	if len(title) > 80 {
		title = title[:80]
	}
	conversation := &CloudConversation{ID: uuid.NewString(), UserID: source.UserID, Title: string(title) + " · 分支", Model: source.Model, CreatedAt: now, UpdatedAt: now}
	clones := make([]CloudMessage, 0, cut)
	total := len(draft)
	for i, m := range messages[:cut] {
		total += len(m.Content) + len(m.Usage) + len(m.Presentation)
		if total > CloudRunMaxInputBytes || i >= 10000 {
			return nil, nil, ErrCloudRunLimit
		}
		if m.Role != "user" && m.Role != "assistant" {
			return nil, nil, ErrCloudRunInvalid
		}
		m.ID = uuid.NewString()
		m.ConversationID = conversation.ID
		m.UserID = source.UserID
		// PostgreSQL stores microseconds and rounds half-microsecond inputs to
		// even instants. Align first so adjacent clones cannot collapse and
		// acquire a random UUID order after a database round trip.
		m.CreatedAt = now.Truncate(time.Microsecond).Add(-time.Duration(cut-i) * time.Microsecond)
		m.Content = append(json.RawMessage(nil), m.Content...)
		m.Usage = append(json.RawMessage(nil), m.Usage...)
		m.Presentation = append(json.RawMessage(nil), m.Presentation...)
		clones = append(clones, m)
	}
	return &CloudBranch{Conversation: conversation, SourceConversationID: source.ID, SourceMessageID: input.MessageID, Action: input.Action, DraftContent: draft}, clones, nil
}

func cloneCloudBranch(input CloudBranch) *CloudBranch {
	result := input
	if input.Conversation != nil {
		conversation := *input.Conversation
		result.Conversation = &conversation
	}
	result.DraftContent = append(json.RawMessage(nil), input.DraftContent...)
	return &result
}

func (s *MemoryStore) CreateCloudBranch(ctx context.Context, userID int64, sourceID string, input CloudBranchInput) (*CloudBranch, bool, error) {
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	sourceID, input, hash, err := validateCloudBranch(userID, sourceID, input)
	if err != nil {
		return nil, false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := strings.Join([]string{string(cloudJSON(userID)), input.ClientRequestID}, ":")
	if previous, ok := s.cloudBranches[key]; ok {
		if previous.Hash != hash {
			return nil, false, ErrCloudRunConflict
		}
		if _, ok := s.cloudConversations[previous.Result.Conversation.ID]; !ok {
			return nil, false, ErrNotFound
		}
		return cloneCloudBranch(previous.Result), false, nil
	}
	source, ok := s.cloudConversations[sourceID]
	if !ok || source.UserID != userID {
		return nil, false, ErrNotFound
	}
	if s.cloudRuns != nil {
		for _, run := range s.cloudRuns.runs {
			if run.ConversationID == sourceID && !run.Terminal() {
				return nil, false, ErrCloudRunBusy
			}
		}
	}
	branch, messages, err := buildCloudBranch(source, s.cloudMessages[sourceID], input, s.now().UTC())
	if err != nil {
		return nil, false, err
	}
	if s.cloudBranches == nil {
		s.cloudBranches = make(map[string]cloudBranchReceipt)
	}
	s.cloudConversations[branch.Conversation.ID] = *branch.Conversation
	s.cloudMessages[branch.Conversation.ID] = messages
	if s.cloudProjects != nil {
		if binding, ok := s.cloudProjects.conversations[sourceID]; ok && binding.ProjectID != "" {
			if project, exists := s.cloudProjects.projects[binding.ProjectID]; exists && project.UserID == userID {
				binding.ConversationID = branch.Conversation.ID
				binding.Version = 1
				binding.CreatedAt = branch.Conversation.CreatedAt
				binding.Conversation = nil
				s.cloudProjects.conversations[branch.Conversation.ID] = binding
			}
		}
	}
	s.cloudBranches[key] = cloudBranchReceipt{Hash: hash, Result: *cloneCloudBranch(*branch)}
	return cloneCloudBranch(*branch), true, nil
}

func (s *MemoryStore) GetCloudBranch(ctx context.Context, userID int64, requestID string) (*CloudBranch, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	key := strings.Join([]string{string(cloudJSON(userID)), requestID}, ":")
	receipt, ok := s.cloudBranches[key]
	if !ok || receipt.Result.Conversation == nil {
		return nil, ErrNotFound
	}
	conversation, exists := s.cloudConversations[receipt.Result.Conversation.ID]
	if !exists || conversation.UserID != userID {
		return nil, ErrNotFound
	}
	return cloneCloudBranch(receipt.Result), nil
}
