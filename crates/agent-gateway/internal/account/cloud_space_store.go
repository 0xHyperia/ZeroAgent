package account

import (
	"context"
	"database/sql"
	"time"
)

const CloudSpaceSchema = CloudSiteSchema + `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_space_metadata (
 user_id BIGINT NOT NULL CHECK(user_id>0), kind TEXT NOT NULL CHECK(kind IN('file','artifact','folder')),
 id UUID NOT NULL, name TEXT NOT NULL DEFAULT '' CHECK(octet_length(name)<=255),folder_id UUID NULL,
 starred BOOLEAN NOT NULL DEFAULT false,trashed BOOLEAN NOT NULL DEFAULT false,
 version BIGINT NOT NULL CHECK(version>0),created_at TIMESTAMPTZ NOT NULL,updated_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(user_id,kind,id));
CREATE INDEX IF NOT EXISTS zeroagent_cloud_space_folder_idx ON zeroagent_cloud_space_metadata(user_id,folder_id);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_space_limits (
 user_id BIGINT PRIMARY KEY CHECK(user_id>0),limit_bytes BIGINT NOT NULL CHECK(limit_bytes>0),
 file_limit_bytes BIGINT NOT NULL CHECK(file_limit_bytes>0 AND file_limit_bytes<=1125899906842624),
 artifact_limit_bytes BIGINT NOT NULL CHECK(artifact_limit_bytes>0 AND artifact_limit_bytes<=1125899906842624),
 max_files INTEGER NOT NULL CHECK(max_files BETWEEN 1 AND 1000000),
 max_artifact_versions INTEGER NOT NULL CHECK(max_artifact_versions BETWEEN 1 AND 1000000));` + cloudSpacePagingSchema

func (s *MemoryStore) spaceRecordsLocked(userID int64) cloudSpaceRecords {
	r := cloudSpaceRecords{limits: s.spaceLimitsLocked(userID), sites: map[string]CloudSiteRelease{}}
	if s.cloudSites != nil {
		for id, site := range s.cloudSites.releases {
			if site.UserID == userID {
				r.sites[id] = CloudSiteRelease{ID: id, SiteID: site.SiteID, SHA256: site.SHA256}
			}
		}
	}
	for _, f := range s.cloudFiles {
		if f.UserID == userID {
			copy := f
			copy.Text = ""
			copy.ParseTask = nil
			copy.Segments = nil
			r.files = append(r.files, copy)
		}
	}
	if s.cloudArtifacts != nil {
		for _, a := range s.cloudArtifacts.versions {
			if a.UserID == userID {
				copy := a
				copy.Journal = nil
				r.artifacts = append(r.artifacts, copy)
			}
		}
	}
	for _, m := range s.cloudSpace[userID] {
		r.metadata = append(r.metadata, m)
	}
	return r
}
func (s *MemoryStore) ReadCloudSpace(ctx context.Context, userID int64) (*CloudSpaceSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if userID <= 0 {
		return nil, ErrCloudFileInvalid
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.spaceRecordsLocked(userID).snapshot(), nil
}
func (s *MemoryStore) PutCloudSpaceMetadata(ctx context.Context, userID int64, m CloudSpaceMetadata) (*CloudSpaceMetadata, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if userID <= 0 {
		return nil, ErrCloudFileInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	snapshot := s.spaceRecordsLocked(userID).snapshot()
	if err := validateSpaceMutation(snapshot, m); err != nil {
		return nil, err
	}
	if s.cloudSpace == nil {
		s.cloudSpace = map[int64]map[string]CloudSpaceMetadata{}
	}
	if s.cloudSpace[userID] == nil {
		s.cloudSpace[userID] = map[string]CloudSpaceMetadata{}
	}
	key := m.Kind + ":" + m.ID
	previous := s.cloudSpace[userID][key]
	m.Version++
	m.CreatedAt = previous.CreatedAt
	if m.CreatedAt.IsZero() {
		m.CreatedAt = s.now().UTC()
	}
	m.UpdatedAt = s.now().UTC()
	s.cloudSpace[userID][key] = m
	return &m, nil
}

// Both metadata and usage are read from one database snapshot. Counts include
// pending/failed/deleting objects until the object cleanup confirms deletion.
func readCloudSpaceTx(ctx context.Context, tx *sql.Tx, userID int64) (*CloudSpaceSnapshot, error) {
	r := cloudSpaceRecords{sites: map[string]CloudSiteRelease{}}
	siteRows, err := tx.QueryContext(ctx, `SELECT id::text,site_id::text,sha256 FROM zeroagent_cloud_site_releases WHERE user_id=$1`, userID)
	if err != nil {
		return nil, err
	}
	for siteRows.Next() {
		var site CloudSiteRelease
		if err = siteRows.Scan(&site.ID, &site.SiteID, &site.SHA256); err != nil {
			_ = siteRows.Close()
			return nil, err
		}
		r.sites[site.ID] = site
	}
	err = siteRows.Err()
	_ = siteRows.Close()
	if err != nil {
		return nil, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT "+cloudFileMetadataColumns+" FROM zeroagent_cloud_files f WHERE f.user_id=$1 AND f.state<>'deleted'", userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		f, e := scanCloudFile(rows)
		if e != nil {
			_ = rows.Close()
			return nil, e
		}
		r.files = append(r.files, *f)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT "+artifactMetadataColumns+" FROM zeroagent_cloud_artifact_versions a WHERE a.user_id=$1 AND a.state<>'deleted'", userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		a, e := scanCloudArtifact(rows)
		if e != nil {
			_ = rows.Close()
			return nil, e
		}
		r.artifacts = append(r.artifacts, *a)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	rows, err = tx.QueryContext(ctx, `SELECT m.id::text,m.kind,m.name,COALESCE(m.folder_id::text,''),m.starred,m.trashed,m.version,m.created_at,m.updated_at FROM zeroagent_cloud_space_metadata m WHERE m.user_id=$1 AND (m.kind='folder' OR (m.kind='file' AND EXISTS(SELECT 1 FROM zeroagent_cloud_files f WHERE f.user_id=m.user_id AND f.id=m.id AND f.state<>'deleted')) OR (m.kind='artifact' AND EXISTS(SELECT 1 FROM zeroagent_cloud_artifact_versions a WHERE a.user_id=m.user_id AND a.family_id=m.id AND a.state<>'deleted')))`, userID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var m CloudSpaceMetadata
		if err = rows.Scan(&m.ID, &m.Kind, &m.Name, &m.FolderID, &m.Starred, &m.Trashed, &m.Version, &m.CreatedAt, &m.UpdatedAt); err != nil {
			_ = rows.Close()
			return nil, err
		}
		r.metadata = append(r.metadata, m)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return nil, err
	}
	if r.limits, err = readSpaceLimitsTx(ctx, tx, userID); err != nil {
		return nil, err
	}
	return r.snapshot(), nil
}
func (s *PersistentStore) ReadCloudSpace(ctx context.Context, userID int64) (*CloudSpaceSnapshot, error) {
	if userID <= 0 {
		return nil, ErrCloudFileInvalid
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	snapshot, err := readCloudSpaceTx(ctx, tx, userID)
	if err != nil {
		return nil, err
	}
	return snapshot, tx.Commit()
}
func (s *PersistentStore) PutCloudSpaceMetadata(ctx context.Context, userID int64, m CloudSpaceMetadata) (*CloudSpaceMetadata, error) {
	if userID <= 0 {
		return nil, ErrCloudFileInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if err = lockSpaceWrite(ctx, tx, userID); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_space_metadata:'||$1::text,0))`, userID); err != nil {
		return nil, err
	}
	snapshot, err := readSpaceMutationTx(ctx, tx, userID, m)
	if err != nil {
		return nil, err
	}
	if err = validateSpaceMutation(snapshot, m); err != nil {
		return nil, err
	}
	m.CreatedAt = time.Now().UTC()
	for _, item := range snapshot.Items {
		if item.Kind == m.Kind && item.ID == m.ID {
			m.CreatedAt = item.CreatedAt
		}
	}
	m.Version++
	m.UpdatedAt = time.Now().UTC()
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_space_metadata(user_id,kind,id,name,folder_id,starred,trashed,version,created_at,updated_at) VALUES($1,$2,$3,$4,NULLIF($5,'')::uuid,$6,$7,$8,$9,$10) ON CONFLICT(user_id,kind,id) DO UPDATE SET name=EXCLUDED.name,folder_id=EXCLUDED.folder_id,starred=EXCLUDED.starred,trashed=EXCLUDED.trashed,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at`, userID, m.Kind, m.ID, m.Name, m.FolderID, m.Starred, m.Trashed, m.Version, m.CreatedAt, m.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return &m, tx.Commit()
}

func cloudSpaceQuotaTx(ctx context.Context, tx *sql.Tx, userID, size int64) (CloudSpaceLimits, error) {
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_space_quota:'||$1::text,0))`, userID); err != nil {
		return CloudSpaceLimits{}, err
	}
	limits, err := readSpaceLimitsTx(ctx, tx, userID)
	if err != nil {
		return limits, err
	}
	var used int64
	err = tx.QueryRowContext(ctx, `SELECT COALESCE((SELECT SUM(size) FROM zeroagent_cloud_files WHERE user_id=$1 AND state<>'deleted'),0)+COALESCE((SELECT SUM(size) FROM zeroagent_cloud_artifact_versions WHERE user_id=$1 AND state<>'deleted'),0)`, userID).Scan(&used)
	if err != nil {
		return limits, err
	}
	if size > limits.TotalBytes-used {
		return limits, ErrCloudFileQuota
	}
	return limits, nil
}
func (s *MemoryStore) cloudSpaceQuotaLocked(userID, size int64) bool {
	usage := s.spaceRecordsLocked(userID).snapshot().Usage
	return usage.UsedBytes+size <= usage.LimitBytes
}
