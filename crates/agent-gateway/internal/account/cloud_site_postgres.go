package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudsite"
)

const CloudSiteSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_site_releases(
 id UUID PRIMARY KEY REFERENCES zeroagent_cloud_artifact_versions(id),site_id UUID NOT NULL REFERENCES zeroagent_cloud_artifact_families(id),user_id BIGINT NOT NULL CHECK(user_id>0),sha256 TEXT NOT NULL CHECK(sha256~'^[0-9a-f]{64}$'),manifest JSONB NOT NULL CHECK(octet_length(manifest::text)<=2097152),created_at TIMESTAMPTZ NOT NULL);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_site_family_idx ON zeroagent_cloud_site_releases(user_id,site_id,created_at DESC);
CREATE TABLE IF NOT EXISTS zeroagent_cloud_site_grants(
 id UUID PRIMARY KEY,user_id BIGINT NOT NULL CHECK(user_id>0),site_id UUID NOT NULL REFERENCES zeroagent_cloud_artifact_families(id),release_id UUID NOT NULL REFERENCES zeroagent_cloud_site_releases(id),mode TEXT NOT NULL CHECK(mode IN('private','share')),session_ref TEXT NOT NULL DEFAULT '',request_hash TEXT NOT NULL CHECK(request_hash~'^[0-9a-f]{64}$'),version BIGINT NOT NULL CHECK(version>0),created_at TIMESTAMPTZ NOT NULL,expires_at TIMESTAMPTZ NOT NULL,revoked_at TIMESTAMPTZ NULL,
 CHECK(expires_at>created_at),CHECK((mode='private' AND session_ref~'^[0-9a-f]{64}$') OR(mode='share' AND session_ref='')));
CREATE INDEX IF NOT EXISTS zeroagent_cloud_site_grant_owner_idx ON zeroagent_cloud_site_grants(user_id,mode,expires_at) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS zeroagent_cloud_site_grant_family_idx ON zeroagent_cloud_site_grants(user_id,site_id,created_at DESC) WHERE mode='share' AND revoked_at IS NULL;`
const siteReleaseColumns = `id::text,site_id::text,user_id,sha256,manifest,created_at`
const siteGrantColumns = `id::text,user_id,site_id::text,release_id::text,mode,session_ref,request_hash,version,created_at,expires_at,revoked_at`

func scanSiteRelease(row interface{ Scan(...any) error }) (*CloudSiteRelease, error) {
	var r CloudSiteRelease
	var encoded []byte
	err := row.Scan(&r.ID, &r.SiteID, &r.UserID, &r.SHA256, &encoded, &r.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(encoded, &r.Manifest); err != nil {
		return nil, err
	}
	return &r, nil
}
func scanSiteGrant(row interface{ Scan(...any) error }) (*CloudSiteGrant, error) {
	var g CloudSiteGrant
	var revoked sql.NullTime
	err := row.Scan(&g.ID, &g.UserID, &g.SiteID, &g.ReleaseID, &g.Mode, &g.SessionRef, &g.RequestHash, &g.Version, &g.CreatedAt, &g.ExpiresAt, &revoked)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if revoked.Valid {
		g.RevokedAt = &revoked.Time
	}
	return &g, nil
}
func (s *PersistentStore) PutCloudSiteRelease(ctx context.Context, userID int64, id string, m cloudsite.Manifest) (*CloudSiteRelease, error) {
	return s.putCloudSiteRelease(ctx, userID, id, m, nil)
}
func (s *PersistentStore) PrepareCloudSiteRelease(ctx context.Context, userID int64, id string, version int64, owner string, attempt int64, m cloudsite.Manifest) (*CloudSiteRelease, error) {
	return s.putCloudSiteRelease(ctx, userID, id, m, &cloudSitePublicationLease{version, owner, attempt})
}
func (s *PersistentStore) putCloudSiteRelease(ctx context.Context, userID int64, id string, m cloudsite.Manifest, lease *cloudSitePublicationLease) (*CloudSiteRelease, error) {
	if err := validateSiteManifest(m); err != nil {
		return nil, err
	}
	if userID <= 0 || !siteIdentity(id) {
		return nil, ErrCloudSiteInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if err = lockSpaceWrite(ctx, tx, userID); err != nil {
		return nil, err
	}
	a, err := scanCloudArtifact(tx.QueryRowContext(ctx, "SELECT "+artifactColumns+" FROM zeroagent_cloud_artifact_versions a WHERE a.id=$1 AND a.user_id=$2 AND a.deleted_at IS NULL FOR SHARE", id, userID))
	if err != nil {
		return nil, err
	}
	if lease == nil {
		if a.State != CloudArtifactReady {
			return nil, ErrNotFound
		}
	} else {
		if !stagedSiteSource(a, lease) {
			return nil, ErrCloudSiteConflict
		}
		if _, err = artifactTxRun(ctx, tx, userID, a.SourceRunID, lease.owner, lease.attempt); err != nil {
			return nil, err
		}
	}
	prior, err := scanSiteRelease(tx.QueryRowContext(ctx, "SELECT "+siteReleaseColumns+" FROM zeroagent_cloud_site_releases WHERE id=$1", id))
	if err == nil {
		before, _ := json.Marshal(prior.Manifest)
		after, _ := json.Marshal(m)
		if string(before) != string(after) || prior.SHA256 != a.SHA256 || prior.UserID != userID {
			return nil, ErrCloudSiteConflict
		}
		return prior, tx.Commit()
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	encoded, _ := json.Marshal(m)
	r, err := scanSiteRelease(tx.QueryRowContext(ctx, `INSERT INTO zeroagent_cloud_site_releases(id,site_id,user_id,sha256,manifest,created_at)VALUES($1,$2,$3,$4,$5::jsonb,clock_timestamp()) RETURNING `+siteReleaseColumns, id, a.FamilyID, userID, a.SHA256, string(encoded)))
	if err != nil {
		return nil, err
	}
	return r, tx.Commit()
}
func (s *PersistentStore) GetCloudSiteRelease(ctx context.Context, userID int64, id string) (*CloudSiteRelease, error) {
	if userID <= 0 || !siteIdentity(id) {
		return nil, ErrNotFound
	}
	return scanSiteRelease(s.db.QueryRowContext(ctx, "SELECT "+siteReleaseColumns+" FROM zeroagent_cloud_site_releases WHERE id=$1 AND user_id=$2", id, userID))
}
func (s *PersistentStore) CreateCloudSiteGrant(ctx context.Context, userID int64, input CloudSiteGrant, ttl time.Duration) (*CloudSiteGrant, error) {
	if err := validateSiteGrant(userID, input, ttl); err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_site_grants:'||$1::text,0))`, userID); err != nil {
		return nil, err
	}
	prior, err := scanSiteGrant(tx.QueryRowContext(ctx, "SELECT "+siteGrantColumns+" FROM zeroagent_cloud_site_grants WHERE id=$1 FOR UPDATE", input.ID))
	if err == nil {
		if !sameSiteGrant(*prior, input, userID, time.Now()) {
			return nil, ErrCloudSiteConflict
		}
		return prior, tx.Commit()
	}
	if !errors.Is(err, ErrNotFound) {
		return nil, err
	}
	var siteID string
	err = tx.QueryRowContext(ctx, `SELECT r.site_id::text FROM zeroagent_cloud_site_releases r JOIN zeroagent_cloud_artifact_versions a ON a.id=r.id AND a.user_id=r.user_id AND a.sha256=r.sha256 WHERE r.user_id=$1 AND r.id=$2 AND a.state='ready' AND a.deleted_at IS NULL FOR SHARE OF a`, userID, input.ReleaseID).Scan(&siteID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var count int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM zeroagent_cloud_site_grants WHERE user_id=$1 AND mode=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp()`, userID, input.Mode).Scan(&count); err != nil {
		return nil, err
	}
	if count >= 100 {
		return nil, ErrCloudSiteConflict
	}
	g, err := scanSiteGrant(tx.QueryRowContext(ctx, `INSERT INTO zeroagent_cloud_site_grants(id,user_id,site_id,release_id,mode,session_ref,request_hash,version,created_at,expires_at)VALUES($1,$2,$3,$4,$5,$6,$7,1,statement_timestamp(),statement_timestamp()+($8*interval '1 second')) RETURNING `+siteGrantColumns, input.ID, userID, siteID, input.ReleaseID, input.Mode, input.SessionRef, input.RequestHash, int64(ttl/time.Second)))
	if err != nil {
		return nil, err
	}
	return g, tx.Commit()
}
func (s *PersistentStore) GetCloudSiteGrant(ctx context.Context, id string) (*CloudSiteGrant, error) {
	if !siteIdentity(id) {
		return nil, ErrNotFound
	}
	return scanSiteGrant(s.db.QueryRowContext(ctx, "SELECT "+siteGrantColumns+" FROM zeroagent_cloud_site_grants WHERE id=$1", id))
}
func (s *PersistentStore) ListCloudSiteShares(ctx context.Context, userID int64, siteID string) ([]CloudSiteGrant, error) {
	if userID <= 0 || !siteIdentity(siteID) {
		return nil, ErrNotFound
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+siteGrantColumns+" FROM zeroagent_cloud_site_grants WHERE user_id=$1 AND site_id=$2 AND mode='share' AND revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY created_at DESC,id DESC LIMIT 100", userID, siteID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []CloudSiteGrant{}
	for rows.Next() {
		g, err := scanSiteGrant(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, *g)
	}
	return items, rows.Err()
}
func (s *PersistentStore) RevokeCloudSiteGrant(ctx context.Context, userID int64, id string, version int64) (*CloudSiteGrant, error) {
	if userID <= 0 || !siteIdentity(id) {
		return nil, ErrNotFound
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	g, err := scanSiteGrant(tx.QueryRowContext(ctx, "SELECT "+siteGrantColumns+" FROM zeroagent_cloud_site_grants WHERE id=$1 AND user_id=$2 FOR UPDATE", id, userID))
	if err != nil {
		return nil, err
	}
	if g.Version != version {
		return nil, ErrCloudSiteConflict
	}
	if g.RevokedAt != nil {
		return g, tx.Commit()
	}
	g, err = scanSiteGrant(tx.QueryRowContext(ctx, `UPDATE zeroagent_cloud_site_grants SET revoked_at=clock_timestamp(),version=version+1 WHERE id=$1 RETURNING `+siteGrantColumns, id))
	if err != nil {
		return nil, err
	}
	return g, tx.Commit()
}
