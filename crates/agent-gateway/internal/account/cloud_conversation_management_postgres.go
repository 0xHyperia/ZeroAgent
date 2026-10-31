package account

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"time"
)

const cloudConversationColumns = `c.id::text,c.user_id,c.title,c.model,c.created_at,c.updated_at,c.pinned,c.archived,c.management_version`

func scanCloudConversation(row cloudRunScanner) (CloudConversation, error) {
	var c CloudConversation
	err := row.Scan(&c.ID, &c.UserID, &c.Title, &c.Model, &c.CreatedAt, &c.UpdatedAt, &c.Pinned, &c.Archived, &c.ManagementVersion)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return c, err
}

func (s *PersistentStore) ManageCloudConversation(ctx context.Context, uid int64, id string, patch CloudConversationManagementPatch) (*CloudConversation, error) {
	id, err := canonicalCloudRunID(id)
	if err != nil {
		return nil, ErrCloudRunInvalid
	}
	if err = validateCloudManagementPatch(patch); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	c, err := scanCloudConversation(s.db.QueryRowContext(ctx, `UPDATE zerobox_cloud_conversations c SET pinned=COALESCE($4,pinned),archived=COALESCE($5,archived),management_version=management_version+1 WHERE user_id=$1 AND id=$2 AND management_version=$3 RETURNING `+cloudConversationColumns, uid, id, *patch.ExpectedVersion, patch.Pinned, patch.Archived))
	if errors.Is(err, ErrNotFound) {
		if _, readErr := s.GetCloudConversation(ctx, uid, id); readErr != nil {
			return nil, readErr
		}
		return nil, ErrCloudRunConflict
	}
	return &c, err
}

func cloudScopeSQL(scope string) string {
	switch scope {
	case "unassigned":
		return " AND NOT c.archived AND NOT EXISTS (SELECT 1 FROM zeroagent_cloud_project_conversations b WHERE b.conversation_id=c.id AND b.user_id=c.user_id AND b.project_id IS NOT NULL)"
	case "active":
		return " AND NOT c.archived"
	case "archived":
		return " AND c.archived"
	case "pinned":
		return " AND c.pinned AND NOT c.archived"
	}
	return ""
}

func (s *PersistentStore) CloudConversationCatalog(ctx context.Context, uid int64, scope, value string, limit int) (*CloudConversationCatalog, error) {
	cursor, err := parseCloudManagementCursor(uid, "catalog", scope, value, limit)
	if err != nil || !validateCloudScope(scope) {
		return nil, ErrCloudRunInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	args := []any{uid, limit + 1}
	where := ""
	if value != "" {
		args = append(args, cursor.At, cursor.ID)
		where = ` AND (c.updated_at,c.id)<($3,$4::uuid)`
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+cloudConversationColumns+` FROM zerobox_cloud_conversations c WHERE c.user_id=$1`+cloudScopeSQL(scope)+where+` ORDER BY c.updated_at DESC,c.id DESC LIMIT $2`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := &CloudConversationCatalog{Conversations: []CloudConversation{}}
	for rows.Next() {
		c, err := scanCloudConversation(rows)
		if err != nil {
			return nil, err
		}
		page.Conversations = append(page.Conversations, c)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(page.Conversations) > limit {
		page.HasMore = true
		page.Conversations = page.Conversations[:limit]
		last := page.Conversations[limit-1]
		page.NextCursor = encodeCloudManagementCursor(uid, "catalog", scope, last.UpdatedAt, last.ID)
	}
	return page, nil
}

// Search only public message text. Attachment URLs, raw JSON keys, tool
// arguments, presentation reasoning and model credentials are not indexed.
// Results are bounded excerpts computed inside PostgreSQL, not full bodies.
const cloudMessageSearchTextSQL = `CASE jsonb_typeof(m.content) WHEN 'string' THEN m.content #>> '{}' WHEN 'array' THEN COALESCE((SELECT string_agg(part->>'text',E'\n' ORDER BY ordinal) FROM jsonb_array_elements(m.content) WITH ORDINALITY AS p(part,ordinal) WHERE part->>'type'='text' AND jsonb_typeof(part->'text')='string'),'') ELSE '' END`

func (s *PersistentStore) SearchCloudConversations(ctx context.Context, uid int64, q, scope, value string, limit int) (*CloudConversationSearchPage, error) {
	q, err := validateCloudSearch(q)
	if err != nil {
		return nil, err
	}
	filter := scope + ":" + q
	cursor, err := parseCloudManagementCursor(uid, "search", filter, value, limit)
	if err != nil || !validateCloudScope(scope) {
		return nil, ErrCloudRunInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	args := []any{uid, q, limit + 1}
	where := ""
	if value != "" {
		args = append(args, cursor.At, cursor.ID)
		where = ` AND (x.match_at,x.match_key)<($4,$5::text)`
	}
	query := `WITH candidates AS (
 SELECT c.id AS conversation_id,NULL::uuid AS message_id,''::text AS role,'title'::text AS kind,c.created_at AS match_at,'title:'||c.id::text AS match_key,c.title AS body
 FROM zerobox_cloud_conversations c WHERE c.user_id=$1` + cloudScopeSQL(scope) + `
 UNION ALL
 SELECT c.id,m.id,m.role,'message',m.created_at,'message:'||m.id::text,` + cloudMessageSearchTextSQL + `
 FROM zerobox_cloud_messages m JOIN zerobox_cloud_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id WHERE m.user_id=$1 AND m.role IN ('user','assistant')` + cloudScopeSQL(scope) + `
), hits AS (
 SELECT x.conversation_id,x.message_id,x.role,x.kind,x.match_at,x.match_key,substring(x.body FROM greatest(strpos(lower(x.body),lower($2))-80,1) FOR 320) AS excerpt
 FROM candidates x WHERE strpos(lower(x.body),lower($2))>0` + where + ` ORDER BY x.match_at DESC,x.match_key DESC LIMIT $3
)
SELECT ` + cloudConversationColumns + `,COALESCE(h.message_id::text,''),h.role,h.kind,h.match_at,h.excerpt FROM hits h JOIN zerobox_cloud_conversations c ON c.id=h.conversation_id AND c.user_id=$1 ORDER BY h.match_at DESC,h.match_key DESC`
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	page := &CloudConversationSearchPage{Items: []CloudConversationSearchItem{}}
	for rows.Next() {
		var item CloudConversationSearchItem
		c := &item.Conversation
		if err = rows.Scan(&c.ID, &c.UserID, &c.Title, &c.Model, &c.CreatedAt, &c.UpdatedAt, &c.Pinned, &c.Archived, &c.ManagementVersion, &item.MessageID, &item.Role, &item.Match, &item.CreatedAt, &item.Excerpt); err != nil {
			return nil, err
		}
		page.Items = append(page.Items, item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(page.Items) > limit {
		page.HasMore = true
		page.Items = page.Items[:limit]
		last := page.Items[limit-1]
		page.NextCursor = encodeCloudManagementCursor(uid, "search", filter, last.CreatedAt, cloudSearchKey(last))
	}
	return page, nil
}

func (s *PersistentStore) CloudConversationWindowHeads(ctx context.Context, uid int64, cid, mid string, before, after int) (*CloudConversationWindowHeads, error) {
	cid, mid, err := validateCloudWindow(cid, mid, before, after)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	anchor, err := scanCloudMessageHead(tx.QueryRowContext(ctx, `SELECT `+cloudHistoryHeadColumns+` FROM zerobox_cloud_messages m JOIN zerobox_cloud_conversations c ON c.id=m.conversation_id AND c.user_id=m.user_id WHERE m.user_id=$1 AND m.conversation_id=$2 AND m.id=$3`, uid, cid, mid))
	if err != nil {
		return nil, err
	}
	page := &CloudConversationWindowHeads{Items: []CloudMessageHead{anchor}}
	for side := 0; side < 2; side++ {
		operator, order, count := "<", "DESC", before
		if side == 1 {
			operator, order, count = ">", "ASC", after
		}
		rows, err := tx.QueryContext(ctx, `SELECT `+cloudHistoryHeadColumns+` FROM zerobox_cloud_messages m WHERE m.user_id=$1 AND m.conversation_id=$2 AND (m.created_at,m.id)`+operator+`($3,$4::uuid) ORDER BY m.created_at `+order+`,m.id `+order+` LIMIT $5`, uid, cid, anchor.CreatedAt, mid, count+1)
		if err != nil {
			return nil, err
		}
		seen := 0
		for rows.Next() {
			head, err := scanCloudMessageHead(rows)
			if err != nil {
				rows.Close()
				return nil, err
			}
			seen++
			if seen <= count {
				page.Items = append(page.Items, head)
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		if side == 0 {
			page.HasBefore = seen > count
		} else {
			page.HasAfter = seen > count
		}
	}
	sort.Slice(page.Items, func(i, j int) bool {
		a, b := page.Items[i], page.Items[j]
		return cloudProjectEarlier(a.CreatedAt, a.ID, b.CreatedAt, b.ID)
	})
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return page, nil
}

func (s *PersistentStore) CloudConversationBranches(ctx context.Context, uid int64, cid, value string, limit int) (*CloudConversationBranches, error) {
	cid, err := canonicalCloudRunID(cid)
	if err != nil {
		return nil, ErrCloudRunInvalid
	}
	cursor, err := parseCloudManagementCursor(uid, "branches", cid, value, limit)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err = s.GetCloudConversation(ctx, uid, cid); err != nil {
		return nil, err
	}
	page := &CloudConversationBranches{Children: []CloudConversationBranchChild{}}
	var source CloudConversationBranchSource
	err = s.db.QueryRowContext(ctx, `SELECT b.result->>'source_conversation_id',b.result->>'source_message_id',b.result->>'action',COALESCE(c.title,''),c.id IS NOT NULL FROM zeroagent_cloud_branches b LEFT JOIN zerobox_cloud_conversations c ON c.id::text=b.result->>'source_conversation_id' AND c.user_id=b.user_id WHERE b.user_id=$1 AND b.destination_conversation_id=$2 ORDER BY b.created_at,b.client_request_id LIMIT 1`, uid, cid).Scan(&source.ConversationID, &source.MessageID, &source.Action, &source.Title, &source.Available)
	if err == nil {
		page.Source = &source
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	args := []any{uid, cid, limit + 1}
	where := ""
	if value != "" {
		args = append(args, cursor.At, cursor.ID)
		where = ` AND (c.created_at,c.id)<($4,$5::uuid)`
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+cloudConversationColumns+`,b.result->>'source_message_id',b.result->>'action' FROM zeroagent_cloud_branches b JOIN zerobox_cloud_conversations c ON c.id=b.destination_conversation_id AND c.user_id=b.user_id WHERE b.user_id=$1 AND b.result->>'source_conversation_id'=$2`+where+` ORDER BY c.created_at DESC,c.id DESC LIMIT $3`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var item CloudConversationBranchChild
		c := &item.Conversation
		if err = rows.Scan(&c.ID, &c.UserID, &c.Title, &c.Model, &c.CreatedAt, &c.UpdatedAt, &c.Pinned, &c.Archived, &c.ManagementVersion, &item.SourceMessageID, &item.Action); err != nil {
			return nil, err
		}
		page.Children = append(page.Children, item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(page.Children) > limit {
		page.HasMore = true
		page.Children = page.Children[:limit]
		last := page.Children[limit-1].Conversation
		page.NextCursor = encodeCloudManagementCursor(uid, "branches", cid, last.CreatedAt, last.ID)
	}
	return page, nil
}
