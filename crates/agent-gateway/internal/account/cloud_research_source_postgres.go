package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// Snapshot rows, dedupe receipts and search reservations deliberately outlive
// Run/conversation deletion. Only an explicit account source deletion clears
// readable text. Reservations are not refunded by deleting a conversation.
const CloudResearchSourceSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_research_sources (
 id UUID PRIMARY KEY,user_id BIGINT NOT NULL,run_id UUID NOT NULL,conversation_id UUID NOT NULL,
 tool_operation_id UUID NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 9),
 kind TEXT NOT NULL CHECK(kind IN ('search_snippet','page')),url TEXT NOT NULL,final_url TEXT NOT NULL DEFAULT '',
 title TEXT NOT NULL CHECK(octet_length(title)<=512),snippet TEXT NOT NULL DEFAULT '' CHECK(octet_length(snippet)<=4096),
 body TEXT NOT NULL DEFAULT '' CHECK(octet_length(body)<=1048576),
 sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),body_sha256 TEXT NOT NULL DEFAULT '',
 observed_at TIMESTAMPTZ NOT NULL,truncated BOOLEAN NOT NULL DEFAULT FALSE,text_bytes INTEGER NOT NULL,line_count INTEGER NOT NULL,
 version BIGINT NOT NULL DEFAULT 1,created_at TIMESTAMPTZ NOT NULL,deleted_at TIMESTAMPTZ NULL,
 UNIQUE(tool_operation_id,ordinal),CHECK(kind='page' OR (body='' AND final_url='' AND body_sha256='' AND text_bytes=0 AND line_count=0))
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_research_sources_library_idx ON zeroagent_cloud_research_sources(user_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS zeroagent_cloud_research_sources_conversation_idx ON zeroagent_cloud_research_sources(user_id,conversation_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS zeroagent_cloud_research_publications (
 operation_id UUID PRIMARY KEY,user_id BIGINT NOT NULL,run_id UUID NOT NULL,
 request_hash TEXT NOT NULL CHECK(request_hash ~ '^[0-9a-f]{64}$'),source_ids JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,CHECK(jsonb_typeof(source_ids)='array' AND jsonb_array_length(source_ids)<=10)
);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_research_search_reservations (
 operation_id UUID PRIMARY KEY,user_id BIGINT NOT NULL,run_id UUID NOT NULL,reserved_day DATE NOT NULL,created_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_research_search_budget_idx ON zeroagent_cloud_research_search_reservations(user_id,reserved_day);`

const cloudResearchSourceColumns = `s.id::text,s.user_id,s.run_id::text,s.conversation_id::text,s.tool_operation_id::text,s.ordinal,
 s.kind,s.url,s.final_url,s.title,s.snippet,s.body,s.sha256,s.body_sha256,s.observed_at,s.truncated,s.text_bytes,s.line_count,s.version,s.created_at,s.deleted_at`

var cloudResearchSourceMetadataColumns = strings.Replace(cloudResearchSourceColumns, "s.body,", "'',", 1)

func scanCloudResearchSource(row interface{ Scan(...any) error }) (*CloudResearchSource, error) {
	var source CloudResearchSource
	var deleted sql.NullTime
	err := row.Scan(&source.ID, &source.UserID, &source.RunID, &source.ConversationID, &source.ToolOperationID, &source.Ordinal, &source.Kind, &source.URL, &source.FinalURL, &source.Title, &source.Snippet, &source.Text, &source.SHA256, &source.BodySHA256, &source.ObservedAt, &source.Truncated, &source.TextBytes, &source.LineCount, &source.Version, &source.CreatedAt, &deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if deleted.Valid {
		source.DeletedAt = &deleted.Time
	}
	return &source, nil
}
func (s *PersistentStore) researchOperationTx(ctx context.Context, tx *sql.Tx, userID int64, runID, owner string, attempt int64, operationID string) (*CloudRun, *CloudToolOperation, error) {
	id, err := canonicalCloudFileID(operationID)
	if err != nil {
		return nil, nil, err
	}
	run, err := s.cloudToolRunTx(ctx, tx, userID, runID, owner, attempt, false)
	if err != nil {
		return nil, nil, err
	}
	op, err := scanCloudTool(tx.QueryRowContext(ctx, "SELECT "+cloudToolColumns+" FROM zeroagent_cloud_tool_operations o WHERE o.id=$1 AND o.user_id=$2 FOR UPDATE", id, userID))
	if err != nil {
		return nil, nil, err
	}
	if op.RunID != run.ID || op.ExecutionAttempt != attempt || op.State != CloudToolExecuting || (op.Name != "web_search" && op.Name != "fetch_page") {
		return nil, nil, ErrCloudToolConflict
	}
	return run, op, nil
}

func researchPublication(ctx context.Context, query interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, userID int64, operationID string) (cloudResearchPublication, error) {
	var publication cloudResearchPublication
	var ids []byte
	err := query.QueryRowContext(ctx, `SELECT user_id,run_id::text,request_hash,source_ids FROM zeroagent_cloud_research_publications WHERE operation_id=$1 AND user_id=$2`, operationID, userID).Scan(&publication.UserID, &publication.RunID, &publication.Hash, &ids)
	if errors.Is(err, sql.ErrNoRows) {
		return publication, ErrNotFound
	}
	if err != nil {
		return publication, err
	}
	if json.Unmarshal(ids, &publication.IDs) != nil || len(publication.IDs) > CloudResearchSourceMaxBatch {
		return publication, ErrCloudResearchSourceInvalid
	}
	return publication, nil
}
func publishedResearchRows(ctx context.Context, query interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, userID int64, operationID string, publication cloudResearchPublication) ([]CloudResearchSource, error) {
	rows, err := query.QueryContext(ctx, "SELECT "+cloudResearchSourceColumns+" FROM zeroagent_cloud_research_sources s WHERE s.tool_operation_id=$1 AND s.user_id=$2 AND s.deleted_at IS NULL ORDER BY s.ordinal", operationID, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := make([]CloudResearchSource, 0, len(publication.IDs))
	for rows.Next() {
		source, err := scanCloudResearchSource(rows)
		if err != nil {
			return nil, err
		}
		position := len(result)
		if position >= len(publication.IDs) || publication.IDs[position] != source.ID {
			return nil, ErrCloudResearchSourceConflict
		}
		result = append(result, *source)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(result) != len(publication.IDs) {
		return nil, ErrNotFound
	}
	return result, nil
}

func (s *PersistentStore) PersistCloudResearchSources(ctx context.Context, userID int64, runID, owner string, attempt int64, operationID string, inputs []CloudResearchSourceInput) ([]CloudResearchSource, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	run, op, err := s.researchOperationTx(ctx, tx, userID, runID, owner, attempt, operationID)
	if err != nil {
		return nil, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	prepared, hash, err := prepareCloudResearchInputs(inputs, now)
	if err != nil {
		return nil, err
	}
	for _, input := range prepared {
		if op.Name == "web_search" && input.Kind != CloudResearchSearchSnippet || op.Name == "fetch_page" && input.Kind != CloudResearchPage {
			return nil, ErrCloudResearchSourceInvalid
		}
	}
	if old, lookupErr := researchPublication(ctx, tx, userID, op.ID); lookupErr == nil {
		if old.RunID != run.ID || old.Hash != hash {
			return nil, ErrCloudResearchSourceConflict
		}
		sources, err := publishedResearchRows(ctx, tx, userID, op.ID, old)
		if err != nil {
			return nil, err
		}
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return sources, nil
	} else if !errors.Is(lookupErr, ErrNotFound) {
		return nil, lookupErr
	}
	if op.Name == "web_search" {
		var reserved bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_research_search_reservations WHERE operation_id=$1 AND user_id=$2 AND run_id=$3)`, op.ID, userID, run.ID).Scan(&reserved); err != nil {
			return nil, err
		}
		if !reserved {
			return nil, ErrCloudResearchSourceQuota
		}
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_research_sources:' || $1::text,0))`, userID); err != nil {
		return nil, err
	}
	var count int
	var used int64
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(text_bytes+octet_length(snippet)),0) FROM zeroagent_cloud_research_sources WHERE user_id=$1 AND deleted_at IS NULL`, userID).Scan(&count, &used); err != nil {
		return nil, err
	}
	for _, input := range prepared {
		used += int64(len(input.Text) + len(input.Snippet))
	}
	if count+len(prepared) > CloudResearchSourceMaxCount || used > CloudResearchSourceMaxAccountBytes {
		return nil, ErrCloudResearchSourceQuota
	}
	publication := cloudResearchPublication{UserID: userID, RunID: run.ID, Hash: hash, IDs: make([]string, 0, len(prepared))}
	result := make([]CloudResearchSource, 0, len(prepared))
	for i, input := range prepared {
		source := newCloudResearchSource(input, run, op.ID, i, now)
		_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_research_sources(id,user_id,run_id,conversation_id,tool_operation_id,ordinal,kind,url,final_url,title,snippet,body,sha256,body_sha256,observed_at,truncated,text_bytes,line_count,version,created_at)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,1,$19)`, source.ID, userID, run.ID, run.ConversationID, op.ID, i, source.Kind, source.URL, source.FinalURL, source.Title, source.Snippet, source.Text, source.SHA256, source.BodySHA256, source.ObservedAt, source.Truncated, source.TextBytes, source.LineCount, now)
		if err != nil {
			return nil, err
		}
		publication.IDs = append(publication.IDs, source.ID)
		result = append(result, source)
	}
	ids, _ := json.Marshal(publication.IDs)
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_research_publications(operation_id,user_id,run_id,request_hash,source_ids,created_at) VALUES($1,$2,$3,$4,$5,$6)`, op.ID, userID, run.ID, hash, []byte(ids), now)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}
func (s *PersistentStore) GetCloudResearchSourcesForOperation(ctx context.Context, userID int64, operationID string) ([]CloudResearchSource, error) {
	id, err := canonicalCloudFileID(operationID)
	if err != nil {
		return nil, err
	}
	publication, err := researchPublication(ctx, s.db, userID, id)
	if err != nil {
		return nil, err
	}
	return publishedResearchRows(ctx, s.db, userID, id, publication)
}
func (s *PersistentStore) GetCloudResearchSource(ctx context.Context, userID int64, id string) (*CloudResearchSource, error) {
	id, err := canonicalCloudFileID(id)
	if err != nil {
		return nil, err
	}
	return scanCloudResearchSource(s.db.QueryRowContext(ctx, "SELECT "+cloudResearchSourceColumns+" FROM zeroagent_cloud_research_sources s WHERE s.id=$1 AND s.user_id=$2 AND s.deleted_at IS NULL", id, userID))
}
func (s *PersistentStore) ListCloudResearchSources(ctx context.Context, userID int64, conversationID, beforeID string, limit int) ([]CloudResearchSource, error) {
	conversationID, beforeID, err := validateCloudFileList(conversationID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	if conversationID != "" {
		if _, err = s.GetCloudConversation(ctx, userID, conversationID); err != nil {
			return nil, err
		}
	}
	args := []any{userID}
	query := "SELECT " + cloudResearchSourceMetadataColumns + " FROM zeroagent_cloud_research_sources s WHERE s.user_id=$1 AND s.deleted_at IS NULL"
	if conversationID != "" {
		args = append(args, conversationID)
		query += " AND s.conversation_id=$2"
	}
	if beforeID != "" {
		before, err := scanCloudResearchSource(s.db.QueryRowContext(ctx, "SELECT "+cloudResearchSourceMetadataColumns+" FROM zeroagent_cloud_research_sources s WHERE s.id=$1 AND s.user_id=$2", beforeID, userID))
		if err != nil {
			return nil, err
		}
		if conversationID != "" && before.ConversationID != conversationID {
			return nil, ErrNotFound
		}
		n := len(args) + 1
		args = append(args, before.CreatedAt, before.ID)
		query += " AND (s.created_at,s.id)<($" + cloudFileArg(n) + ",$" + cloudFileArg(n+1) + "::uuid)"
	}
	args = append(args, limit)
	query += " ORDER BY s.created_at DESC,s.id DESC LIMIT $" + cloudFileArg(len(args))
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := make([]CloudResearchSource, 0)
	for rows.Next() {
		source, err := scanCloudResearchSource(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *source)
	}
	return result, rows.Err()
}
func (s *PersistentStore) DeleteCloudResearchSource(ctx context.Context, userID int64, id string, version int64) error {
	id, err := canonicalCloudFileID(id)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	source, err := scanCloudResearchSource(tx.QueryRowContext(ctx, "SELECT "+cloudResearchSourceMetadataColumns+" FROM zeroagent_cloud_research_sources s WHERE s.id=$1 AND s.user_id=$2 FOR UPDATE", id, userID))
	if err != nil {
		return err
	}
	if source.DeletedAt != nil {
		return tx.Commit()
	}
	if version < 1 || source.Version != version {
		return ErrCloudResearchSourceConflict
	}
	_, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_research_sources SET body='',snippet='',text_bytes=0,line_count=0,version=version+1,deleted_at=clock_timestamp() WHERE id=$1 AND user_id=$2`, id, userID)
	if err != nil {
		return err
	}
	return tx.Commit()
}
func (s *PersistentStore) ReserveCloudResearchSearch(ctx context.Context, userID int64, runID, owner string, attempt int64, operationID string, limit int64) (bool, error) {
	if limit < 1 || limit > CloudResearchMaxDailySearches {
		return false, ErrCloudResearchSourceInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	run, op, err := s.researchOperationTx(ctx, tx, userID, runID, owner, attempt, operationID)
	if err != nil {
		return false, err
	}
	if op.Name != "web_search" {
		return false, ErrCloudResearchSourceInvalid
	}
	var existingUser int64
	var existingRun string
	err = tx.QueryRowContext(ctx, `SELECT user_id,run_id::text FROM zeroagent_cloud_research_search_reservations WHERE operation_id=$1`, op.ID).Scan(&existingUser, &existingRun)
	if err == nil {
		if existingUser != userID || existingRun != run.ID {
			return false, ErrCloudResearchSourceConflict
		}
		return false, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_research_searches:' || $1::text,0))`, userID); err != nil {
		return false, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return false, err
	}
	day := now.Format("2006-01-02")
	var count int64
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM zeroagent_cloud_research_search_reservations WHERE user_id=$1 AND reserved_day=$2`, userID, day).Scan(&count); err != nil {
		return false, err
	}
	if count >= limit {
		return false, ErrCloudResearchSourceQuota
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_research_search_reservations(operation_id,user_id,run_id,reserved_day,created_at) VALUES($1,$2,$3,$4,$5)`, op.ID, userID, run.ID, day, now)
	if err != nil {
		return false, err
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}

var _ CloudResearchSourceStore = (*PersistentStore)(nil)
