package account

import (
	"context"
	"sort"
)

type cloudHistorySelection struct {
	Selected      []CloudMessageHead `json:"selected"`
	Omitted       []CloudMessageHead `json:"omitted"`
	HasOlder      bool               `json:"has_older"`
	BeforeID      string             `json:"before_id,omitempty"`
	NotSummarized bool               `json:"not_summarized"`
}

func (s *Service) cloudModelHistory(ctx context.Context, run *CloudRun, parameters CloudRunModelParameters) ([]CloudMessage, cloudHistorySelection, error) {
	selection := cloudHistorySelection{Selected: []CloudMessageHead{}, Omitted: []CloudMessageHead{}, NotSummarized: true}
	store, err := s.cloudHistoryStore()
	if err != nil {
		return nil, selection, err
	}
	mandatory, err := store.GetCloudHistoryMessages(ctx, run.UserID, run.ConversationID, []string{run.UserMessageID}, CloudHistoryMaxWindowBytes)
	if err != nil {
		return nil, selection, err
	}
	if len(mandatory) != 1 || mandatory[0].ContentOmitted {
		return nil, selection, &cloudToolRunError{code: "model_context_window_exceeded"}
	}
	mandatoryBytes := mandatory[0].ContentBytes + int64(len(mandatory[0].Usage))
	mandatory = nil
	heads, err := store.ListCloudMessageHeads(ctx, run.UserID, run.ConversationID, run.UserMessageID, 63)
	if err != nil {
		return nil, selection, err
	}
	budget := CloudHistoryPageBytes
	if parameters.ContextWindow > 0 {
		budget = min(CloudHistoryMaxWindowBytes, parameters.ContextWindow*2)
	}
	budget = max(budget, mandatoryBytes)
	ids := []string{run.UserMessageID}
	for index := len(heads.Items) - 1; index >= 0; index-- {
		ids = append(ids, heads.Items[index].ID)
	}
	items, err := store.GetCloudHistoryMessages(ctx, run.UserID, run.ConversationID, ids, budget)
	if err != nil {
		return nil, selection, err
	}
	selected := make([]CloudMessage, 0, len(items))
	for _, item := range items {
		head := CloudMessageHead{ID: item.ID, ConversationID: item.ConversationID, Role: item.Role, CreatedAt: item.CreatedAt, ContentBytes: item.ContentBytes, ContentSHA256: item.ContentSHA256}
		if item.ContentOmitted {
			selection.Omitted = append(selection.Omitted, head)
			continue
		}
		selected = append(selected, item.CloudMessage)
		selection.Selected = append(selection.Selected, head)
	}
	sort.Slice(selected, func(i, j int) bool {
		return cloudProjectEarlier(selected[i].CreatedAt, selected[i].ID, selected[j].CreatedAt, selected[j].ID)
	})
	selection.HasOlder = heads.HasMore
	selection.BeforeID = heads.NextBeforeID
	return selected, selection, nil
}

func cloudHistorySelectionNotice(selection cloudHistorySelection) string {
	if len(selection.Omitted) == 0 && !selection.HasOlder {
		return ""
	}
	return "当前模型上下文只纳入有界的近期消息；较早消息未被摘要，下面索引也不代表已经读到正文。必要时使用read_history按message_ids或before_id读取当前会话的受控记录；不得猜测未提供内容、不得声称已经总结全部历史。选择与省略索引：" + string(cloudJSON(selection))
}
