package account

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudsite"
)

var ErrCloudSiteInvalid = errors.New("invalid static site request")
var ErrCloudSiteConflict = errors.New("static site changed")

// A release references the canonical immutable artifact; it is not another
// object copy or sandbox URL. SiteID is the existing artifact family identity.
type CloudSiteRelease struct {
	ID        string             `json:"id"`
	SiteID    string             `json:"site_id"`
	UserID    int64              `json:"-"`
	SHA256    string             `json:"sha256"`
	Manifest  cloudsite.Manifest `json:"manifest"`
	CreatedAt time.Time          `json:"created_at"`
}
type CloudSiteGrant struct {
	ID          string     `json:"id"`
	UserID      int64      `json:"-"`
	SiteID      string     `json:"site_id"`
	ReleaseID   string     `json:"release_id"`
	Mode        string     `json:"mode"`
	SessionRef  string     `json:"-"`
	RequestHash string     `json:"-"`
	Version     int64      `json:"version"`
	CreatedAt   time.Time  `json:"created_at"`
	ExpiresAt   time.Time  `json:"expires_at"`
	RevokedAt   *time.Time `json:"revoked_at,omitempty"`
	URL         string     `json:"url,omitempty"`
}
type CloudSiteStore interface {
	PutCloudSiteRelease(context.Context, int64, string, cloudsite.Manifest) (*CloudSiteRelease, error)
	PrepareCloudSiteRelease(context.Context, int64, string, int64, string, int64, cloudsite.Manifest) (*CloudSiteRelease, error)
	GetCloudSiteRelease(context.Context, int64, string) (*CloudSiteRelease, error)
	CreateCloudSiteGrant(context.Context, int64, CloudSiteGrant, time.Duration) (*CloudSiteGrant, error)
	GetCloudSiteGrant(context.Context, string) (*CloudSiteGrant, error)
	ListCloudSiteShares(context.Context, int64, string) ([]CloudSiteGrant, error)
	RevokeCloudSiteGrant(context.Context, int64, string, int64) (*CloudSiteGrant, error)
}
type cloudSitePublicationLease struct {
	version int64
	owner   string
	attempt int64
}

func stagedSiteSource(source *CloudArtifactVersion, lease *cloudSitePublicationLease) bool {
	var journal cloudArtifactJournal
	return lease != nil && source.State == CloudArtifactStaging && source.Version == lease.version && json.Unmarshal(source.Journal, &journal) == nil && journal.PutStarted && journal.ObjectVerified
}

func validateSiteManifest(m cloudsite.Manifest) error {
	if m.Format != 1 || !cloudsite.ValidPath(m.EntryPoint) || cloudsite.ContentType(m.EntryPoint) != "text/html; charset=utf-8" || len(m.Entries) == 0 || len(m.Entries) > cloudsite.MaxEntries || m.ExpandedBytes < 0 || m.ExpandedBytes > cloudsite.MaxExpandedBytes {
		return ErrCloudSiteInvalid
	}
	var total int64
	seen := map[string]bool{}
	found := false
	for _, entry := range m.Entries {
		digest, err := hex.DecodeString(entry.SHA256)
		if !cloudsite.ValidPath(entry.Path) || seen[strings.ToLower(entry.Path)] || entry.MIME == "" || entry.MIME != cloudsite.ContentType(entry.Path) || entry.Size < 0 || entry.Size > cloudsite.MaxEntryBytes || err != nil || len(digest) != 32 || strings.ToLower(entry.SHA256) != entry.SHA256 {
			return ErrCloudSiteInvalid
		}
		seen[strings.ToLower(entry.Path)] = true
		total += entry.Size
		if entry.Path == m.EntryPoint && entry.Size > 0 {
			found = true
		}
	}
	encoded, err := json.Marshal(m)
	if !found || total != m.ExpandedBytes || err != nil || len(encoded) > 2<<20 {
		return ErrCloudSiteInvalid
	}
	return nil
}
func validateSiteGrant(userID int64, g CloudSiteGrant, ttl time.Duration) error {
	if userID <= 0 || ttl < time.Second || ttl%time.Second != 0 || ttl > 30*24*time.Hour || (g.Mode != "private" && g.Mode != "share") || !siteDigest(g.RequestHash) {
		return ErrCloudSiteInvalid
	}
	for _, id := range []string{g.ID, g.ReleaseID} {
		if !siteIdentity(id) {
			return ErrCloudSiteInvalid
		}
	}
	if g.Mode == "private" && (!siteDigest(g.SessionRef) || ttl > 15*time.Minute) || g.Mode == "share" && g.SessionRef != "" {
		return ErrCloudSiteInvalid
	}
	return nil
}
func siteDigest(value string) bool {
	digest, err := hex.DecodeString(value)
	return err == nil && len(digest) == 32 && strings.ToLower(value) == value
}
func siteIdentity(value string) bool {
	id, err := canonicalCloudFileID(value)
	return err == nil && id == value && id != "00000000-0000-0000-0000-000000000000"
}
func cloneSiteRelease(r CloudSiteRelease) *CloudSiteRelease {
	r.Manifest.Entries = append([]cloudsite.Entry{}, r.Manifest.Entries...)
	return &r
}
func cloneSiteGrant(g CloudSiteGrant) *CloudSiteGrant {
	g.URL = ""
	if g.RevokedAt != nil {
		copy := *g.RevokedAt
		g.RevokedAt = &copy
	}
	return &g
}
func sameSiteGrant(g, input CloudSiteGrant, userID int64, now time.Time) bool {
	return g.UserID == userID && g.ReleaseID == input.ReleaseID && g.Mode == input.Mode && g.RequestHash == input.RequestHash && g.SessionRef == input.SessionRef && g.RevokedAt == nil && g.ExpiresAt.After(now)
}
