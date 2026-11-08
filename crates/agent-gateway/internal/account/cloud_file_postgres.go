package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/lib/pq"
)

// No conversation FK: deleting a conversation retains originals in the owner's
// file library. Tombstones and failed remote deletions are deliberately retained.
const CloudFileSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_files (
 id UUID PRIMARY KEY,
 user_id BIGINT NOT NULL CHECK (user_id > 0),
 conversation_id UUID NULL,
 object_key TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL CHECK (octet_length(name) BETWEEN 1 AND 255),
 mime TEXT NOT NULL,
 size BIGINT NOT NULL CHECK (size BETWEEN 0 AND 33554432),
 sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
 state TEXT NOT NULL CHECK (state IN ('uploading','uploaded','processing','ready','vision_ready','failed','deleting','deleted')),
 processing_stage TEXT NOT NULL DEFAULT '',
 extracted_text TEXT NOT NULL DEFAULT '' CHECK (octet_length(extracted_text) <= 2097152),
 parser_task JSONB NULL,
 parsed_segments JSONB NOT NULL DEFAULT '[]'::jsonb,
 parse_truncated BOOLEAN NOT NULL DEFAULT false,
 error_code TEXT NOT NULL DEFAULT '',
 version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 uploaded_at TIMESTAMPTZ NULL,
 deleted_at TIMESTAMPTZ NULL,
 CONSTRAINT zeroagent_cloud_files_tombstone CHECK (deleted_at IS NULL OR state IN ('deleting','deleted'))
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_files_library_idx
 ON zeroagent_cloud_files(user_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS zeroagent_cloud_files_conversation_idx
 ON zeroagent_cloud_files(user_id,conversation_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS zeroagent_cloud_files_cleanup_idx
 ON zeroagent_cloud_files(updated_at,id) WHERE state='deleting';`

const cloudFileColumns = `f.id::text,f.user_id,COALESCE(f.conversation_id::text,''),f.object_key,f.name,f.mime,f.size,f.sha256,
 f.state,f.processing_stage,f.extracted_text,f.error_code,f.version,f.created_at,f.updated_at,f.uploaded_at,f.deleted_at,octet_length(f.extracted_text),f.parser_task,f.parsed_segments,f.parse_truncated`

// File-library pages need the text byte count, never all extracted bodies.
var cloudFileMetadataColumns = strings.NewReplacer("f.parser_task", "NULL", "f.parsed_segments", "'[]'::jsonb").Replace(strings.Replace(cloudFileColumns, "f.extracted_text", "''", 1))

var cloudFileParserCandidateColumns = strings.NewReplacer("f.parser_task", `CASE WHEN jsonb_typeof(f.parser_task)='object' THEN jsonb_build_object('id',f.parser_task->'id','state',f.parser_task->'state','vm_stopped',f.parser_task->'vm_stopped','lease_owner',f.parser_task->'lease_owner','lease_until',f.parser_task->'lease_until') ELSE NULL END`, "f.parsed_segments", "'[]'::jsonb").Replace(strings.Replace(cloudFileColumns, "f.extracted_text", "''", 1))

func scanCloudFile(row interface{ Scan(...any) error }) (*CloudFile, error) {
	var file CloudFile
	var uploaded, deleted sql.NullTime
	var taskData, segmentData []byte
	err := row.Scan(&file.ID, &file.UserID, &file.ConversationID, &file.ObjectKey, &file.Name, &file.MIME, &file.Size, &file.SHA256,
		&file.State, &file.ProcessingStage, &file.Text, &file.ErrorCode, &file.Version, &file.CreatedAt, &file.UpdatedAt, &uploaded, &deleted, &file.TextBytes, &taskData, &segmentData, &file.ParseTruncated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if len(taskData) > 0 && string(taskData) != "null" {
		if err = json.Unmarshal(taskData, &file.ParseTask); err != nil {
			return nil, err
		}
	}
	if len(segmentData) > 0 {
		if err = json.Unmarshal(segmentData, &file.Segments); err != nil {
			return nil, err
		}
	}
	if uploaded.Valid {
		file.UploadedAt = &uploaded.Time
	}
	if deleted.Valid {
		file.DeletedAt = &deleted.Time
	}
	return &file, nil
}

func (s *PersistentStore) CreateCloudFile(ctx context.Context, input *CloudFile) (*CloudFile, error) {
	file, err := prepareCloudFile(input, time.Now())
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = lockSpaceWrite(ctx, tx, file.UserID); err != nil {
		return nil, err
	}
	limits, err := cloudSpaceQuotaTx(ctx, tx, file.UserID, file.Size)
	if err != nil {
		return nil, err
	}
	// Account-scoped quota serialization works across Gateway processes. Failed
	// and deleting originals consume quota until remote deletion is confirmed.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_cloud_files:' || $1::text,0))`, file.UserID); err != nil {
		return nil, err
	}
	var count int
	var usedBytes int64
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(size),0) FROM zeroagent_cloud_files WHERE user_id=$1 AND state<>'deleted'`, file.UserID).Scan(&count, &usedBytes); err != nil {
		return nil, err
	}
	if count >= limits.MaxFiles || file.Size > limits.FileBytes-usedBytes {
		return nil, ErrCloudFileQuota
	}
	var conversationID string
	if file.ConversationID != "" {
		err = tx.QueryRowContext(ctx, `SELECT id::text FROM zerobox_cloud_conversations WHERE id=$1 AND user_id=$2 FOR KEY SHARE`, file.ConversationID, file.UserID).Scan(&conversationID)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	file.CreatedAt, file.UpdatedAt = now, now
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_files
 (id,user_id,conversation_id,object_key,name,mime,size,sha256,state,processing_stage,version,created_at,updated_at)
 VALUES($1,$2,NULLIF($3,'')::uuid,$4,$5,$6,$7,$8,$9,$10,1,$11,$11)`, file.ID, file.UserID, file.ConversationID, file.ObjectKey, file.Name, file.MIME, file.Size, file.SHA256, file.State, file.ProcessingStage, now)
	if err != nil {
		var pg *pq.Error
		if errors.As(err, &pg) && pg.Code == "23505" {
			return nil, ErrCloudFileConflict
		}
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return file, nil
}

func (s *PersistentStore) GetCloudFile(ctx context.Context, userID int64, id string) (*CloudFile, error) {
	id, err := canonicalCloudFileID(id)
	if err != nil {
		return nil, err
	}
	return scanCloudFile(s.db.QueryRowContext(ctx, "SELECT "+cloudFileColumns+" FROM zeroagent_cloud_files f WHERE f.id=$1 AND f.user_id=$2", id, userID))
}

func (s *PersistentStore) ListCloudFiles(ctx context.Context, userID int64, conversationID, beforeID string, limit int) ([]CloudFile, error) {
	conversationID, beforeID, err := validateCloudFileList(conversationID, beforeID, limit)
	if err != nil {
		return nil, err
	}
	if conversationID != "" {
		if _, err = s.GetCloudConversation(ctx, userID, conversationID); err != nil {
			return nil, err
		}
	}
	var beforeCreated time.Time
	if beforeID != "" {
		before, getErr := s.GetCloudFile(ctx, userID, beforeID)
		if getErr != nil {
			return nil, getErr
		}
		if conversationID != "" && before.ConversationID != conversationID {
			return nil, ErrNotFound
		}
		beforeCreated = before.CreatedAt
	}
	query := "SELECT " + cloudFileMetadataColumns + " FROM zeroagent_cloud_files f WHERE f.user_id=$1 AND f.deleted_at IS NULL"
	if conversationID == "" {
		query += " AND NOT EXISTS (SELECT 1 FROM zeroagent_cloud_space_metadata m WHERE m.user_id=f.user_id AND m.kind='file' AND m.id=f.id AND m.trashed)"
	}
	args := []any{userID}
	if conversationID != "" {
		args = append(args, conversationID)
		query += " AND f.conversation_id=$2"
	}
	if beforeID != "" {
		n := len(args) + 1
		args = append(args, beforeCreated, beforeID)
		query += " AND (f.created_at,f.id)<($" + cloudFileArg(n) + ",$" + cloudFileArg(n+1) + "::uuid)"
	}
	args = append(args, limit)
	query += " ORDER BY f.created_at DESC,f.id DESC LIMIT $" + cloudFileArg(len(args))
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	files := make([]CloudFile, 0)
	for rows.Next() {
		file, scanErr := scanCloudFile(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		files = append(files, *file)
	}
	return files, rows.Err()
}

func cloudFileArg(n int) string { return strconv.Itoa(n) }

func (s *PersistentStore) UpdateCloudFile(ctx context.Context, userID int64, id string, version int64, update CloudFileUpdate) (*CloudFile, error) {
	id, err := canonicalCloudFileID(id)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = lockSpaceWrite(ctx, tx, userID); err != nil {
		return nil, err
	}
	file, err := scanCloudFile(tx.QueryRowContext(ctx, "SELECT "+cloudFileColumns+" FROM zeroagent_cloud_files f WHERE f.id=$1 AND f.user_id=$2 FOR UPDATE", id, userID))
	if err != nil {
		return nil, err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	file, err = updateCloudFile(*file, version, update, now)
	if err != nil {
		return nil, err
	}
	taskData, _ := json.Marshal(file.ParseTask)
	var taskValue any
	if file.ParseTask != nil {
		taskValue = string(taskData)
	}
	segmentData, _ := json.Marshal(file.Segments)
	if file.Segments == nil {
		segmentData = []byte("[]")
	}
	_, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_files SET state=$3,processing_stage=$4,extracted_text=$5,error_code=$6,
 version=$7,updated_at=$8,uploaded_at=$9,deleted_at=$10,parser_task=$11::jsonb,parsed_segments=$12::jsonb,parse_truncated=$13 WHERE id=$1 AND user_id=$2`, id, userID, file.State, file.ProcessingStage, file.Text, file.ErrorCode, file.Version, file.UpdatedAt, file.UploadedAt, file.DeletedAt, taskValue, string(segmentData), file.ParseTruncated)
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return file, nil
}

func (s *PersistentStore) ListCloudFileCleanup(ctx context.Context, limit int) ([]CloudFile, error) {
	if limit < 1 || limit > 100 {
		return nil, ErrCloudFileInvalid
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+cloudFileColumns+" FROM zeroagent_cloud_files f WHERE f.state='deleting' OR (f.state IN ('uploading','processing') AND f.updated_at<clock_timestamp()-INTERVAL '15 minutes') ORDER BY f.updated_at,f.id LIMIT $1", limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	files := make([]CloudFile, 0)
	for rows.Next() {
		file, scanErr := scanCloudFile(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		files = append(files, *file)
	}
	return files, rows.Err()
}

var _ CloudFileStore = (*PersistentStore)(nil)

func (s *PersistentStore) ListCloudFileParserCandidates(ctx context.Context, limit int) ([]CloudFile, error) {
	if limit < 1 || limit > 100 {
		return nil, ErrCloudFileInvalid
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+cloudFileParserCandidateColumns+` FROM zeroagent_cloud_files f WHERE
 (f.deleted_at IS NULL AND f.state='uploaded' AND f.parser_task IS NULL AND lower(f.name) ~ '[.](pdf|docx|xlsx|pptx)$')
 OR (jsonb_typeof(f.parser_task)='object' AND COALESCE((f.parser_task->>'vm_stopped')::boolean,false)=false)
 ORDER BY f.updated_at,f.id LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []CloudFile{}
	for rows.Next() {
		file, scanErr := scanCloudFile(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		if cloudFileNeedsParser(*file) {
			result = append(result, *file)
		}
	}
	return result, rows.Err()
}
