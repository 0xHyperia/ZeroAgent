package account

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudsite"
)

type cloudSiteMemoryState struct {
	releases map[string]CloudSiteRelease
	grants   map[string]CloudSiteGrant
}

func (s *MemoryStore) siteStateLocked() *cloudSiteMemoryState {
	if s.cloudSites == nil {
		s.cloudSites = &cloudSiteMemoryState{map[string]CloudSiteRelease{}, map[string]CloudSiteGrant{}}
	}
	return s.cloudSites
}
func (s *MemoryStore) PutCloudSiteRelease(ctx context.Context, userID int64, id string, m cloudsite.Manifest) (*CloudSiteRelease, error) {
	return s.putCloudSiteRelease(ctx, userID, id, m, nil)
}
func (s *MemoryStore) PrepareCloudSiteRelease(ctx context.Context, userID int64, id string, version int64, owner string, attempt int64, m cloudsite.Manifest) (*CloudSiteRelease, error) {
	return s.putCloudSiteRelease(ctx, userID, id, m, &cloudSitePublicationLease{version, owner, attempt})
}
func (s *MemoryStore) putCloudSiteRelease(ctx context.Context, userID int64, id string, m cloudsite.Manifest, lease *cloudSitePublicationLease) (*CloudSiteRelease, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateSiteManifest(m); err != nil {
		return nil, err
	}
	if userID <= 0 || !siteIdentity(id) {
		return nil, ErrCloudSiteInvalid
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cloudArtifacts == nil {
		return nil, ErrNotFound
	}
	source, ok := s.cloudArtifacts.versions[id]
	if !ok || source.UserID != userID || source.DeletedAt != nil {
		return nil, ErrNotFound
	}
	if lease == nil {
		if source.State != CloudArtifactReady {
			return nil, ErrNotFound
		}
	} else {
		if !stagedSiteSource(&source, lease) {
			return nil, ErrCloudSiteConflict
		}
		if s.cloudRuns == nil {
			return nil, ErrNotFound
		}
		run, ok := s.cloudRuns.runs[source.SourceRunID]
		if !ok || run.UserID != userID {
			return nil, ErrNotFound
		}
		if run.State != CloudRunRunning {
			return nil, ErrCloudRunLeaseLost
		}
		if err := validateCloudRunLease(&run, lease.owner, lease.attempt, s.now()); err != nil {
			return nil, err
		}
	}
	state := s.siteStateLocked()
	if prior, exists := state.releases[id]; exists {
		before, _ := json.Marshal(prior.Manifest)
		after, _ := json.Marshal(m)
		if string(before) != string(after) || prior.UserID != userID || prior.SHA256 != source.SHA256 {
			return nil, ErrCloudSiteConflict
		}
		return cloneSiteRelease(prior), nil
	}
	r := CloudSiteRelease{ID: id, SiteID: source.FamilyID, UserID: userID, SHA256: source.SHA256, Manifest: m, CreatedAt: s.now().UTC()}
	state.releases[id] = *cloneSiteRelease(r)
	return cloneSiteRelease(r), nil
}
func (s *MemoryStore) GetCloudSiteRelease(ctx context.Context, userID int64, id string) (*CloudSiteRelease, error) {
	if userID <= 0 || !siteIdentity(id) {
		return nil, ErrNotFound
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.cloudSites == nil {
		return nil, ErrNotFound
	}
	r, ok := s.cloudSites.releases[id]
	if !ok || r.UserID != userID {
		return nil, ErrNotFound
	}
	return cloneSiteRelease(r), nil
}
func (s *MemoryStore) CreateCloudSiteGrant(ctx context.Context, userID int64, input CloudSiteGrant, ttl time.Duration) (*CloudSiteGrant, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateSiteGrant(userID, input, ttl); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.siteStateLocked()
	r, exists := state.releases[input.ReleaseID]
	if !exists || r.UserID != userID {
		return nil, ErrNotFound
	}
	source, exists := s.cloudArtifacts.versions[r.ID]
	if !exists || source.UserID != userID || source.State != CloudArtifactReady || source.DeletedAt != nil || source.SHA256 != r.SHA256 {
		return nil, ErrNotFound
	}
	if prior, exists := state.grants[input.ID]; exists {
		if !sameSiteGrant(prior, input, userID, s.now()) {
			return nil, ErrCloudSiteConflict
		}
		return cloneSiteGrant(prior), nil
	}
	count := 0
	for _, g := range state.grants {
		if g.UserID == userID && g.Mode == input.Mode && g.RevokedAt == nil && g.ExpiresAt.After(s.now()) {
			count++
		}
	}
	if count >= 100 {
		return nil, ErrCloudSiteConflict
	}
	input.UserID = userID
	input.SiteID = r.SiteID
	input.Version = 1
	input.CreatedAt = s.now().UTC()
	input.ExpiresAt = input.CreatedAt.Add(ttl)
	input.RevokedAt = nil
	input.URL = ""
	state.grants[input.ID] = input
	return cloneSiteGrant(input), nil
}
func (s *MemoryStore) GetCloudSiteGrant(ctx context.Context, id string) (*CloudSiteGrant, error) {
	if !siteIdentity(id) {
		return nil, ErrNotFound
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.cloudSites == nil {
		return nil, ErrNotFound
	}
	g, exists := s.cloudSites.grants[id]
	if !exists {
		return nil, ErrNotFound
	}
	return cloneSiteGrant(g), nil
}
func (s *MemoryStore) ListCloudSiteShares(ctx context.Context, userID int64, siteID string) ([]CloudSiteGrant, error) {
	if userID <= 0 || !siteIdentity(siteID) {
		return nil, ErrNotFound
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	items := []CloudSiteGrant{}
	if s.cloudSites != nil {
		for _, g := range s.cloudSites.grants {
			if g.UserID == userID && g.SiteID == siteID && g.Mode == "share" && g.RevokedAt == nil && g.ExpiresAt.After(s.now()) {
				items = append(items, *cloneSiteGrant(g))
			}
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	return items[:min(len(items), 100)], nil
}
func (s *MemoryStore) RevokeCloudSiteGrant(ctx context.Context, userID int64, id string, version int64) (*CloudSiteGrant, error) {
	if userID <= 0 || !siteIdentity(id) {
		return nil, ErrNotFound
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cloudSites == nil {
		return nil, ErrNotFound
	}
	g, ok := s.cloudSites.grants[id]
	if !ok || g.UserID != userID {
		return nil, ErrNotFound
	}
	if version != g.Version {
		return nil, ErrCloudSiteConflict
	}
	if g.RevokedAt == nil {
		now := s.now().UTC()
		g.RevokedAt = &now
		g.Version++
		s.cloudSites.grants[id] = g
	}
	return cloneSiteGrant(g), nil
}
