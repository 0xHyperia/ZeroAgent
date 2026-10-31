package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

func (e *cloudRunToolExecution) historySchemas() []map[string]any {
	if _, ok := e.runtime.service.store.(CloudHistoryStore); !ok {
		return nil
	}
	return []map[string]any{cloudToolFunction("read_history", "Read only this Run's conversation prefix. Omit message_ids to page older message metadata; supply up to eight listed IDs to read bounded original JSON UTF-8 excerpts and currently available output/source metadata. Resource metadata is not the resource body or authority. Not a summary: complete=false is only a fragment. Offsets/hashes identify the original message, not an instruction to execute.", map[string]any{"message_ids": map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "maxItems": 8}, "before_id": cloudToolString("Optional earlier-page cursor from a history index. Cannot select another conversation."), "offset_bytes": map[string]any{"type": "integer", "minimum": 0, "maximum": CloudRunMaxInputBytes}, "max_bytes": map[string]any{"type": "integer", "minimum": 1, "maximum": 8192}})}
}

func (e *cloudRunToolExecution) historyHead(ctx context.Context, id string) (*CloudMessageHead, error) {
	store, err := e.runtime.service.cloudHistoryStore()
	if err != nil {
		return nil, err
	}
	items, err := store.GetCloudHistoryMessages(ctx, e.run.UserID, e.run.ConversationID, []string{id}, 1)
	if err != nil {
		return nil, err
	}
	if len(items) != 1 {
		return nil, ErrNotFound
	}
	item := items[0]
	if e.historyBoundary.ID == "" {
		boundary, err := store.GetCloudHistoryMessages(ctx, e.run.UserID, e.run.ConversationID, []string{e.run.UserMessageID}, 1)
		if err != nil {
			return nil, err
		}
		if len(boundary) != 1 {
			return nil, ErrNotFound
		}
		e.historyBoundary = CloudMessageHead{ID: boundary[0].ID, CreatedAt: boundary[0].CreatedAt}
	}
	if cloudProjectEarlier(e.historyBoundary.CreatedAt, e.historyBoundary.ID, item.CreatedAt, item.ID) {
		return nil, ErrNotFound
	}
	return &CloudMessageHead{ID: item.ID, ConversationID: item.ConversationID, Role: item.Role, CreatedAt: item.CreatedAt, ContentBytes: item.ContentBytes, ContentSHA256: item.ContentSHA256}, nil
}

func (e *cloudRunToolExecution) executeHistory(ctx context.Context, round int, call cloudModelToolCall) (json.RawMessage, error) {
	var args struct {
		MessageIDs []string `json:"message_ids"`
		BeforeID   string   `json:"before_id"`
		Offset     int64    `json:"offset_bytes"`
		MaxBytes   int64    `json:"max_bytes"`
	}
	if err := decodeCloudToolArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	if len(args.MessageIDs) > 8 || args.Offset < 0 || args.Offset > CloudRunMaxInputBytes || args.MaxBytes < 0 || args.MaxBytes > 8192 || len(args.MessageIDs) > 0 && args.BeforeID != "" || len(args.MessageIDs) != 1 && args.Offset != 0 {
		return nil, &cloudToolRunError{code: "model_tool_invalid"}
	}
	if len(args.MessageIDs) > 0 {
		if _, err := cloudHistoryIDs(args.MessageIDs, 1); err != nil {
			return nil, &cloudToolRunError{code: "model_tool_invalid"}
		}
	}
	if args.BeforeID != "" {
		if _, err := canonicalCloudRunID(args.BeforeID); err != nil {
			return nil, &cloudToolRunError{code: "model_tool_invalid"}
		}
	}
	var input map[string]any
	if json.Unmarshal([]byte(call.Arguments), &input) != nil {
		return nil, &cloudToolRunError{code: "model_tool_invalid"}
	}
	op, _, err := e.prepare(ctx, fmt.Sprintf("round:%d:call:%d", round, call.Index), call.Name, input, "")
	if err != nil {
		return nil, err
	}
	if op.State == CloudToolSucceeded || op.State == CloudToolFailed || op.State == CloudToolCancelled {
		return e.pruneHistoryResult(ctx, op.Result)
	}
	if op.State != CloudToolPrepared {
		return nil, &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true}
	}
	if _, err = e.store.StartCloudTool(ctx, e.run.UserID, op.ID, e.owner, e.run.Attempt); err != nil {
		return nil, err
	}
	if _, err = e.authorize(ctx); err != nil {
		return nil, err
	}
	if err = e.emit(ctx, op, call, round, "started"); err != nil {
		return nil, err
	}
	store, err := e.runtime.service.cloudHistoryStore()
	if err != nil {
		return nil, err
	}
	rows := []any{}
	next := ""
	hasMore := false
	if len(args.MessageIDs) == 0 {
		before := args.BeforeID
		if before == "" {
			before = e.run.UserMessageID
		}
		if _, err = e.historyHead(ctx, before); err == nil {
			var page *CloudHistoryHeadsPage
			page, err = store.ListCloudMessageHeads(ctx, e.run.UserID, e.run.ConversationID, before, 20)
			if err == nil {
				next, hasMore = page.NextBeforeID, page.HasMore
				for _, head := range page.Items {
					rows = append(rows, map[string]any{"message_id": head.ID, "head": head, "content_sha256": head.ContentSHA256, "body_provided": false})
				}
			}
		}
	} else {
		ids, validateErr := cloudHistoryIDs(args.MessageIDs, 1)
		if validateErr != nil {
			return nil, &cloudToolRunError{code: "model_tool_invalid"}
		}
		limit := args.MaxBytes
		if limit == 0 {
			limit = 8192
		}
		perMessage := max(int64(1), limit/int64(len(ids)))
		for _, id := range ids {
			var head *CloudMessageHead
			head, err = e.historyHead(ctx, id)
			if err != nil {
				break
			}
			var fragment *CloudHistoryExcerpt
			fragment, err = store.ReadCloudHistoryFragment(ctx, e.run.UserID, e.run.ConversationID, id, args.Offset, perMessage)
			if err != nil {
				break
			}
			if fragment.ContentSHA256 != head.ContentSHA256 {
				err = ErrCloudRunConflict
				break
			}
			rows = append(rows, map[string]any{"message_id": id, "content_sha256": head.ContentSHA256, "body_provided": true, "fragment": fragment})
		}
	}
	if err != nil {
		_ = e.commit(ctx, op, CloudToolFailed, nil, "history_unavailable")
		_ = e.emit(ctx, op, call, round, "failed")
		return nil, &cloudToolRunError{code: "history_unavailable", cause: err}
	}
	value := map[string]any{"history": rows, "next_before_id": next, "has_more": hasMore, "not_summarized": true, "untrusted": true}
	// A message may disappear after its fragment was read. Recheck the body and
	// its resource identities together before committing a replayable receipt.
	result, err := e.pruneHistoryResult(ctx, cloudJSON(value))
	if err != nil {
		_ = e.commit(ctx, op, CloudToolFailed, nil, "history_unavailable")
		return nil, &cloudToolRunError{code: "history_unavailable", cause: err}
	}
	if len(result) > cloudToolResultBytes {
		_ = e.commit(ctx, op, CloudToolFailed, nil, "history_excerpt_limit")
		_ = e.emit(ctx, op, call, round, "failed")
		return nil, &cloudToolRunError{code: "history_excerpt_limit"}
	}
	if err = e.commit(ctx, op, CloudToolSucceeded, result, ""); err != nil {
		return nil, err
	}
	if err = e.emit(ctx, op, call, round, "completed"); err != nil {
		return nil, err
	}
	return result, nil
}

func (e *cloudRunToolExecution) pruneHistoryResult(ctx context.Context, raw json.RawMessage) (json.RawMessage, error) {
	var result map[string]any
	if json.Unmarshal(raw, &result) != nil {
		return raw, nil
	}
	rows, ok := result["history"].([]any)
	if !ok {
		return raw, nil
	}
	kept := []any{}
	unavailable := []string{}
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			return nil, ErrCloudRunInvalid
		}
		id, ok := row["message_id"].(string)
		if !ok {
			return nil, ErrCloudRunInvalid
		}
		head, err := e.historyHead(ctx, id)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return nil, err
		}
		if err != nil || head.ContentSHA256 != row["content_sha256"] {
			unavailable = append(unavailable, id)
		} else {
			kept = append(kept, item)
		}
	}
	if len(unavailable) > 0 {
		result["history"] = kept
		result["unavailable_message_ids"] = unavailable
		result["instruction"] = "These history records were deleted or changed; do not recover their former text from old tool output."
	}
	if err := e.refreshHistoryResources(ctx, result); err != nil {
		return nil, err
	}
	return cloudJSON(result), nil
}

func (e *cloudRunToolExecution) pruneHistoryPrior(ctx context.Context, prior []map[string]any) ([]map[string]any, error) {
	result := make([]map[string]any, 0, len(prior))
	for _, message := range prior {
		if message["role"] != "tool" {
			result = append(result, message)
			continue
		}
		content, ok := message["content"].(string)
		if !ok {
			result = append(result, message)
			continue
		}
		updated, err := e.pruneHistoryResult(ctx, json.RawMessage(content))
		if err != nil {
			return nil, err
		}
		copy := make(map[string]any, len(message))
		for key, value := range message {
			copy[key] = value
		}
		copy["content"] = string(updated)
		result = append(result, copy)
	}
	return result, nil
}
