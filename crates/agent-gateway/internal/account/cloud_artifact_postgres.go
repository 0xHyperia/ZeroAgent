package account

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

const CloudArtifactSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_artifact_families (
 id UUID PRIMARY KEY,user_id BIGINT NOT NULL CHECK(user_id>0),conversation_id UUID NOT NULL,
 created_at TIMESTAMPTZ NOT NULL,deleted_at TIMESTAMPTZ NULL);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_artifact_versions (
 id UUID PRIMARY KEY,family_id UUID NOT NULL REFERENCES zeroagent_cloud_artifact_families(id),
 user_id BIGINT NOT NULL CHECK(user_id>0),conversation_id UUID NOT NULL,source_run_id UUID NOT NULL,
 tool_operation_id UUID NOT NULL UNIQUE,request_hash TEXT NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),
 number BIGINT NOT NULL CHECK(number>0),object_key TEXT NOT NULL UNIQUE,name TEXT NOT NULL,mime TEXT NOT NULL,
 size BIGINT NOT NULL CHECK(size BETWEEN 0 AND 33554432),sha256 TEXT NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),
 state TEXT NOT NULL CHECK(state IN('staging','ready','failed','unknown','deleting','deleted')),
 error_code TEXT NOT NULL DEFAULT '',version BIGINT NOT NULL DEFAULT 1,journal JSONB NULL,
 created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,deleted_at TIMESTAMPTZ NULL,
 UNIQUE(family_id,number),CHECK(deleted_at IS NULL OR state IN('deleting','deleted')));
CREATE INDEX IF NOT EXISTS zeroagent_cloud_artifact_owner_idx ON zeroagent_cloud_artifact_versions(user_id,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_artifact_conversation_page_idx ON zeroagent_cloud_artifact_versions(user_id,conversation_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS zeroagent_cloud_artifact_family_page_idx ON zeroagent_cloud_artifact_versions(user_id,family_id,created_at DESC,id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS zeroagent_cloud_artifact_cleanup_idx ON zeroagent_cloud_artifact_versions(updated_at,id) WHERE state<>'ready';`
const artifactColumns = `a.id::text,a.family_id::text,a.number,a.user_id,a.conversation_id::text,a.source_run_id::text,a.tool_operation_id::text,a.request_hash,a.object_key,a.name,a.mime,a.size,a.sha256,a.state,a.error_code,a.version,a.journal,a.created_at,a.updated_at,a.deleted_at`

var artifactMetadataColumns = strings.Replace(artifactColumns, "a.journal", "NULL", 1)

func scanCloudArtifact(row interface{ Scan(...any) error }) (*CloudArtifactVersion, error) {
	var a CloudArtifactVersion
	var deleted sql.NullTime
	var journal []byte
	err := row.Scan(&a.ID, &a.FamilyID, &a.Number, &a.UserID, &a.ConversationID, &a.SourceRunID, &a.ToolOperationID, &a.RequestHash, &a.ObjectKey, &a.Name, &a.MIME, &a.Size, &a.SHA256, &a.State, &a.ErrorCode, &a.Version, &journal, &a.CreatedAt, &a.UpdatedAt, &deleted)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	a.Journal = append(a.Journal, journal...)
	if deleted.Valid {
		a.DeletedAt = &deleted.Time
	}
	return &a, nil
}
func artifactTxRun(ctx context.Context, tx *sql.Tx, userID int64, runID, owner string, attempt int64) (*CloudRun, error) {
	run, err := scanCloudRun(tx.QueryRowContext(ctx, "SELECT "+cloudRunColumns+" FROM zeroagent_cloud_runs r WHERE r.user_id=$1 AND r.id=$2 FOR UPDATE", userID, runID))
	if err != nil {
		return nil, err
	}
	if run.State != CloudRunRunning {
		return nil, ErrCloudRunLeaseLost
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	if err = validateCloudRunLease(run, owner, attempt, now); err != nil {
		return nil, err
	}
	return run, nil
}
func (s *PersistentStore) ReserveCloudArtifact(ctx context.Context, userID int64, owner string, attempt int64, input *CloudArtifactVersion) (*CloudArtifactVersion, bool, error) {
	return s.reserveCloudArtifact(ctx, userID, owner, attempt, input, nil)
}
func (s *PersistentStore) reserveCloudArtifact(ctx context.Context, userID int64, owner string, attempt int64, input *CloudArtifactVersion, restore *cloudArtifactRestoreIntent) (*CloudArtifactVersion, bool, error) {
	a, err := prepareCloudArtifact(input, userID, time.Now())
	if err != nil {
		return nil, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	if err = lockSpaceWrite(ctx, tx, userID); err != nil {
		return nil, false, err
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_artifacts:'||$1::text,0))`, userID); err != nil {
		return nil, false, err
	}
	prior, err := scanCloudArtifact(tx.QueryRowContext(ctx, "SELECT "+artifactColumns+" FROM zeroagent_cloud_artifact_versions a WHERE a.tool_operation_id=$1 FOR UPDATE", a.ToolOperationID))
	if err == nil {
		if prior.UserID != userID || prior.RequestHash != a.RequestHash {
			return nil, false, ErrCloudArtifactConflict
		}
		return prior, false, tx.Commit()
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, false, err
	}
	limits, err := cloudSpaceQuotaTx(ctx, tx, userID, a.Size)
	if err != nil {
		if errors.Is(err, ErrCloudFileQuota) {
			err = ErrCloudArtifactQuota
		}
		return nil, false, err
	}
	if restore != nil {
		source, readErr := scanCloudArtifact(tx.QueryRowContext(ctx, "SELECT "+artifactColumns+" FROM zeroagent_cloud_artifact_versions a WHERE a.id=$1 AND a.user_id=$2 FOR UPDATE", restore.SourceID, userID))
		if readErr != nil {
			return nil, false, readErr
		}
		if source.FamilyID != a.FamilyID || source.State != CloudArtifactReady || source.DeletedAt != nil {
			return nil, false, ErrNotFound
		}
		var head string
		if err = tx.QueryRowContext(ctx, "SELECT id::text FROM zeroagent_cloud_artifact_versions WHERE family_id=$1 AND user_id=$2 AND deleted_at IS NULL ORDER BY number DESC LIMIT 1", a.FamilyID, userID).Scan(&head); err != nil {
			return nil, false, err
		}
		if head != restore.HeadID || head == restore.SourceID {
			return nil, false, ErrCloudArtifactConflict
		}
	} else {
		run, err := artifactTxRun(ctx, tx, userID, a.SourceRunID, owner, attempt)
		if err != nil {
			return nil, false, err
		}
		if run.ConversationID != a.ConversationID {
			return nil, false, ErrCloudArtifactInvalid
		}
	}
	var count int
	var used int64
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*),COALESCE(SUM(size),0) FROM zeroagent_cloud_artifact_versions WHERE user_id=$1 AND state<>'deleted'`, userID).Scan(&count, &used); err != nil {
		return nil, false, err
	}
	if count >= limits.MaxArtifactVersions || a.Size > limits.ArtifactBytes-used {
		return nil, false, ErrCloudArtifactQuota
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_artifact_families(id,user_id,conversation_id,created_at)VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING`, a.FamilyID, userID, a.ConversationID, a.CreatedAt); err != nil {
		return nil, false, err
	}
	var familyUser int64
	var familyConversation string
	var deleted sql.NullTime
	if err = tx.QueryRowContext(ctx, `SELECT user_id,conversation_id::text,deleted_at FROM zeroagent_cloud_artifact_families WHERE id=$1 FOR UPDATE`, a.FamilyID).Scan(&familyUser, &familyConversation, &deleted); err != nil {
		return nil, false, err
	}
	if familyUser != userID || deleted.Valid {
		return nil, false, ErrCloudArtifactConflict
	}
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(number),0)+1 FROM zeroagent_cloud_artifact_versions WHERE family_id=$1`, a.FamilyID).Scan(&a.Number); err != nil {
		return nil, false, err
	}
	if a.Number > CloudArtifactMaxFamilyVersions {
		return nil, false, ErrCloudArtifactQuota
	}
	var journal any
	if len(a.Journal) > 0 {
		journal = string(a.Journal)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_artifact_versions(id,family_id,number,user_id,conversation_id,source_run_id,tool_operation_id,request_hash,object_key,name,mime,size,sha256,state,version,journal,created_at,updated_at)VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15::jsonb,$16,$16)`, a.ID, a.FamilyID, a.Number, userID, a.ConversationID, a.SourceRunID, a.ToolOperationID, a.RequestHash, a.ObjectKey, a.Name, a.MIME, a.Size, a.SHA256, a.State, journal, a.CreatedAt)
	if err != nil {
		return nil, false, err
	}
	if err = tx.Commit(); err != nil {
		return nil, false, err
	}
	return a, true, nil
}
func (s *PersistentStore) GetCloudArtifactVersion(ctx context.Context, userID int64, id string) (*CloudArtifactVersion, error) {
	return scanCloudArtifact(s.db.QueryRowContext(ctx, "SELECT "+artifactColumns+" FROM zeroagent_cloud_artifact_versions a WHERE a.user_id=$1 AND a.id=$2", userID, id))
}
func (s *PersistentStore) GetCloudArtifactByOperation(ctx context.Context, userID int64, id string) (*CloudArtifactVersion, error) {
	return scanCloudArtifact(s.db.QueryRowContext(ctx, "SELECT "+artifactColumns+" FROM zeroagent_cloud_artifact_versions a WHERE a.user_id=$1 AND a.tool_operation_id=$2", userID, id))
}
func (s *PersistentStore) ListCloudArtifacts(ctx context.Context, userID int64, conversationID, familyID, before string, limit int) (*CloudArtifactPage, error) {
	conversationID, familyID, before, err := cloudArtifactListScope(userID, conversationID, familyID, before, limit)
	if err != nil {
		return nil, err
	}
	var createdAt any
	if before != "" {
		var anchorTime time.Time
		err = s.db.QueryRowContext(ctx, `SELECT created_at FROM zeroagent_cloud_artifact_versions WHERE user_id=$1 AND id=$2 AND ($3='' OR conversation_id::text=$3) AND ($4='' OR family_id::text=$4)`, userID, before, conversationID, familyID).Scan(&anchorTime)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		if err != nil {
			return nil, err
		}
		createdAt = anchorTime
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+artifactMetadataColumns+` FROM zeroagent_cloud_artifact_versions a WHERE a.user_id=$1 AND a.deleted_at IS NULL AND ($2<>'' OR $3<>'' OR NOT EXISTS(SELECT 1 FROM zeroagent_cloud_space_metadata m WHERE m.user_id=a.user_id AND m.kind='artifact' AND m.id=a.family_id AND m.trashed)) AND ($2='' OR a.conversation_id::text=$2) AND ($3='' OR a.family_id::text=$3) AND ($4::timestamptz IS NULL OR (a.created_at,a.id)<($4::timestamptz,NULLIF($5,'')::uuid)) ORDER BY a.created_at DESC,a.id DESC LIMIT $6`, userID, conversationID, familyID, createdAt, before, limit+1)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []CloudArtifactVersion{}
	for rows.Next() {
		item, err := scanCloudArtifact(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *item)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return cloudArtifactPage(result, limit), nil
}
func (s *PersistentStore) UpdateCloudArtifact(ctx context.Context, userID int64, id string, expected int64, owner string, attempt int64, update CloudArtifactUpdate) (*CloudArtifactVersion, error) {
	return s.updateCloudArtifactVersion(ctx, userID, id, expected, owner, attempt, update, false)
}
func (s *PersistentStore) updateCloudArtifactVersion(ctx context.Context, userID int64, id string, expected int64, owner string, attempt int64, update CloudArtifactUpdate, restoring bool) (*CloudArtifactVersion, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = lockSpaceWrite(ctx, tx, userID); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_artifacts:'||$1::text,0))`, userID); err != nil {
		return nil, err
	}
	a, err := scanCloudArtifact(tx.QueryRowContext(ctx, "SELECT "+artifactColumns+" FROM zeroagent_cloud_artifact_versions a WHERE a.user_id=$1 AND a.id=$2 FOR UPDATE", userID, id))
	if err != nil {
		return nil, err
	}
	if restoring && !isCloudArtifactRestore(*a) {
		return nil, ErrCloudArtifactConflict
	}
	if update.State == CloudArtifactReady {
		if restoring {
			if !validCloudArtifactRestore(*a, update) {
				return nil, ErrCloudArtifactConflict
			}
		} else {
			if _, err = artifactTxRun(ctx, tx, userID, a.SourceRunID, owner, attempt); err != nil {
				return nil, err
			}
		}
		var deleted sql.NullTime
		if err = tx.QueryRowContext(ctx, `SELECT deleted_at FROM zeroagent_cloud_artifact_families WHERE id=$1 FOR SHARE`, a.FamilyID).Scan(&deleted); err != nil {
			return nil, err
		}
		if deleted.Valid {
			return nil, ErrCloudArtifactConflict
		}
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return nil, err
	}
	a, err = updateCloudArtifact(*a, expected, update, now)
	if err != nil {
		return nil, err
	}
	var journal any
	if len(a.Journal) > 0 {
		journal = string(a.Journal)
	}
	_, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_artifact_versions SET state=$3,error_code=$4,version=$5,journal=$6::jsonb,updated_at=$7,deleted_at=$8 WHERE id=$1 AND user_id=$2`, id, userID, a.State, a.ErrorCode, a.Version, journal, a.UpdatedAt, a.DeletedAt)
	if err != nil {
		return nil, err
	}
	return a, tx.Commit()
}
func (s *PersistentStore) DeleteCloudArtifactFamily(ctx context.Context, userID int64, id string) ([]CloudArtifactVersion, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = lockSpaceWrite(ctx, tx, userID); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_artifacts:'||$1::text,0))`, userID); err != nil {
		return nil, err
	}
	var owner int64
	if err = tx.QueryRowContext(ctx, `SELECT user_id FROM zeroagent_cloud_artifact_families WHERE id=$1 FOR UPDATE`, id).Scan(&owner); errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	} else if err != nil {
		return nil, err
	}
	if owner != userID {
		return nil, ErrNotFound
	}
	_, err = tx.ExecContext(ctx, `UPDATE zeroagent_cloud_artifact_families SET deleted_at=COALESCE(deleted_at,clock_timestamp()) WHERE id=$1`, id)
	if err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, `UPDATE zeroagent_cloud_artifact_versions a SET state='deleting',deleted_at=COALESCE(deleted_at,clock_timestamp()),error_code=CASE WHEN COALESCE((journal->>'put_started')::boolean,false) AND NOT COALESCE((journal->>'object_verified')::boolean,false) THEN 'late_write_unknown' ELSE error_code END,version=version+1,updated_at=clock_timestamp() WHERE family_id=$1 AND state<>'deleted' RETURNING `+artifactColumns, id)
	if err != nil {
		return nil, err
	}
	result := []CloudArtifactVersion{}
	for rows.Next() {
		a, scanErr := scanCloudArtifact(rows)
		if scanErr != nil {
			rows.Close()
			return nil, scanErr
		}
		result = append(result, *a)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	return result, tx.Commit()
}
func (s *PersistentStore) ListCloudArtifactCleanup(ctx context.Context, limit int) ([]CloudArtifactVersion, error) {
	if limit < 1 || limit > 100 {
		return nil, ErrCloudArtifactInvalid
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+artifactColumns+` FROM zeroagent_cloud_artifact_versions a WHERE a.state='deleting' OR(a.state NOT IN('ready','deleted') AND a.updated_at<clock_timestamp()-INTERVAL '15 minutes') ORDER BY a.updated_at,a.id LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []CloudArtifactVersion{}
	for rows.Next() {
		a, err := scanCloudArtifact(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *a)
	}
	return result, rows.Err()
}

func (s *PersistentStore) ReserveCloudArtifactRestore(ctx context.Context, userID int64, sourceID, headID, requestID string) (*CloudArtifactVersion, bool, error) {
	input, intent, err := prepareCloudArtifactRestore(ctx, s, userID, sourceID, headID, requestID)
	if err != nil {
		return nil, false, err
	}
	return s.reserveCloudArtifact(ctx, userID, "", 0, input, intent)
}
func (s *PersistentStore) UpdateCloudArtifactRestore(ctx context.Context, userID int64, id string, expected int64, update CloudArtifactUpdate) (*CloudArtifactVersion, error) {
	return s.updateCloudArtifactVersion(ctx, userID, id, expected, "", 0, update, true)
}
