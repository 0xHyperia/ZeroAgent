package account

import (
	"context"
	"database/sql"
	"errors"
	"strconv"
	"time"
)

type cloudDraftQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readCloudPrivateDraft(ctx context.Context, q cloudDraftQueryer, uid int64, scope string) (*CloudPrivateDraftSnapshot, error) {
	result := &CloudPrivateDraftSnapshot{Scope: scope}
	var version int64
	var updated sql.NullTime
	var data []byte
	err := q.QueryRowContext(ctx, `SELECT COALESCE(d.version,0),d.draft,d.updated_at,COALESCE(d.last_operation_id::text,'') FROM (SELECT $1::bigint AS user_id) owner LEFT JOIN zeroagent_cloud_draft_accounts a ON a.user_id=owner.user_id LEFT JOIN zeroagent_cloud_private_drafts d ON d.user_id=owner.user_id AND d.scope=$2`, uid, scope).Scan(&version, &data, &updated, &result.LastOperationID)
	if err != nil {
		return nil, err
	}
	result.Version = strconv.FormatInt(version, 10)
	result.Draft = data
	if updated.Valid {
		result.UpdatedAt = &updated.Time
	}
	return result, nil
}

func privateDraftPostgresOwner(ctx context.Context, q cloudDraftQueryer, uid int64, scope string, lock bool) error {
	if scope == "blank" {
		return nil
	}
	suffix := ""
	if lock {
		suffix = " FOR KEY SHARE"
	}
	var id string
	err := q.QueryRowContext(ctx, `SELECT id::text FROM zerobox_cloud_conversations WHERE user_id=$1 AND id=$2`+suffix, uid, scope).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	return err
}

func (s *PersistentStore) GetCloudPrivateDraft(ctx context.Context, uid int64, scope string) (*CloudPrivateDraftSnapshot, error) {
	scope, err := cloudPrivateDraftScope(uid, scope)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err = privateDraftPostgresOwner(ctx, s.db, uid, scope, false); err != nil {
		return nil, err
	}
	return readCloudPrivateDraft(ctx, s.db, uid, scope)
}

func (s *PersistentStore) WriteCloudPrivateDraft(ctx context.Context, uid int64, scope string, input CloudPrivateDraftInput, remove bool) (*CloudPrivateDraftSnapshot, error) {
	scope, input, expected, hash, err := prepareCloudPrivateDraft(uid, scope, input, remove)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_draft_accounts(user_id) VALUES($1) ON CONFLICT DO NOTHING`, uid); err != nil {
		return nil, err
	}
	var revision int64
	if err = tx.QueryRowContext(ctx, `SELECT version FROM zeroagent_cloud_draft_accounts WHERE user_id=$1 FOR UPDATE`, uid).Scan(&revision); err != nil {
		return nil, err
	}
	if err = privateDraftPostgresOwner(ctx, tx, uid, scope, true); err != nil {
		return nil, err
	}
	var oldHash string
	var applied int64
	err = tx.QueryRowContext(ctx, `SELECT request_hash,result_version FROM zeroagent_cloud_draft_operations WHERE user_id=$1 AND client_operation_id=$2`, uid, input.ClientOperationID).Scan(&oldHash, &applied)
	if err == nil {
		if oldHash != hash {
			return nil, ErrCloudDraftOperationConflict
		}
		result, err := readCloudPrivateDraft(ctx, tx, uid, scope)
		if err != nil {
			return nil, err
		}
		result.AppliedVersion = strconv.FormatInt(applied, 10)
		result.Replayed = true
		if err = tx.Commit(); err != nil {
			return nil, err
		}
		return result, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	current := int64(0)
	err = tx.QueryRowContext(ctx, `SELECT version FROM zeroagent_cloud_private_drafts WHERE user_id=$1 AND scope=$2`, uid, scope).Scan(&current)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if current != expected {
		return nil, ErrCloudDraftChanged
	}
	if !remove {
		var count, total int64
		if err = tx.QueryRowContext(ctx, `SELECT count(*),COALESCE(sum(size_bytes),0) FROM zeroagent_cloud_private_drafts WHERE user_id=$1 AND scope<>$2 AND draft IS NOT NULL`, uid, scope).Scan(&count, &total); err != nil {
			return nil, err
		}
		if count+1 > CloudPrivateDraftMaxCount || total+int64(len(input.Draft)) > CloudPrivateDraftAccountBytes {
			return nil, ErrCloudDraftLimit
		}
	}
	if revision == int64(^uint64(0)>>1) {
		return nil, ErrCloudDraftLimit
	}
	revision++
	if _, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_draft_accounts SET version=$2 WHERE user_id=$1`, uid, revision); err != nil {
		return nil, err
	}
	var cid any
	if scope != "blank" {
		cid = scope
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_private_drafts(user_id,scope,conversation_id,version,draft,size_bytes,last_operation_id,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()) ON CONFLICT(user_id,scope) DO UPDATE SET version=EXCLUDED.version,draft=EXCLUDED.draft,size_bytes=EXCLUDED.size_bytes,last_operation_id=EXCLUDED.last_operation_id,updated_at=EXCLUDED.updated_at`, uid, scope, cid, revision, nullableJSON(input.Draft), len(input.Draft), input.ClientOperationID); err != nil {
		return nil, err
	}

	if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_draft_operations(user_id,client_operation_id,request_hash,result_version) VALUES($1,$2,$3,$4)`, uid, input.ClientOperationID, hash, revision); err != nil {
		return nil, err
	}
	result, err := readCloudPrivateDraft(ctx, tx, uid, scope)
	if err != nil {
		return nil, err
	}
	result.AppliedVersion = strconv.FormatInt(revision, 10)
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}
