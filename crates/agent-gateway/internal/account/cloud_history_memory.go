package account

import (
	"container/heap"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"unicode/utf8"
)

type cloudHistoryHeap []CloudMessage

func (h cloudHistoryHeap) Len() int { return len(h) }
func (h cloudHistoryHeap) Less(i, j int) bool {
	return cloudProjectEarlier(h[i].CreatedAt, h[i].ID, h[j].CreatedAt, h[j].ID)
}
func (h cloudHistoryHeap) Swap(i, j int) { h[i], h[j] = h[j], h[i] }
func (h *cloudHistoryHeap) Push(v any)   { *h = append(*h, v.(CloudMessage)) }
func (h *cloudHistoryHeap) Pop() any     { n := len(*h); v := (*h)[n-1]; *h = (*h)[:n-1]; return v }

func cloudMessageHead(message CloudMessage) CloudMessageHead {
	digest := sha256.Sum256(message.Content)
	return CloudMessageHead{ID: message.ID, ConversationID: message.ConversationID, Role: message.Role, CreatedAt: message.CreatedAt, ContentBytes: int64(len(message.Content)), ContentSHA256: hex.EncodeToString(digest[:]), UsageBytes: int64(len(message.Usage))}
}

func validateCloudHistoryPage(conversationID, beforeID string, limit int) (string, string, error) {
	conversation, err := canonicalCloudRunID(conversationID)
	if err != nil || limit < 1 || limit > CloudHistoryMaxPage {
		return "", "", ErrCloudRunInvalid
	}
	if beforeID != "" {
		beforeID, err = canonicalCloudRunID(beforeID)
		if err != nil {
			return "", "", ErrCloudRunInvalid
		}
	}
	return conversation, beforeID, nil
}

func (s *MemoryStore) ListCloudMessageHeads(ctx context.Context, uid int64, conversationID, beforeID string, limit int) (*CloudHistoryHeadsPage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	conversationID, beforeID, err := validateCloudHistoryPage(conversationID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	conversation, ok := s.cloudConversations[conversationID]
	if !ok || conversation.UserID != uid {
		return nil, ErrNotFound
	}
	var boundary *CloudMessage
	if beforeID != "" {
		for _, m := range s.cloudMessages[conversationID] {
			if m.ID == beforeID && m.UserID == uid {
				copy := m
				boundary = &copy
				break
			}
		}
		if boundary == nil {
			return nil, ErrNotFound
		}
	}
	selected := &cloudHistoryHeap{}
	heap.Init(selected)
	for _, m := range s.cloudMessages[conversationID] {
		if m.UserID != uid || (boundary != nil && !cloudProjectEarlier(m.CreatedAt, m.ID, boundary.CreatedAt, boundary.ID)) {
			continue
		}
		heap.Push(selected, m)
		if selected.Len() > limit+1 {
			heap.Pop(selected)
		}
	}
	sort.Sort(selected)
	page := &CloudHistoryHeadsPage{Items: []CloudMessageHead{}}
	if selected.Len() > limit {
		page.HasMore = true
		*selected = (*selected)[1:]
	}
	for _, m := range *selected {
		page.Items = append(page.Items, cloudMessageHead(m))
	}
	if page.HasMore && len(page.Items) > 0 {
		page.NextBeforeID = page.Items[0].ID
	}
	return page, nil
}

func cloudHistoryIDs(ids []string, maxBytes int64) ([]string, error) {
	if len(ids) < 1 || len(ids) > CloudHistoryMaxPage || maxBytes < 1 || maxBytes > CloudRunMaxInputBytes {
		return nil, ErrCloudRunInvalid
	}
	seen := map[string]bool{}
	result := make([]string, len(ids))
	for index, id := range ids {
		canonical, err := canonicalCloudRunID(id)
		if err != nil || seen[canonical] {
			return nil, ErrCloudRunInvalid
		}
		seen[canonical] = true
		result[index] = canonical
	}
	return result, nil
}

func boundedCloudHistoryMessage(message CloudMessage, remaining *int64) CloudHistoryMessage {
	head := cloudMessageHead(message)
	result := CloudHistoryMessage{CloudMessage: message, ContentBytes: head.ContentBytes, ContentSHA256: head.ContentSHA256}
	result.Content, result.Usage = nil, nil
	if head.ContentBytes > *remaining {
		result.ContentOmitted = true
	} else {
		result.Content = append(json.RawMessage(nil), message.Content...)
		*remaining -= head.ContentBytes
	}
	if head.UsageBytes > CloudHistoryMaxUsageBytes || head.UsageBytes > *remaining {
		result.UsageOmitted = head.UsageBytes > 0
	} else {
		result.Usage = append(json.RawMessage(nil), message.Usage...)
		*remaining -= head.UsageBytes
	}
	return result
}

func (s *MemoryStore) GetCloudHistoryMessages(ctx context.Context, uid int64, conversationID string, ids []string, maxBytes int64) ([]CloudHistoryMessage, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	conversationID, err := canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, ErrCloudRunInvalid
	}
	ids, err = cloudHistoryIDs(ids, maxBytes)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	conversation, ok := s.cloudConversations[conversationID]
	if !ok || conversation.UserID != uid {
		return nil, ErrNotFound
	}
	wanted := map[string]bool{}
	for _, id := range ids {
		wanted[id] = true
	}
	matches := map[string]CloudMessage{}
	for _, message := range s.cloudMessages[conversationID] {
		if message.UserID == uid && wanted[message.ID] {
			matches[message.ID] = message
			if len(matches) == len(ids) {
				break
			}
		}
	}
	if len(matches) != len(ids) {
		return nil, ErrNotFound
	}
	result := make([]CloudHistoryMessage, 0, len(ids))
	remaining := maxBytes
	for _, id := range ids {
		result = append(result, boundedCloudHistoryMessage(matches[id], &remaining))
	}
	return result, nil
}

func cloudHistoryFragment(head CloudMessageHead, data []byte, offset int64, limit int64) (*CloudHistoryExcerpt, error) {
	start := 0
	for start < len(data) && !utf8.RuneStart(data[start]) {
		start++
	}
	end := len(data)
	for end > start && !utf8.Valid(data[start:end]) {
		end--
	}
	value := string(data[start:end])
	if len(data) > 0 && end == start {
		return nil, ErrCloudRunInvalid
	}
	from := offset + int64(start)
	next := offset + int64(end)
	result := &CloudHistoryExcerpt{CloudMessageHead: head, OffsetBytes: from, NextOffsetBytes: next, HasMore: next < head.ContentBytes, Encoding: "json_utf8_excerpt", Excerpt: value, Complete: from == 0 && next == head.ContentBytes}
	if result.Complete {
		result.Content = json.RawMessage(value)
		result.Excerpt = ""
	}
	return result, nil
}

func (s *MemoryStore) ReadCloudHistoryFragment(ctx context.Context, uid int64, conversationID, id string, offset, limit int64) (*CloudHistoryExcerpt, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	ids, err := cloudHistoryIDs([]string{id}, 1)
	if err != nil || offset < 0 || offset > CloudRunMaxInputBytes || limit < 1 || limit > CloudHistoryMaxExcerptBytes {
		return nil, ErrCloudRunInvalid
	}
	conversationID, err = canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, ErrCloudRunInvalid
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	conversation, ok := s.cloudConversations[conversationID]
	if !ok || conversation.UserID != uid {
		return nil, ErrNotFound
	}
	for _, message := range s.cloudMessages[conversationID] {
		if message.UserID == uid && message.ID == ids[0] {
			if offset > int64(len(message.Content)) {
				return nil, ErrCloudRunInvalid
			}
			end := min(offset+limit, int64(len(message.Content)))
			return cloudHistoryFragment(cloudMessageHead(message), message.Content[offset:end], offset, limit)
		}
	}
	return nil, ErrNotFound
}
