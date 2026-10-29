package account

import (
	"context"
	"net/http"
	"sort"
)

func (s *Service) cloudHistoryStore() (CloudHistoryStore, error) {
	store, ok := s.store.(CloudHistoryStore)
	if !ok {
		return nil, &APIError{Status: http.StatusServiceUnavailable, Message: "bounded conversation history is unavailable"}
	}
	return store, nil
}

func (s *Service) CloudHistoryPage(ctx context.Context, uid int64, conversationID, beforeID string, limit int) (*CloudHistoryPage, error) {
	store, err := s.cloudHistoryStore()
	if err != nil {
		return nil, err
	}
	heads, err := store.ListCloudMessageHeads(ctx, uid, conversationID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	page := &CloudHistoryPage{Messages: []CloudHistoryMessage{}, NextBeforeID: heads.NextBeforeID, HasMore: heads.HasMore}
	if len(heads.Items) == 0 {
		return page, nil
	}
	// Spend a page's bounded body budget on the newest messages first. Missing
	// bodies stay visible as exact size/hash metadata, not empty fake answers.
	ids := make([]string, len(heads.Items))
	for index, head := range heads.Items {
		ids[len(ids)-1-index] = head.ID
	}
	page.Messages, err = store.GetCloudHistoryMessages(ctx, uid, conversationID, ids, CloudHistoryPageBytes)
	if err != nil {
		return nil, err
	}
	for i, j := 0, len(page.Messages)-1; i < j; i, j = i+1, j-1 {
		page.Messages[i], page.Messages[j] = page.Messages[j], page.Messages[i]
	}
	return page, nil
}

func (s *Service) CloudHistoryMessage(ctx context.Context, uid int64, conversationID, id string) (*CloudHistoryMessage, error) {
	store, err := s.cloudHistoryStore()
	if err != nil {
		return nil, err
	}
	items, err := store.GetCloudHistoryMessages(ctx, uid, conversationID, []string{id}, CloudRunMaxInputBytes)
	if err != nil {
		return nil, err
	}
	if len(items) != 1 {
		return nil, ErrNotFound
	}
	if items[0].ContentOmitted {
		return nil, ErrCloudRunLimit
	}
	return &items[0], nil
}

// Compatibility callers explicitly get a bounded complete history or an error;
// the model and Web pagination never call this whole-history helper.
func boundedLegacyCloudMessages(ctx context.Context, store CloudHistoryStore, uid int64, conversationID string) ([]CloudMessage, error) {
	heads := []CloudMessageHead{}
	before := ""
	total := int64(0)
	for {
		page, err := store.ListCloudMessageHeads(ctx, uid, conversationID, before, CloudHistoryMaxPage)
		if err != nil {
			return nil, err
		}
		for _, head := range page.Items {
			total += head.ContentBytes + head.UsageBytes
			if total > CloudRunMaxInputBytes || head.UsageBytes > CloudHistoryMaxUsageBytes || len(heads) >= 10000 {
				return nil, ErrCloudRunLimit
			}
			heads = append(heads, head)
		}
		if !page.HasMore {
			break
		}
		before = page.NextBeforeID
	}
	sort.Slice(heads, func(i, j int) bool {
		return cloudProjectEarlier(heads[i].CreatedAt, heads[i].ID, heads[j].CreatedAt, heads[j].ID)
	})
	result := make([]CloudMessage, 0, len(heads))
	remaining := int64(CloudRunMaxInputBytes)
	for start := 0; start < len(heads); start += CloudHistoryMaxPage {
		end := min(start+CloudHistoryMaxPage, len(heads))
		ids := make([]string, 0, end-start)
		for _, head := range heads[start:end] {
			ids = append(ids, head.ID)
		}
		items, err := store.GetCloudHistoryMessages(ctx, uid, conversationID, ids, remaining)
		if err != nil {
			return nil, err
		}
		for _, item := range items {
			if item.ContentOmitted || item.UsageOmitted {
				return nil, ErrCloudRunLimit
			}
			remaining -= int64(len(item.Content) + len(item.Usage))
			result = append(result, item.CloudMessage)
		}
	}
	return result, nil
}
