package account

import (
	"context"
	"database/sql"
	"errors"

	"github.com/google/uuid"
)

const CloudMemorySchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_memories (
 id UUID PRIMARY KEY,user_id BIGINT NOT NULL CHECK(user_id>0),
 content TEXT NOT NULL CHECK(octet_length(content) BETWEEN 1 AND 4096),enabled BOOLEAN NOT NULL DEFAULT TRUE,
 version BIGINT NOT NULL DEFAULT 1 CHECK(version>0),created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_memories_owner_idx ON zeroagent_cloud_memories(user_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_memory_settings (
 user_id BIGINT PRIMARY KEY CHECK(user_id>0),enabled BOOLEAN NOT NULL DEFAULT FALSE,
 version BIGINT NOT NULL DEFAULT 1 CHECK(version>0),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`

const cloudMemoryColumns = `m.id::text,m.user_id,m.content,m.enabled,m.version,m.created_at,m.updated_at`

func scanCloudMemory(row interface{ Scan(...any) error }) (*CloudMemory, error) {
	var memory CloudMemory
	err := row.Scan(&memory.ID, &memory.UserID, &memory.Content, &memory.Enabled, &memory.Version, &memory.CreatedAt, &memory.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &memory, nil
}

func (s *PersistentStore) CreateCloudMemory(ctx context.Context, input *CloudMemory) (*CloudMemory, error) {
	if input == nil || input.UserID <= 0 || !cloudProjectText(input.Content, CloudMemoryMaxContent, true) {
		return nil, ErrCloudProjectInvalid
	}
	memory := *input
	var err error
	if memory.ID == "" {
		memory.ID = uuid.NewString()
	} else if memory.ID, err = cloudProjectID(memory.ID); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_cloud_memories:'||$1::text,0))`, memory.UserID); err != nil {
		return nil, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM zeroagent_cloud_memories WHERE user_id=$1`, memory.UserID).Scan(&count); err != nil {
		return nil, err
	}
	if count >= CloudMemoryMaxEntries {
		return nil, ErrCloudProjectQuota
	}
	result, err := scanCloudMemory(tx.QueryRowContext(ctx, `INSERT INTO zeroagent_cloud_memories AS m(id,user_id,content,enabled) VALUES($1,$2,$3,$4) RETURNING `+cloudMemoryColumns, memory.ID, memory.UserID, memory.Content, memory.Enabled))
	if err != nil {
		return nil, cloudProjectSQLError(err)
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return result, nil
}

func (s *PersistentStore) GetCloudMemory(ctx context.Context, userID int64, id string) (*CloudMemory, error) {
	id, err := cloudProjectID(id)
	if err != nil {
		return nil, err
	}
	return scanCloudMemory(s.db.QueryRowContext(ctx, `SELECT `+cloudMemoryColumns+` FROM zeroagent_cloud_memories m WHERE m.id=$1 AND m.user_id=$2`, id, userID))
}

func (s *PersistentStore) ListCloudMemories(ctx context.Context, userID int64, before string, limit int) ([]CloudMemory, error) {
	before, err := cloudProjectListInput(userID, before, limit)
	if err != nil {
		return nil, err
	}
	var at any
	id := uuid.Nil.String()
	if before != "" {
		memory, err := s.GetCloudMemory(ctx, userID, before)
		if err != nil {
			return nil, err
		}
		at, id = memory.CreatedAt, memory.ID
	}
	rows, err := s.db.QueryContext(ctx, `SELECT `+cloudMemoryColumns+` FROM zeroagent_cloud_memories m WHERE m.user_id=$1 AND ($2::timestamptz IS NULL OR (m.created_at,m.id)<($2,$3::uuid)) ORDER BY m.created_at DESC,m.id DESC LIMIT $4`, userID, at, id, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := []CloudMemory{}
	for rows.Next() {
		memory, err := scanCloudMemory(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *memory)
	}
	return items, rows.Err()
}

func (s *PersistentStore) UpdateCloudMemory(ctx context.Context, userID int64, id string, version int64, content string, enabled bool) (*CloudMemory, error) {
	id, err := cloudProjectID(id)
	if err != nil {
		return nil, err
	}
	if !cloudProjectText(content, CloudMemoryMaxContent, true) {
		return nil, ErrCloudProjectInvalid
	}
	result, err := scanCloudMemory(s.db.QueryRowContext(ctx, `UPDATE zeroagent_cloud_memories m SET content=$4,enabled=$5,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 AND version=$3 RETURNING `+cloudMemoryColumns, id, userID, version, content, enabled))
	if errors.Is(err, ErrNotFound) {
		if _, getErr := s.GetCloudMemory(ctx, userID, id); getErr != nil {
			return nil, getErr
		}
		return nil, ErrCloudProjectConflict
	}
	return result, err
}

func (s *PersistentStore) DeleteCloudMemory(ctx context.Context, userID int64, id string, version int64) error {
	id, err := cloudProjectID(id)
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `DELETE FROM zeroagent_cloud_memories WHERE id=$1 AND user_id=$2 AND version=$3`, id, userID, version)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		if _, err := s.GetCloudMemory(ctx, userID, id); err != nil {
			return err
		}
		return ErrCloudProjectConflict
	}
	return nil
}

func (s *PersistentStore) GetCloudMemorySettings(ctx context.Context, userID int64) (*CloudMemorySettings, error) {
	if userID <= 0 {
		return nil, ErrCloudProjectInvalid
	}
	var settings CloudMemorySettings
	err := s.db.QueryRowContext(ctx, `SELECT enabled,version,updated_at FROM zeroagent_cloud_memory_settings WHERE user_id=$1`, userID).Scan(&settings.Enabled, &settings.Version, &settings.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return &CloudMemorySettings{}, nil
	}
	if err != nil {
		return nil, err
	}
	return &settings, nil
}

func (s *PersistentStore) SetCloudMemorySettings(ctx context.Context, userID, version int64, enabled bool) (*CloudMemorySettings, error) {
	if userID <= 0 {
		return nil, ErrCloudProjectInvalid
	}
	if version < 0 {
		return nil, ErrCloudProjectConflict
	}
	var settings CloudMemorySettings
	var err error
	if version == 0 {
		err = s.db.QueryRowContext(ctx, `INSERT INTO zeroagent_cloud_memory_settings(user_id,enabled) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING enabled,version,updated_at`, userID, enabled).Scan(&settings.Enabled, &settings.Version, &settings.UpdatedAt)
	} else {
		err = s.db.QueryRowContext(ctx, `UPDATE zeroagent_cloud_memory_settings SET enabled=$3,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND version=$2 RETURNING enabled,version,updated_at`, userID, version, enabled).Scan(&settings.Enabled, &settings.Version, &settings.UpdatedAt)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrCloudProjectConflict
	}
	if err != nil {
		return nil, err
	}
	return &settings, nil
}

func (s *PersistentStore) GetCloudMemoryContext(ctx context.Context, userID int64, maxBytes int) (*CloudMemoryContext, error) {
	if userID <= 0 || maxBytes < 1 || maxBytes > CloudMemoryMaxContext {
		return nil, ErrCloudProjectInvalid
	}
	// One repeatable-read snapshot keeps a concurrent disable/delete atomic with
	// this context read, while every later request observes the new state.
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var enabled bool
	err = tx.QueryRowContext(ctx, `SELECT enabled FROM zeroagent_cloud_memory_settings WHERE user_id=$1`, userID).Scan(&enabled)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if !enabled {
		return boundedCloudMemoryContext(false, nil, maxBytes), nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT `+cloudMemoryColumns+` FROM zeroagent_cloud_memories m WHERE m.user_id=$1 AND m.enabled ORDER BY m.created_at DESC,m.id DESC LIMIT $2`, userID, CloudMemoryMaxEntries)
	if err != nil {
		return nil, err
	}
	items := []CloudMemory{}
	for rows.Next() {
		memory, err := scanCloudMemory(rows)
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		items = append(items, *memory)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return boundedCloudMemoryContext(true, items, maxBytes), nil
}
