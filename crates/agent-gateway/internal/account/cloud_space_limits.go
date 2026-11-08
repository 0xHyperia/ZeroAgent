package account

import (
	"context"
	"database/sql"
)

type CloudSpaceLimits struct {
	TotalBytes          int64 `json:"total_bytes"`
	FileBytes           int64 `json:"file_bytes"`
	ArtifactBytes       int64 `json:"artifact_bytes"`
	MaxFiles            int   `json:"max_files"`
	MaxArtifactVersions int   `json:"max_artifact_versions"`
}

func defaultSpaceLimits() CloudSpaceLimits {
	return CloudSpaceLimits{CloudSpaceDefaultBytes, CloudFileMaxAccountBytes, CloudArtifactMaxAccountBytes, CloudFileMaxAccountFiles, CloudArtifactMaxAccountVersions}
}
func validSpaceLimits(p CloudSpaceLimits) bool {
	return p.TotalBytes > 0 && p.TotalBytes <= 1<<50 && p.FileBytes > 0 && p.FileBytes <= p.TotalBytes && p.ArtifactBytes > 0 && p.ArtifactBytes <= p.TotalBytes && p.MaxFiles > 0 && p.MaxFiles <= 1_000_000 && p.MaxArtifactVersions > 0 && p.MaxArtifactVersions <= 1_000_000
}

// Acquire before object/run row locks and before the narrower quota/family
// locks. Revision triggers share one owner row; this order prevents a family
// bulk-delete and a single-version update from forming a lock cycle.
func lockSpaceWrite(ctx context.Context, tx *sql.Tx, userID int64) error {
	_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_space_write:'||$1::text,0))`, userID)
	return err
}

func readSpaceLimitsTx(ctx context.Context, tx *sql.Tx, userID int64) (CloudSpaceLimits, error) {
	p := defaultSpaceLimits()
	err := tx.QueryRowContext(ctx, `SELECT COALESCE(l.limit_bytes,$2),COALESCE(l.file_limit_bytes,$3),COALESCE(l.artifact_limit_bytes,$4),COALESCE(l.max_files,$5),COALESCE(l.max_artifact_versions,$6) FROM (SELECT 1) AS singleton LEFT JOIN zeroagent_cloud_space_limits l ON l.user_id=$1`, userID, p.TotalBytes, p.FileBytes, p.ArtifactBytes, p.MaxFiles, p.MaxArtifactVersions).Scan(&p.TotalBytes, &p.FileBytes, &p.ArtifactBytes, &p.MaxFiles, &p.MaxArtifactVersions)
	return p, err
}

// Operator access only. No browser endpoint or model tool can increase quotas.
// This uses the same lock as reservations; a downgrade preserves existing data
// and blocks new reservations until usage is below the configured limits.
func ConfigureCloudSpaceLimits(ctx context.Context, db *sql.DB, userID int64, p CloudSpaceLimits) error {
	if db == nil || userID <= 0 || !validSpaceLimits(p) {
		return ErrCloudFileInvalid
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = lockSpaceWrite(ctx, tx, userID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_space_quota:'||$1::text,0))`, userID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO zeroagent_cloud_space_limits(user_id,limit_bytes,file_limit_bytes,artifact_limit_bytes,max_files,max_artifact_versions)VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id) DO UPDATE SET limit_bytes=EXCLUDED.limit_bytes,file_limit_bytes=EXCLUDED.file_limit_bytes,artifact_limit_bytes=EXCLUDED.artifact_limit_bytes,max_files=EXCLUDED.max_files,max_artifact_versions=EXCLUDED.max_artifact_versions`, userID, p.TotalBytes, p.FileBytes, p.ArtifactBytes, p.MaxFiles, p.MaxArtifactVersions)
	if err != nil {
		return err
	}
	return tx.Commit()
}
func ReadCloudSpaceLimits(ctx context.Context, db *sql.DB, userID int64) (CloudSpaceLimits, error) {
	if db == nil || userID <= 0 {
		return CloudSpaceLimits{}, ErrCloudFileInvalid
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return CloudSpaceLimits{}, err
	}
	defer tx.Rollback()
	p, err := readSpaceLimitsTx(ctx, tx, userID)
	if err != nil {
		return p, err
	}
	return p, tx.Commit()
}
func (s *MemoryStore) spaceLimitsLocked(userID int64) CloudSpaceLimits {
	if p, ok := s.cloudSpacePolicies[userID]; ok {
		return p
	}
	p := defaultSpaceLimits()
	if limit := s.cloudSpaceLimits[userID]; limit > 0 {
		p.TotalBytes = limit
	}
	return p
}
