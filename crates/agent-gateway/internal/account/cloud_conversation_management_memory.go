package account

import (
	"context"
	"sort"
	"strings"
)

func (s *MemoryStore) ManageCloudConversation(ctx context.Context, uid int64, id string, patch CloudConversationManagementPatch) (*CloudConversation, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id, err := canonicalCloudRunID(id)
	if err != nil {
		return nil, ErrCloudRunInvalid
	}
	if err = validateCloudManagementPatch(patch); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.cloudConversations[id]
	if !ok || c.UserID != uid {
		return nil, ErrNotFound
	}
	if c.ManagementVersion != *patch.ExpectedVersion {
		return nil, ErrCloudRunConflict
	}
	if patch.Pinned != nil {
		c.Pinned = *patch.Pinned
	}
	if patch.Archived != nil {
		c.Archived = *patch.Archived
	}
	c.ManagementVersion++
	s.cloudConversations[id] = c
	return &c, nil
}

func (s *MemoryStore) cloudConversationMatchesScopeLocked(c CloudConversation, scope string) bool {
	if !cloudConversationInScope(c, scope) {
		return false
	}
	return scope != "unassigned" || s.cloudProjects == nil || s.cloudProjects.conversations[c.ID].ProjectID == ""
}

func (s *MemoryStore) CloudConversationCatalog(ctx context.Context, uid int64, scope, value string, limit int) (*CloudConversationCatalog, error) {
	cursor, err := parseCloudManagementCursor(uid, "catalog", scope, value, limit)
	if err != nil || !validateCloudScope(scope) {
		return nil, ErrCloudRunInvalid
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	page := &CloudConversationCatalog{Conversations: []CloudConversation{}}
	for _, c := range s.cloudConversations {
		if c.UserID == uid && s.cloudConversationMatchesScopeLocked(c, scope) && (value == "" || cloudProjectEarlier(c.UpdatedAt, c.ID, cursor.At, cursor.ID)) {
			page.Conversations = append(page.Conversations, c)
		}
	}
	sort.Slice(page.Conversations, func(i, j int) bool {
		a, b := page.Conversations[i], page.Conversations[j]
		return cloudProjectEarlier(b.UpdatedAt, b.ID, a.UpdatedAt, a.ID)
	})
	if len(page.Conversations) > limit {
		page.HasMore = true
		page.Conversations = page.Conversations[:limit]
		last := page.Conversations[limit-1]
		page.NextCursor = encodeCloudManagementCursor(uid, "catalog", scope, last.UpdatedAt, last.ID)
	}
	return page, nil
}

func (s *MemoryStore) SearchCloudConversations(ctx context.Context, uid int64, q, scope, value string, limit int) (*CloudConversationSearchPage, error) {
	q, err := validateCloudSearch(q)
	if err != nil {
		return nil, err
	}
	filter := scope + ":" + q
	cursor, err := parseCloudManagementCursor(uid, "search", filter, value, limit)
	if err != nil || !validateCloudScope(scope) {
		return nil, ErrCloudRunInvalid
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	page := &CloudConversationSearchPage{Items: []CloudConversationSearchItem{}}
	less := func(i, j int) bool {
		a, b := page.Items[i], page.Items[j]
		return cloudProjectEarlier(b.CreatedAt, cloudSearchKey(b), a.CreatedAt, cloudSearchKey(a))
	}
	add := func(item CloudConversationSearchItem) {
		if value != "" && !cloudProjectEarlier(item.CreatedAt, cloudSearchKey(item), cursor.At, cursor.ID) {
			return
		}
		page.Items = append(page.Items, item)
		sort.Slice(page.Items, less)
		if len(page.Items) > limit+1 {
			page.Items = page.Items[:limit+1]
		}
	}
	for _, c := range s.cloudConversations {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		if c.UserID != uid || !s.cloudConversationMatchesScopeLocked(c, scope) {
			continue
		}
		if strings.Contains(strings.ToLower(c.Title), strings.ToLower(q)) {
			add(CloudConversationSearchItem{Conversation: c, Match: "title", Excerpt: cloudSearchExcerpt(c.Title, q), CreatedAt: c.CreatedAt})
		}
		for _, m := range s.cloudMessages[c.ID] {
			if m.UserID != uid || (m.Role != "user" && m.Role != "assistant") {
				continue
			}
			text := cloudSearchText(m.Content)
			if strings.Contains(strings.ToLower(text), strings.ToLower(q)) {
				add(CloudConversationSearchItem{Conversation: c, MessageID: m.ID, Role: m.Role, Match: "message", Excerpt: cloudSearchExcerpt(text, q), CreatedAt: m.CreatedAt})
			}
		}
	}
	if len(page.Items) > limit {
		page.HasMore = true
		page.Items = page.Items[:limit]
		last := page.Items[limit-1]
		page.NextCursor = encodeCloudManagementCursor(uid, "search", filter, last.CreatedAt, cloudSearchKey(last))
	}
	return page, nil
}

func (s *MemoryStore) CloudConversationWindowHeads(ctx context.Context, uid int64, cid, mid string, before, after int) (*CloudConversationWindowHeads, error) {
	cid, mid, err := validateCloudWindow(cid, mid, before, after)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.cloudConversations[cid]
	if !ok || c.UserID != uid {
		return nil, ErrNotFound
	}
	messages := make([]CloudMessage, 0, len(s.cloudMessages[cid]))
	for _, m := range s.cloudMessages[cid] {
		if m.UserID == uid {
			messages = append(messages, m)
		}
	}
	sort.Slice(messages, func(i, j int) bool {
		return cloudProjectEarlier(messages[i].CreatedAt, messages[i].ID, messages[j].CreatedAt, messages[j].ID)
	})
	anchor := -1
	for i, m := range messages {
		if m.ID == mid {
			anchor = i
			break
		}
	}
	if anchor < 0 {
		return nil, ErrNotFound
	}
	start, end := max(0, anchor-before), min(len(messages), anchor+after+1)
	page := &CloudConversationWindowHeads{Items: []CloudMessageHead{}, HasBefore: start > 0, HasAfter: end < len(messages)}
	for _, m := range messages[start:end] {
		page.Items = append(page.Items, cloudMessageHead(m))
	}
	return page, nil
}

func (s *MemoryStore) CloudConversationBranches(ctx context.Context, uid int64, cid, value string, limit int) (*CloudConversationBranches, error) {
	cid, err := canonicalCloudRunID(cid)
	if err != nil {
		return nil, ErrCloudRunInvalid
	}
	cursor, err := parseCloudManagementCursor(uid, "branches", cid, value, limit)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	c, ok := s.cloudConversations[cid]
	if !ok || c.UserID != uid {
		return nil, ErrNotFound
	}
	page := &CloudConversationBranches{Children: []CloudConversationBranchChild{}}
	for _, receipt := range s.cloudBranches {
		b := receipt.Result
		if b.Conversation == nil || b.Conversation.UserID != uid {
			continue
		}
		if b.Conversation.ID == cid {
			source, exists := s.cloudConversations[b.SourceConversationID]
			page.Source = &CloudConversationBranchSource{ConversationID: b.SourceConversationID, MessageID: b.SourceMessageID, Action: b.Action, Available: exists && source.UserID == uid}
			if page.Source.Available {
				page.Source.Title = source.Title
			}
		}
		if b.SourceConversationID != cid {
			continue
		}
		destination, exists := s.cloudConversations[b.Conversation.ID]
		if exists && destination.UserID == uid && (value == "" || cloudProjectEarlier(destination.CreatedAt, destination.ID, cursor.At, cursor.ID)) {
			page.Children = append(page.Children, CloudConversationBranchChild{destination, b.SourceMessageID, b.Action})
		}
	}
	sort.Slice(page.Children, func(i, j int) bool {
		a, b := page.Children[i].Conversation, page.Children[j].Conversation
		return cloudProjectEarlier(b.CreatedAt, b.ID, a.CreatedAt, a.ID)
	})
	if len(page.Children) > limit {
		page.HasMore = true
		page.Children = page.Children[:limit]
		last := page.Children[limit-1].Conversation
		page.NextCursor = encodeCloudManagementCursor(uid, "branches", cid, last.CreatedAt, last.ID)
	}
	return page, nil
}
