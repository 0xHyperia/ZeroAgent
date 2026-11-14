package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/lib/pq"
)

const cloudHistoryHeadColumns = `m.id::text,m.conversation_id::text,m.role,m.created_at,octet_length(m.content::text),encode(sha256(convert_to(m.content::text,'UTF8')),'hex'),octet_length(COALESCE(m.usage::text,'')),octet_length(COALESCE(m.presentation::text,''))`

func scanCloudMessageHead(row cloudRunScanner) (CloudMessageHead, error) {
	var head CloudMessageHead
	err := row.Scan(&head.ID, &head.ConversationID, &head.Role, &head.CreatedAt, &head.ContentBytes, &head.ContentSHA256, &head.UsageBytes, &head.PresentationBytes)
	if errors.Is(err, sql.ErrNoRows) {
		return head, ErrNotFound
	}
	return head, err
}

func (s *PersistentStore) ListCloudMessageHeads(ctx context.Context, uid int64, conversationID, beforeID string, limit int) (*CloudHistoryHeadsPage, error) {
	conversationID, beforeID, err := validateCloudHistoryPage(conversationID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var exists bool
	if err = s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zerobox_cloud_conversations WHERE user_id=$1 AND id=$2)`, uid, conversationID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	args := []any{uid, conversationID, limit + 1}
	where := ""
	if beforeID != "" {
		var at time.Time
		err = s.db.QueryRowContext(ctx, `SELECT created_at FROM zerobox_cloud_messages WHERE user_id=$1 AND conversation_id=$2 AND id=$3`, uid, conversationID, beforeID).Scan(&at)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		args = append(args, at, beforeID)
		where = ` AND (m.created_at,m.id)<($4,$5::uuid)`
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+cloudHistoryHeadColumns+` FROM zerobox_cloud_messages m JOIN zerobox_cloud_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id WHERE m.user_id=$1 AND m.conversation_id=$2`+where+` ORDER BY m.created_at DESC,m.id DESC LIMIT $3`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	page := &CloudHistoryHeadsPage{Items: []CloudMessageHead{}}
	for rows.Next() {
		head, err := scanCloudMessageHead(rows)
		if err != nil {
			return nil, err
		}
		page.Items = append(page.Items, head)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(page.Items) > limit {
		page.HasMore = true
		page.Items = page.Items[:limit]
	}
	for i, j := 0, len(page.Items)-1; i < j; i, j = i+1, j-1 {
		page.Items[i], page.Items[j] = page.Items[j], page.Items[i]
	}
	if page.HasMore && len(page.Items) > 0 {
		page.NextBeforeID = page.Items[0].ID
	}
	return page, nil
}

func (s *PersistentStore) GetCloudHistoryMessages(ctx context.Context, uid int64, conversationID string, ids []string, maxBytes int64) ([]CloudHistoryMessage, error) {
	conversationID, err := canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, ErrCloudRunInvalid
	}
	ids, err = cloudHistoryIDs(ids, maxBytes)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, `SELECT `+cloudHistoryHeadColumns+` FROM zerobox_cloud_messages m JOIN zerobox_cloud_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id WHERE m.user_id=$1 AND m.conversation_id=$2 AND m.id=ANY($3::uuid[]) ORDER BY array_position($3::uuid[],m.id)`, uid, conversationID, pq.Array(ids))
	if err != nil {
		return nil, err
	}
	heads := []CloudMessageHead{}
	for rows.Next() {
		head, scanErr := scanCloudMessageHead(rows)
		if scanErr != nil {
			_ = rows.Close()
			return nil, scanErr
		}
		heads = append(heads, head)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	if len(heads) != len(ids) {
		return nil, ErrNotFound
	}
	result := make([]CloudHistoryMessage, 0, len(heads))
	remaining := maxBytes
	for _, head := range heads {
		include := head.ContentBytes <= remaining
		if include {
			remaining -= head.ContentBytes
		}
		usage := head.UsageBytes <= CloudHistoryMaxUsageBytes && head.UsageBytes <= remaining
		if usage {
			remaining -= head.UsageBytes
		}
		message := CloudHistoryMessage{CloudMessage: CloudMessage{ID: head.ID, ConversationID: conversationID, UserID: uid, Role: head.Role, CreatedAt: head.CreatedAt}, ContentBytes: head.ContentBytes, ContentSHA256: head.ContentSHA256, ContentOmitted: !include, UsageOmitted: head.UsageBytes > 0 && !usage}
		if include || usage && head.UsageBytes > 0 {
			var content, usageBytes []byte
			err = tx.QueryRowContext(ctx, `SELECT CASE WHEN $4 THEN content ELSE NULL END,CASE WHEN $5 THEN usage ELSE NULL END FROM zerobox_cloud_messages WHERE user_id=$1 AND conversation_id=$2 AND id=$3`, uid, conversationID, head.ID, include, usage).Scan(&content, &usageBytes)
			if err != nil {
				return nil, err
			}
			message.Content = json.RawMessage(content)
			message.Usage = json.RawMessage(usageBytes)
		}
		result = append(result, message)
	}
	// Allocate presentation only after every body has its existing budget.
	for index, head := range heads {
		if head.PresentationBytes > remaining {
			result[index].PresentationOmitted = head.PresentationBytes > 0
			continue
		}
		if head.PresentationBytes > 0 {
			var raw []byte
			if err = tx.QueryRowContext(ctx, `SELECT presentation FROM zerobox_cloud_messages WHERE user_id=$1 AND conversation_id=$2 AND id=$3`, uid, conversationID, head.ID).Scan(&raw); err != nil {
				return nil, err
			}
			result[index].Presentation = json.RawMessage(raw)
			remaining -= head.PresentationBytes
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *PersistentStore) ReadCloudHistoryFragment(ctx context.Context, uid int64, conversationID, id string, offset, limit int64) (*CloudHistoryExcerpt, error) {
	conversationID, err := canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, ErrCloudRunInvalid
	}
	ids, err := cloudHistoryIDs([]string{id}, 1)
	if err != nil || offset < 0 || offset > CloudRunMaxInputBytes || limit < 1 || limit > CloudHistoryMaxExcerptBytes {
		return nil, ErrCloudRunInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	var head CloudMessageHead
	var data []byte
	err = s.db.QueryRowContext(ctx, `SELECT `+cloudHistoryHeadColumns+`,substring(convert_to(m.content::text,'UTF8') FROM $4::integer+1 FOR $5::integer) FROM zerobox_cloud_messages m JOIN zerobox_cloud_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id WHERE m.user_id=$1 AND m.conversation_id=$2 AND m.id=$3`, uid, conversationID, ids[0], offset, limit).Scan(&head.ID, &head.ConversationID, &head.Role, &head.CreatedAt, &head.ContentBytes, &head.ContentSHA256, &head.UsageBytes, &head.PresentationBytes, &data)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if offset > head.ContentBytes {
		return nil, ErrCloudRunInvalid
	}
	return cloudHistoryFragment(head, data, offset, limit)
}
