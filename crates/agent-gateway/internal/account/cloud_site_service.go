package account

import (
	"bytes"
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudsite"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

// Only verified immutable ZIP bytes are cached. An access grant, session and
// canonical artifact are checked again on every request, including cache hits.
type cloudSiteCacheEntry struct {
	key  string
	data []byte
}
type cloudSiteService struct {
	config  cloudsite.Config
	store   CloudSiteStore
	mu      sync.Mutex
	cache   map[string]*list.Element
	lru     list.List
	bytes   int
	renders chan struct{}
}

func (s *Service) SetCloudSiteConfig(config *cloudsite.Config) error {
	s.cloudSiteMu.Lock()
	defer s.cloudSiteMu.Unlock()
	if s.cloudSites != nil {
		return ErrCloudSiteConflict
	}
	if config == nil {
		return nil
	}
	store, ok := s.store.(CloudSiteStore)
	if !ok {
		return ErrCloudSiteInvalid
	}
	if _, err := s.cloudFileProvider(); err != nil {
		return err
	}
	s.cloudSites = &cloudSiteService{config: *config, store: store, cache: map[string]*list.Element{}, renders: make(chan struct{}, 16)}
	return nil
}
func (s *Service) siteProvider() (*cloudSiteService, error) {
	s.cloudSiteMu.RLock()
	defer s.cloudSiteMu.RUnlock()
	if s.cloudSites == nil {
		return nil, objectstore.ErrDisabled
	}
	return s.cloudSites, nil
}
func (p *cloudSiteService) cached(key string) []byte {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e := p.cache[key]; e != nil {
		p.lru.MoveToFront(e)
		return e.Value.(cloudSiteCacheEntry).data
	}
	return nil
}
func (p *cloudSiteService) remember(key string, data []byte) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cache[key] != nil {
		return
	}
	for p.bytes+len(data) > 64<<20 || p.lru.Len() >= 64 {
		e := p.lru.Back()
		if e == nil {
			return
		}
		item := e.Value.(cloudSiteCacheEntry)
		p.bytes -= len(item.data)
		delete(p.cache, item.key)
		p.lru.Remove(e)
	}
	p.cache[key] = p.lru.PushFront(cloudSiteCacheEntry{key, data})
	p.bytes += len(data)
}
func (s *Service) siteArchive(ctx context.Context, p *cloudSiteService, a *CloudArtifactVersion) ([]byte, error) {
	if a.Size <= 0 || a.Size > cloudsite.MaxArchiveBytes || !siteDigest(a.SHA256) {
		return nil, ErrCloudSiteInvalid
	}
	key := a.ID + ":" + a.SHA256
	if data := p.cached(key); data != nil {
		return data, nil
	}
	files, err := s.cloudFileProvider()
	if err != nil {
		return nil, err
	}
	if err = acquireCloudFileSlot(ctx, files.downloads); err != nil {
		return nil, err
	}
	defer func() { <-files.downloads }()
	if data := p.cached(key); data != nil {
		return data, nil
	}
	var buffer bytes.Buffer
	buffer.Grow(int(a.Size))
	if err = verifyCloudArtifactObject(ctx, files.objects, a, &buffer); err != nil {
		return nil, err
	}
	data := buffer.Bytes()
	p.remember(key, data)
	return data, nil
}
func (s *Service) liveSiteSession(ctx context.Context, session *Session) bool {
	if session == nil {
		return false
	}
	current, err := s.store.GetSession(ctx, session.ID)
	return err == nil && current.UserID == session.UserID && current.SessionExpiresAt.After(s.now())
}
func (s *Service) siteArtifact(ctx context.Context, release *CloudSiteRelease) (*CloudArtifactVersion, error) {
	store, err := s.artifactStore()
	if err != nil {
		return nil, err
	}
	a, err := store.GetCloudArtifactVersion(ctx, release.UserID, release.ID)
	if err != nil {
		return nil, err
	}
	if a.State != CloudArtifactReady || a.DeletedAt != nil || a.FamilyID != release.SiteID || a.SHA256 != release.SHA256 {
		return nil, ErrNotFound
	}
	return a, nil
}

func (s *Service) CreateCloudSiteRelease(ctx context.Context, session *Session, id, entryPoint string) (*CloudSiteRelease, error) {
	if !s.liveSiteSession(ctx, session) {
		return nil, ErrNotFound
	}
	return s.registerCloudSiteRelease(ctx, session.UserID, id, entryPoint, func() bool { return s.liveSiteSession(ctx, session) })
}

// The AI publisher may call this only with its live execution-lease guard. A
// release saves a private version; this function never issues a sharing grant.
func (s *Service) registerCloudSiteRelease(ctx context.Context, userID int64, id, entryPoint string, valid func() bool) (*CloudSiteRelease, error) {
	if !siteIdentity(id) || len(entryPoint) > 512 {
		return nil, ErrCloudSiteInvalid
	}
	p, err := s.siteProvider()
	if err != nil {
		return nil, err
	}
	if err = acquireCloudFileSlot(ctx, p.renders); err != nil {
		return nil, err
	}
	defer func() { <-p.renders }()
	store, err := s.artifactStore()
	if err != nil {
		return nil, err
	}
	a, err := store.GetCloudArtifactVersion(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	if a.State != CloudArtifactReady || a.DeletedAt != nil {
		return nil, ErrNotFound
	}
	if !strings.HasSuffix(strings.ToLower(a.Name), ".zip") {
		return nil, ErrCloudSiteInvalid
	}
	data, err := s.siteArchive(ctx, p, a)
	if err != nil {
		return nil, err
	}
	m, err := cloudsite.Inspect(bytes.NewReader(data), int64(len(data)), entryPoint)
	if err != nil {
		return nil, err
	}
	if !valid() {
		return nil, ErrNotFound
	}
	return p.store.PutCloudSiteRelease(ctx, userID, id, *m)
}

func siteGrantBinding(g *CloudSiteGrant) string {
	// Mutable revocation/version fields are deliberately absent. Revocation is
	// read from the authoritative store, rather than producing another valid URL.
	data, _ := json.Marshal([]any{g.UserID, g.SiteID, g.ReleaseID, g.Mode, g.SessionRef, g.RequestHash, g.CreatedAt.UTC().Format(time.RFC3339Nano), g.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	return string(data)
}
func siteGrantURL(p *cloudSiteService, g *CloudSiteGrant, entryPoint string) (string, error) {
	origin, err := p.config.Origin(g.SiteID)
	if err != nil {
		return "", err
	}
	token, err := p.config.Token(g.ID, siteGrantBinding(g))
	if err != nil {
		return "", err
	}
	u, err := url.Parse(origin)
	if err != nil {
		return "", err
	}
	u.Path = "/v/" + token + "/" + entryPoint
	return u.String(), nil
}
func (s *Service) CreateCloudSiteAccess(ctx context.Context, session *Session, releaseID, requestID, mode string, ttl time.Duration) (*CloudSiteGrant, error) {
	if !s.liveSiteSession(ctx, session) {
		return nil, ErrNotFound
	}
	p, err := s.siteProvider()
	if err != nil {
		return nil, err
	}
	g := CloudSiteGrant{ID: requestID, ReleaseID: releaseID, Mode: mode, RequestHash: strings.Repeat("0", 64)}
	if mode == "private" {
		sessions, ok := s.store.(cloudRunSessionStore)
		if !ok {
			return nil, objectstore.ErrDisabled
		}
		g.SessionRef, err = sessions.BindCloudRunSession(ctx, session)
		if err != nil {
			return nil, err
		}
	}
	if err = validateSiteGrant(session.UserID, g, ttl); err != nil {
		return nil, err
	}
	release, err := p.store.GetCloudSiteRelease(ctx, session.UserID, releaseID)
	if err != nil {
		return nil, err
	}
	if _, err = s.siteArtifact(ctx, release); err != nil {
		return nil, err
	}
	fingerprint, _ := json.Marshal([]any{session.UserID, releaseID, mode, int64(ttl / time.Second), g.SessionRef})
	digest := sha256.Sum256(fingerprint)
	g.RequestHash = hex.EncodeToString(digest[:])
	if !s.liveSiteSession(ctx, session) {
		return nil, ErrNotFound
	}
	saved, err := p.store.CreateCloudSiteGrant(ctx, session.UserID, g, ttl)
	if err != nil {
		return nil, err
	}
	if !s.liveSiteSession(ctx, session) {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer cancel()
		_, _ = p.store.RevokeCloudSiteGrant(cleanup, session.UserID, saved.ID, saved.Version)
		return nil, ErrNotFound
	}
	saved.URL, err = siteGrantURL(p, saved, release.Manifest.EntryPoint)
	return saved, err
}
func (s *Service) siteAccess(ctx context.Context, p *cloudSiteService, token, host string) (*CloudSiteRelease, *CloudArtifactVersion, error) {
	id, err := cloudsite.GrantID(token)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	g, err := p.store.GetCloudSiteGrant(ctx, id)
	if err != nil {
		return nil, nil, err
	}
	origin, err := p.config.Origin(g.SiteID)
	if err != nil {
		return nil, nil, ErrNotFound
	}
	u, _ := url.Parse(origin)
	if !strings.EqualFold(host, u.Host) || g.RevokedAt != nil || !g.ExpiresAt.After(s.now()) || !p.config.VerifyToken(token, g.ID, siteGrantBinding(g)) {
		return nil, nil, ErrNotFound
	}
	if g.Mode == "private" {
		sessions, ok := s.store.(cloudRunSessionStore)
		if !ok {
			return nil, nil, ErrNotFound
		}
		session, err := sessions.GetCloudRunSession(ctx, g.SessionRef)
		if err != nil || session.UserID != g.UserID || !s.liveSiteSession(ctx, session) {
			return nil, nil, ErrNotFound
		}
	} else if g.Mode != "share" {
		return nil, nil, ErrNotFound
	}
	r, err := p.store.GetCloudSiteRelease(ctx, g.UserID, g.ReleaseID)
	if err != nil {
		return nil, nil, err
	}
	if r.SiteID != g.SiteID {
		return nil, nil, ErrNotFound
	}
	a, err := s.siteArtifact(ctx, r)
	return r, a, err
}
