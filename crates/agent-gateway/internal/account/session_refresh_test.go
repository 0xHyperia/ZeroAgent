package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

type sessionRefreshFixture struct {
	store      Store
	remember   func(string)
	expireLock func(string)
}

func memorySessionRefreshFixture(t *testing.T) sessionRefreshFixture {
	t.Helper()
	store := NewMemoryStore()
	return sessionRefreshFixture{store: store, remember: func(string) {}, expireLock: func(id string) {
		store.mu.Lock()
		defer store.mu.Unlock()
		store.sessionRefresh.records[id].LockUntil = time.Now().Add(-time.Second)
	}}
}

func redisSessionRefreshFixture(t *testing.T) sessionRefreshFixture {
	t.Helper()
	address := os.Getenv("ZEROAGENT_SESSION_REFRESH_TEST_REDIS_URL")
	if address == "" {
		t.Skip("set ZEROAGENT_SESSION_REFRESH_TEST_REDIS_URL for isolated Redis account-authority verification")
	}
	parsed, err := url.Parse(address)
	if err != nil || (parsed.Scheme != "redis" && parsed.Scheme != "rediss") || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" && parsed.Hostname() != "::1") {
		t.Fatal("session refresh integration requires an explicit loopback test Redis URL")
	}
	options, err := redis.ParseURL(address)
	if err != nil {
		t.Fatal("invalid test Redis URL")
	}
	client := redis.NewClient(options)
	t.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err = client.Ping(ctx).Err(); err != nil {
		t.Fatal("test Redis unavailable")
	}
	return sessionRefreshFixture{store: &PersistentStore{rdb: client}, expireLock: func(id string) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		key := sessionAuthorityKeys(id)[3]
		if err := client.PExpire(ctx, key, time.Millisecond).Err(); err != nil {
			t.Fatal("expire owned test refresh lock")
		}
		for {
			exists, err := client.Exists(ctx, key).Result()
			if err != nil {
				t.Fatal("inspect owned test refresh lock")
			}
			if exists == 0 {
				break
			}
			timer := time.NewTimer(time.Millisecond)
			select {
			case <-ctx.Done():
				timer.Stop()
				t.Fatal("test refresh lock did not expire")
			case <-timer.C:
			}
		}
	}, remember: func(id string) {
		keys := sessionAuthorityKeys(id)
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := client.Del(ctx, keys...).Err(); err != nil {
				t.Errorf("remove owned test session keys: %v", err)
			}
		})
	}}
}

type rotatingAccountServer struct {
	server           *httptest.Server
	mu               sync.Mutex
	used             map[string]bool
	revoked          map[string]bool
	refreshCalls     int
	refreshEntered   chan struct{}
	refreshRelease   chan struct{}
	refreshOnce      sync.Once
	meEntered        chan struct{}
	meRelease        chan struct{}
	meOnce           sync.Once
	meFailures       atomic.Int64
	revokeFails      atomic.Bool
	refreshFails     atomic.Bool
	wrongIdentity    atomic.Bool
	meRejectOriginal atomic.Bool
}

func newRotatingAccountServer(t *testing.T) *rotatingAccountServer {
	t.Helper()
	fixture := &rotatingAccountServer{used: make(map[string]bool), revoked: make(map[string]bool), refreshEntered: make(chan struct{}), meEntered: make(chan struct{})}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/app-auth/token":
			_ = r.ParseForm()
			fixture.mu.Lock()
			fixture.refreshCalls++
			token := r.Form.Get("refresh_token")
			reused := fixture.used[token]
			fixture.used[token] = true
			fixture.mu.Unlock()
			fixture.refreshOnce.Do(func() { close(fixture.refreshEntered) })
			if fixture.refreshRelease != nil {
				select {
				case <-fixture.refreshRelease:
				case <-r.Context().Done():
					return
				}
			}
			if fixture.refreshFails.Load() {
				http.Error(w, `{"error":"temporarily_unavailable"}`, http.StatusServiceUnavailable)
				return
			}
			if reused {
				http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
				return
			}
			_, _ = fmt.Fprintf(w, `{"access_token":"new-access-%s","refresh_token":"new-refresh-%s","expires_in":3600,"token_type":"Bearer"}`, token, token)
		case "/api/v1/app/me":
			if r.Header.Get("Authorization") == "Bearer original-access" && fixture.meRelease != nil {
				fixture.meOnce.Do(func() { close(fixture.meEntered) })
				select {
				case <-fixture.meRelease:
				case <-r.Context().Done():
					return
				}
			}
			if fixture.meRejectOriginal.Load() && r.Header.Get("Authorization") == "Bearer original-access" {
				http.Error(w, `{"success":false,"error":{"code":"invalid_token","message":"expired"}}`, http.StatusUnauthorized)
				return
			}
			if fixture.meFailures.Load() > 0 && fixture.meFailures.Add(-1) >= 0 {
				http.Error(w, `{"success":false,"error":{"code":"temporary","message":"temporary"}}`, http.StatusServiceUnavailable)
				return
			}
			id := int64(7)
			if fixture.wrongIdentity.Load() {
				id = 8
			}
			_, _ = fmt.Fprintf(w, `{"success":true,"data":{"id":%d,"email":"fixture@example.invalid","nickname":"verified"}}`, id)
		case "/api/v1/app-auth/revoke":
			_ = r.ParseForm()
			if fixture.revokeFails.Load() {
				http.Error(w, `{"error":"temporarily_unavailable"}`, http.StatusServiceUnavailable)
				return
			}
			fixture.mu.Lock()
			fixture.revoked[r.Form.Get("token")] = true
			fixture.mu.Unlock()
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(fixture.server.Close)
	return fixture
}

func (f *rotatingAccountServer) client() *USAClient {
	return NewUSAClientWithHTTPClient(f.server.URL, f.server.Client(), strings.Repeat("x", 32))
}
func (f *rotatingAccountServer) calls() int { f.mu.Lock(); defer f.mu.Unlock(); return f.refreshCalls }

func seedRefreshingSession(t *testing.T, fixture sessionRefreshFixture) *Session {
	t.Helper()
	session := &Session{ID: uuid.NewString(), UserID: 7, User: json.RawMessage(`{"id":7,"nickname":"original"}`), AccessToken: "original-access", RefreshToken: "original-refresh", AccessExpiresAt: time.Now().Add(-time.Minute), SessionExpiresAt: time.Now().Add(time.Hour), AuthKind: AuthKindOAuth, OAuthClientID: "zeroagent-web"}
	fixture.remember(session.ID)
	if err := fixture.store.PutSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	return session
}

func checkSessionAPIStatus(t *testing.T, err error, status int) {
	t.Helper()
	var api *APIError
	if !errors.As(err, &api) || api.Status != status {
		t.Fatalf("expected account error status %d, got %v", status, err)
	}
}

type refreshCallContextKey struct{}
type observingSessionStore struct {
	Store
	seen         sync.Map
	initialReads chan int
}

func (s *observingSessionStore) ReadSessionAuthority(ctx context.Context, id string) (*sessionAuthoritySnapshot, error) {
	state, err := s.Store.ReadSessionAuthority(ctx, id)
	if value, ok := ctx.Value(refreshCallContextKey{}).(int); ok {
		if _, loaded := s.seen.LoadOrStore(value, true); !loaded {
			s.initialReads <- value
		}
	}
	return state, err
}

type faultSessionStore struct {
	Store
	mu         sync.Mutex
	failAction string
	remaining  int
	readFail   bool
}

func (s *faultSessionStore) ApplySessionAuthority(ctx context.Context, id string, command sessionAuthorityCommand) (*sessionAuthoritySnapshot, error) {
	s.mu.Lock()
	fail := s.failAction == command.Action && s.remaining > 0
	if fail {
		s.remaining--
	}
	s.mu.Unlock()
	if fail {
		return nil, errors.New("injected account storage failure")
	}
	return s.Store.ApplySessionAuthority(ctx, id, command)
}
func (s *faultSessionStore) ReadSessionAuthority(ctx context.Context, id string) (*sessionAuthoritySnapshot, error) {
	s.mu.Lock()
	fail := s.readFail
	if fail {
		s.readFail = false
	}
	s.mu.Unlock()
	if fail {
		return nil, errors.New("injected account read failure")
	}
	return s.Store.ReadSessionAuthority(ctx, id)
}

func TestSessionRefreshMemoryAuthority(t *testing.T) {
	runSessionRefreshContract(t, memorySessionRefreshFixture)
}
func TestSessionRefreshRedisAuthority(t *testing.T) {
	runSessionRefreshContract(t, redisSessionRefreshFixture)
}

func runSessionRefreshContract(t *testing.T, newFixture func(*testing.T) sessionRefreshFixture) {
	t.Run("expired refresh lock fences stale owners", func(t *testing.T) {
		fixture := newFixture(t)
		session := seedRefreshingSession(t, fixture)
		ctx := context.Background()
		version := sessionCredentialVersion(session)
		if _, err := fixture.store.ApplySessionAuthority(ctx, session.ID, sessionAuthorityCommand{Action: "acquire", Owner: "old-worker"}); err != nil {
			t.Fatal(err)
		}
		record := &sessionRefreshRecord{ID: uuid.NewString(), BaseVersion: version, ExpiresAt: session.SessionExpiresAt}
		if _, err := fixture.store.ApplySessionAuthority(ctx, session.ID, sessionAuthorityCommand{Action: "begin", Owner: "old-worker", ExpectedVersion: version, Refresh: record}); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.store.ApplySessionAuthority(ctx, session.ID, sessionAuthorityCommand{Action: "acquire", Owner: "new-worker"}); !errors.Is(err, errSessionAuthorityBusy) {
			t.Fatalf("owned lock was stolen: %v", err)
		}
		fixture.expireLock(session.ID)
		if _, err := fixture.store.ApplySessionAuthority(ctx, session.ID, sessionAuthorityCommand{Action: "acquire", Owner: "new-worker"}); err != nil {
			t.Fatal(err)
		}
		candidate := copySession(session)
		candidate.AccessToken, candidate.RefreshToken = "new-access", "new-refresh"
		candidate.AccessExpiresAt = time.Now().Add(time.Hour)
		stage := sessionAuthorityCommand{Action: "stage", Owner: "old-worker", ExpectedVersion: version, ExpectedRefreshID: record.ID, Candidate: candidate}
		if _, err := fixture.store.ApplySessionAuthority(ctx, session.ID, stage); !errors.Is(err, errSessionAuthorityConflict) {
			t.Fatalf("expired owner staged credentials: %v", err)
		}
		stage.Owner = "new-worker"
		if _, err := fixture.store.ApplySessionAuthority(ctx, session.ID, stage); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.store.ApplySessionAuthority(ctx, session.ID, sessionAuthorityCommand{Action: "commit", Owner: "new-worker", ExpectedVersion: version, ExpectedRefreshID: record.ID, CandidateVersion: "wrong-version"}); !errors.Is(err, errSessionAuthorityConflict) {
			t.Fatalf("unverified candidate committed: %v", err)
		}
		if _, err := fixture.store.ApplySessionAuthority(ctx, session.ID, sessionAuthorityCommand{Action: "commit", Owner: "new-worker", ExpectedVersion: version, ExpectedRefreshID: record.ID, CandidateVersion: sessionCredentialVersion(candidate)}); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("concurrent services consume one-use token once", func(t *testing.T) {
		fixture := newFixture(t)
		session := seedRefreshingSession(t, fixture)
		platform := newRotatingAccountServer(t)
		platform.refreshRelease = make(chan struct{})
		store := &observingSessionStore{Store: fixture.store, initialReads: make(chan int, 8)}
		services := []*Service{NewService(store, platform.client(), time.Hour, time.Hour), NewService(store, platform.client(), time.Hour, time.Hour)}
		var group sync.WaitGroup
		for i := range 8 {
			group.Add(1)
			go func(i int) {
				defer group.Done()
				ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), refreshCallContextKey{}, i), 5*time.Second)
				defer cancel()
				updated, err := services[i%2].Refresh(ctx, session.ID)
				if err != nil {
					t.Errorf("concurrent refresh failed: %v", err)
					return
				}
				if updated.AccessToken != "new-access-original-refresh" {
					t.Error("caller did not receive committed credentials")
				}
			}(i)
		}
		for range 8 {
			select {
			case <-store.initialReads:
			case <-time.After(3 * time.Second):
				t.Fatal("concurrent readers did not start")
			}
		}
		close(platform.refreshRelease)
		group.Wait()
		if platform.calls() != 1 {
			t.Fatalf("one-use refresh calls: %d", platform.calls())
		}
		current, err := fixture.store.GetSession(context.Background(), session.ID)
		if err != nil || current.RefreshToken != "new-refresh-original-refresh" {
			t.Fatalf("rotated session not persisted: %v", err)
		}
	})
	t.Run("pending candidate survives temporary identity failure", func(t *testing.T) {
		fixture := newFixture(t)
		session := seedRefreshingSession(t, fixture)
		platform := newRotatingAccountServer(t)
		platform.meFailures.Store(1)
		service := NewService(fixture.store, platform.client(), time.Hour, time.Hour)
		_, err := service.Session(context.Background(), session.ID)
		checkSessionAPIStatus(t, err, http.StatusBadGateway)
		state, err := fixture.store.ReadSessionAuthority(context.Background(), session.ID)
		if err != nil || state.Session == nil || state.Refresh == nil || state.Refresh.State != "pending" {
			t.Fatalf("candidate was lost: %v", err)
		}
		// A new API process recovers the candidate from the private store.
		replacement := NewService(fixture.store, platform.client(), time.Hour, time.Hour)
		current, err := replacement.Session(context.Background(), session.ID)
		if err != nil || current.RefreshToken != "new-refresh-original-refresh" {
			t.Fatalf("candidate recovery: %v", err)
		}
		if platform.calls() != 1 {
			t.Fatalf("consumed token was retried: %d", platform.calls())
		}
	})
	t.Run("failed candidate commit never consumes old token again", func(t *testing.T) {
		fixture := newFixture(t)
		session := seedRefreshingSession(t, fixture)
		platform := newRotatingAccountServer(t)
		store := &faultSessionStore{Store: fixture.store, failAction: "commit", remaining: 1}
		service := NewService(store, platform.client(), time.Hour, time.Hour)
		_, err := service.Session(context.Background(), session.ID)
		checkSessionAPIStatus(t, err, http.StatusServiceUnavailable)
		current, err := service.Session(context.Background(), session.ID)
		if err != nil || current.RefreshToken != "new-refresh-original-refresh" {
			t.Fatalf("commit retry: %v", err)
		}
		if platform.calls() != 1 {
			t.Fatalf("commit failure resent token: %d", platform.calls())
		}
	})
	t.Run("failed staging retains private candidate and restart fails closed", func(t *testing.T) {
		fixture := newFixture(t)
		session := seedRefreshingSession(t, fixture)
		platform := newRotatingAccountServer(t)
		store := &faultSessionStore{Store: fixture.store, failAction: "stage", remaining: 1}
		service := NewService(store, platform.client(), time.Hour, time.Hour)
		_, err := service.Session(context.Background(), session.ID)
		checkSessionAPIStatus(t, err, http.StatusServiceUnavailable)
		replacement := NewService(fixture.store, platform.client(), time.Hour, time.Hour)
		_, err = replacement.Session(context.Background(), session.ID)
		checkSessionAPIStatus(t, err, http.StatusServiceUnavailable)
		if platform.calls() != 1 {
			t.Fatal("replacement reused a token with an unknown result")
		}
		current, err := service.Session(context.Background(), session.ID)
		if err != nil || current.RefreshToken != "new-refresh-original-refresh" {
			t.Fatalf("private candidate retry: %v", err)
		}
		if platform.calls() != 1 {
			t.Fatal("private retry reused original token")
		}
	})
	t.Run("temporary storage and platform failures preserve account record", func(t *testing.T) {
		fixture := newFixture(t)
		session := seedRefreshingSession(t, fixture)
		platform := newRotatingAccountServer(t)
		store := &faultSessionStore{Store: fixture.store, readFail: true}
		service := NewService(store, platform.client(), time.Hour, time.Hour)
		_, err := service.Session(context.Background(), session.ID)
		checkSessionAPIStatus(t, err, http.StatusServiceUnavailable)
		if _, err := fixture.store.GetSession(context.Background(), session.ID); err != nil {
			t.Fatal("storage outage erased session")
		}
		platform.refreshFails.Store(true)
		_, err = service.Session(context.Background(), session.ID)
		checkSessionAPIStatus(t, err, http.StatusBadGateway)
		if _, err := fixture.store.GetSession(context.Background(), session.ID); err != nil {
			t.Fatal("platform outage erased session")
		}
		_, err = service.Session(context.Background(), session.ID)
		checkSessionAPIStatus(t, err, http.StatusServiceUnavailable)
		if platform.calls() != 1 {
			t.Fatal("unknown remote refresh was automatically resent")
		}
	})
	t.Run("logout revokes locally before late refresh and late me", func(t *testing.T) {
		fixture := newFixture(t)
		session := seedRefreshingSession(t, fixture)
		platform := newRotatingAccountServer(t)
		platform.refreshRelease = make(chan struct{})
		service := NewService(fixture.store, platform.client(), time.Hour, time.Hour)
		finished := make(chan error, 1)
		go func() { _, err := service.Session(context.Background(), session.ID); finished <- err }()
		select {
		case <-platform.refreshEntered:
		case <-time.After(3 * time.Second):
			t.Fatal("refresh did not start")
		}
		if err := service.Logout(context.Background(), session.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.store.GetSession(context.Background(), session.ID); !errors.Is(err, ErrNotFound) {
			t.Fatalf("logout left access live: %v", err)
		}
		close(platform.refreshRelease)
		select {
		case err := <-finished:
			checkSessionAPIStatus(t, err, http.StatusUnauthorized)
		case <-time.After(3 * time.Second):
			t.Fatal("late refresh did not finish")
		}
		if _, err := fixture.store.GetSession(context.Background(), session.ID); !errors.Is(err, ErrNotFound) {
			t.Fatal("late refresh revived session")
		}
		platform.mu.Lock()
		newRevoked := platform.revoked["new-refresh-original-refresh"]
		platform.mu.Unlock()
		if !newRevoked {
			t.Fatal("late issued credentials were not revoked")
		}
	})
	t.Run("upstream logout failure remains retryable without granting access", func(t *testing.T) {
		fixture := newFixture(t)
		session := seedRefreshingSession(t, fixture)
		platform := newRotatingAccountServer(t)
		platform.revokeFails.Store(true)
		service := NewService(fixture.store, platform.client(), time.Hour, time.Hour)
		checkSessionAPIStatus(t, service.Logout(context.Background(), session.ID), http.StatusBadGateway)
		_, err := service.Session(context.Background(), session.ID)
		checkSessionAPIStatus(t, err, http.StatusUnauthorized)
		identity, err := service.SessionForLogout(context.Background(), session.ID)
		if err != nil || identity.UserID != session.UserID || identity.AccessToken != "" || identity.RefreshToken != "" {
			t.Fatalf("logout retry identity: %+v %v", identity, err)
		}
		platform.revokeFails.Store(false)
		if err := service.Logout(context.Background(), session.ID); err != nil {
			t.Fatal(err)
		}
		if _, err := service.SessionForLogout(context.Background(), session.ID); err == nil {
			t.Fatal("completed cleanup retained logout authority")
		}
	})
	t.Run("failed local logout does not claim revocation or call upstream", func(t *testing.T) {
		fixture := newFixture(t)
		session := seedRefreshingSession(t, fixture)
		session.AccessExpiresAt = time.Now().Add(time.Hour)
		if err := fixture.store.PutSession(context.Background(), session); err != nil {
			t.Fatal(err)
		}
		platform := newRotatingAccountServer(t)
		store := &faultSessionStore{Store: fixture.store, failAction: "revoke", remaining: 1}
		service := NewService(store, platform.client(), time.Hour, time.Hour)
		checkSessionAPIStatus(t, service.Logout(context.Background(), session.ID), http.StatusServiceUnavailable)
		if _, err := service.Session(context.Background(), session.ID); err != nil {
			t.Fatalf("failed logout silently revoked local session: %v", err)
		}
		platform.mu.Lock()
		revoked := len(platform.revoked)
		platform.mu.Unlock()
		if revoked != 0 {
			t.Fatal("upstream was revoked before local permission removal succeeded")
		}
		if err := service.Logout(context.Background(), session.ID); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("identity mismatch cannot switch the session account", func(t *testing.T) {
		fixture := newFixture(t)
		session := seedRefreshingSession(t, fixture)
		platform := newRotatingAccountServer(t)
		platform.wrongIdentity.Store(true)
		service := NewService(fixture.store, platform.client(), time.Hour, time.Hour)
		_, err := service.Session(context.Background(), session.ID)
		checkSessionAPIStatus(t, err, http.StatusBadGateway)
		if _, err := fixture.store.GetSession(context.Background(), session.ID); !errors.Is(err, ErrNotFound) {
			t.Fatal("mismatched refresh identity remained authorized")
		}
	})
	t.Run("late profile response preserves rotated tokens and cannot revive logout", func(t *testing.T) {
		fixture := newFixture(t)
		session := seedRefreshingSession(t, fixture)
		platform := newRotatingAccountServer(t)
		platform.meRelease = make(chan struct{})
		platform.meRejectOriginal.Store(true)
		service := NewService(fixture.store, platform.client(), time.Hour, time.Hour)
		profileDone := make(chan error, 1)
		go func() { _, err := service.RefreshUser(context.Background(), session); profileDone <- err }()
		select {
		case <-platform.meEntered:
		case <-time.After(3 * time.Second):
			t.Fatal("profile read did not start")
		}
		if _, err := service.Refresh(context.Background(), session.ID); err != nil {
			t.Fatal(err)
		}
		close(platform.meRelease)
		select {
		case err := <-profileDone:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("profile read did not finish")
		}
		current, err := fixture.store.GetSession(context.Background(), session.ID)
		if err != nil || current.RefreshToken != "new-refresh-original-refresh" {
			t.Fatal("late profile overwrote rotated credentials")
		}
		// Repeat using the original token snapshot and finish logout first.
		platform.meOnce = sync.Once{}
		platform.meEntered = make(chan struct{})
		platform.meRelease = make(chan struct{})
		go func() { _, err := service.RefreshUser(context.Background(), session); profileDone <- err }()
		select {
		case <-platform.meEntered:
		case <-time.After(3 * time.Second):
			t.Fatal("second profile read did not start")
		}
		if err := service.Logout(context.Background(), session.ID); err != nil {
			t.Fatal(err)
		}
		close(platform.meRelease)
		select {
		case err := <-profileDone:
			checkSessionAPIStatus(t, err, http.StatusUnauthorized)
		case <-time.After(3 * time.Second):
			t.Fatal("second profile read did not finish")
		}
		if _, err := fixture.store.GetSession(context.Background(), session.ID); !errors.Is(err, ErrNotFound) {
			t.Fatal("late profile revived logged out session")
		}
	})
}
