package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
)

func sessionMissingError() error {
	return &APIError{Status: http.StatusUnauthorized, Reason: "account_session_expired", Message: "account session is missing or expired"}
}
func sessionStorageError() error {
	return &APIError{Status: http.StatusServiceUnavailable, Reason: "account_session_unavailable", Message: "account session storage is temporarily unavailable"}
}

// SessionForLogout exposes only the original identity to the logout handler. A
// locally revoked session may retry upstream cleanup, but cannot authorize any
// other request through Session or the cloud-session reference index.
func (s *Service) SessionForLogout(ctx context.Context, id string) (*Session, error) {
	id = strings.TrimSpace(id)
	if strings.HasPrefix(id, desktopCloudAccessPrefix) {
		return nil, sessionMissingError()
	}
	state, err := s.store.ReadSessionAuthority(ctx, id)
	if err != nil {
		return nil, sessionStorageError()
	}
	if state.Revocation != nil {
		return &Session{ID: id, UserID: state.Revocation.UserID, SessionExpiresAt: state.Revocation.ExpiresAt}, nil
	}
	if state.Session == nil {
		return nil, sessionMissingError()
	}
	return &Session{ID: id, UserID: state.Session.UserID, SessionExpiresAt: state.Session.SessionExpiresAt}, nil
}

func sessionPlatformTemporaryError(err error) error {
	var api *APIError
	if errors.As(err, &api) && api.Status == http.StatusTooManyRequests {
		return &APIError{Status: http.StatusTooManyRequests, Reason: "account_service_rate_limited", Message: "USA-Zero account service is temporarily rate limited"}
	}
	return &APIError{Status: http.StatusBadGateway, Reason: "account_service_unavailable", Message: "USA-Zero account service is temporarily unavailable"}
}

type sessionRefreshCoordinator struct {
	gate    chan struct{}
	revoked atomic.Bool
	mu      sync.Mutex
	pending *sessionRefreshRecord
}

func (s *Service) sessionCoordinator(id string) *sessionRefreshCoordinator {
	value, _ := s.refreshLocks.LoadOrStore(id, &sessionRefreshCoordinator{gate: make(chan struct{}, 1)})
	return value.(*sessionRefreshCoordinator)
}

func (c *sessionRefreshCoordinator) candidate() *sessionRefreshRecord {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.pending == nil {
		return nil
	}
	copy := *c.pending
	copy.Candidate = copySession(copy.Candidate)
	return &copy
}

func (c *sessionRefreshCoordinator) remember(record *sessionRefreshRecord) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if record == nil {
		c.pending = nil
		return
	}
	copy := *record
	copy.Candidate = copySession(copy.Candidate)
	c.pending = &copy
}

func sessionDefiniteRejection(err error) bool {
	var api *APIError
	return errors.As(err, &api) && (api.Status == http.StatusUnauthorized || api.Status == http.StatusForbidden || api.Reason == "invalid_grant" || api.Reason == "invalid_token")
}

func sessionUnknownRefreshError() error {
	return &APIError{Status: http.StatusServiceUnavailable, Reason: "account_refresh_result_unknown", Message: "account refresh could not be confirmed; sign in again to continue"}
}

func (s *Service) coordinatedSession(ctx context.Context, id string, force bool) (*Session, error) {
	id = strings.TrimSpace(id)
	initial, err := s.store.ReadSessionAuthority(ctx, id)
	if err != nil {
		return nil, sessionStorageError()
	}
	if initial.Session == nil || initial.Revocation != nil {
		return nil, sessionMissingError()
	}
	if !force && initial.Refresh == nil && initial.Session.AccessExpiresAt.After(s.now().Add(30*time.Second)) {
		return copySession(initial.Session), nil
	}
	observed := sessionCredentialVersion(initial.Session)
	coordinator := s.sessionCoordinator(id)
	select {
	case coordinator.gate <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-coordinator.gate }()
	if coordinator.revoked.Load() {
		return nil, sessionMissingError()
	}
	owner := uuid.NewString()
	acquired := false
	for {
		state, err := s.store.ReadSessionAuthority(ctx, id)
		if err != nil {
			return nil, sessionStorageError()
		}
		if state.Session == nil || state.Revocation != nil {
			return nil, sessionMissingError()
		}
		if state.Refresh == nil && state.Session.AccessExpiresAt.After(s.now().Add(30*time.Second)) && (!force || sessionCredentialVersion(state.Session) != observed) {
			coordinator.remember(nil)
			return copySession(state.Session), nil
		}
		_, err = s.store.ApplySessionAuthority(ctx, id, sessionAuthorityCommand{Action: "acquire", Owner: owner})
		if err == nil {
			acquired = true
			break
		}
		if errors.Is(err, ErrNotFound) {
			return nil, sessionMissingError()
		}
		if !errors.Is(err, errSessionAuthorityBusy) {
			return nil, sessionStorageError()
		}
		timer := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	if acquired {
		defer func() {
			releaseCtx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, _ = s.store.ApplySessionAuthority(releaseCtx, id, sessionAuthorityCommand{Action: "release", Owner: owner})
		}()
	}
	state, err := s.store.ReadSessionAuthority(ctx, id)
	if err != nil {
		return nil, sessionStorageError()
	}
	if state.Session == nil || state.Revocation != nil || coordinator.revoked.Load() {
		return nil, sessionMissingError()
	}
	if state.Refresh == nil && state.Session.AccessExpiresAt.After(s.now().Add(30*time.Second)) && (!force || sessionCredentialVersion(state.Session) != observed) {
		coordinator.remember(nil)
		return copySession(state.Session), nil
	}
	baseVersion := sessionCredentialVersion(state.Session)
	// A candidate received before a storage failure remains private to this
	// process. Stage it before considering any additional refresh request.
	if pending := coordinator.candidate(); pending != nil && pending.BaseVersion == baseVersion && state.Refresh != nil && pending.ID == state.Refresh.ID {
		state, err = s.store.ApplySessionAuthority(ctx, id, sessionAuthorityCommand{Action: "stage", Owner: owner, ExpectedVersion: baseVersion, ExpectedRefreshID: pending.ID, Candidate: pending.Candidate})
		if err != nil {
			return nil, s.sessionAuthorityError(err)
		}
	}
	if state.Refresh != nil && state.Refresh.State != "pending" {
		// An inflight/unknown marker without a recoverable candidate proves that
		// the prior token may have been consumed. Never send it a second time.
		return nil, sessionUnknownRefreshError()
	}
	source := state.Session
	if state.Refresh != nil {
		source = state.Refresh.Candidate
	}
	if source == nil {
		return nil, sessionUnknownRefreshError()
	}
	if state.Refresh == nil || !source.AccessExpiresAt.After(s.now().Add(5*time.Second)) {
		if source.RefreshToken == "" {
			if err := s.revokeSessionLocally(ctx, id, nil, baseVersion); err != nil {
				return nil, s.sessionAuthorityError(err)
			}
			return nil, sessionMissingError()
		}
		previousID := ""
		if state.Refresh != nil {
			previousID = state.Refresh.ID
		}
		record := &sessionRefreshRecord{ID: uuid.NewString(), BaseVersion: baseVersion, State: "inflight", ExpiresAt: state.Session.SessionExpiresAt}
		if state.Refresh != nil {
			record.Candidate = copySession(source)
		}
		_, err = s.store.ApplySessionAuthority(ctx, id, sessionAuthorityCommand{Action: "begin", Owner: owner, ExpectedVersion: baseVersion, ExpectedRefreshID: previousID, Refresh: record})
		if err != nil {
			return nil, s.sessionAuthorityError(err)
		}
		candidate, refreshErr := s.rotateSession(ctx, source)
		if refreshErr != nil {
			if sessionDefiniteRejection(refreshErr) {
				if err := s.revokeSessionLocally(context.Background(), id, nil, baseVersion); err != nil {
					return nil, s.sessionAuthorityError(err)
				}
				return nil, sessionMissingError()
			}
			markCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			_, _ = s.store.ApplySessionAuthority(markCtx, id, sessionAuthorityCommand{Action: "unknown", Owner: owner, ExpectedVersion: baseVersion, ExpectedRefreshID: record.ID})
			cancel()
			return nil, sessionPlatformTemporaryError(refreshErr)
		}
		record.Candidate, record.State = candidate, "pending"
		coordinator.remember(record)
		if coordinator.revoked.Load() {
			s.revokeLateSessionCandidate(id, candidate)
			return nil, sessionMissingError()
		}
		stageCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		state, err = s.store.ApplySessionAuthority(stageCtx, id, sessionAuthorityCommand{Action: "stage", Owner: owner, ExpectedVersion: baseVersion, ExpectedRefreshID: record.ID, Candidate: candidate})
		cancel()
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				s.revokeLateSessionCandidate(id, candidate)
			}
			return nil, s.sessionAuthorityError(err)
		}
	}
	if state.Refresh == nil || state.Refresh.Candidate == nil {
		return nil, sessionUnknownRefreshError()
	}
	candidate := copySession(state.Refresh.Candidate)
	user, verifyErr := s.verifyRefreshedSession(ctx, candidate)
	if verifyErr != nil {
		if sessionDefiniteRejection(verifyErr) {
			if err := s.revokeSessionLocally(context.Background(), id, candidate, baseVersion); err != nil {
				return nil, s.sessionAuthorityError(err)
			}
			s.revokeLateSessionCandidate(id, candidate)
			return nil, sessionMissingError()
		}
		return nil, sessionPlatformTemporaryError(verifyErr)
	}
	if !sessionUserMatches(user, state.Session.UserID) {
		if err := s.revokeSessionLocally(context.Background(), id, candidate, baseVersion); err != nil {
			return nil, s.sessionAuthorityError(err)
		}
		s.revokeLateSessionCandidate(id, candidate)
		return nil, &APIError{Status: http.StatusBadGateway, Reason: "account_identity_mismatch", Message: "USA-Zero refreshed account identity did not match the original session"}
	}
	candidate.User = user
	// Save the verified candidate under the same attempt before committing it.
	verified := *state.Refresh
	verified.Candidate = candidate
	coordinator.remember(&verified)
	_, err = s.store.ApplySessionAuthority(ctx, id, sessionAuthorityCommand{Action: "stage", Owner: owner, ExpectedVersion: baseVersion, ExpectedRefreshID: verified.ID, Candidate: candidate})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			s.revokeLateSessionCandidate(id, candidate)
		}
		return nil, s.sessionAuthorityError(err)
	}
	state, err = s.store.ApplySessionAuthority(ctx, id, sessionAuthorityCommand{Action: "commit", Owner: owner, ExpectedVersion: baseVersion, ExpectedRefreshID: verified.ID, CandidateVersion: sessionCredentialVersion(candidate)})
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			s.revokeLateSessionCandidate(id, candidate)
		}
		return nil, s.sessionAuthorityError(err)
	}
	coordinator.remember(nil)
	return copySession(state.Session), nil
}

func (s *Service) sessionAuthorityError(err error) error {
	if errors.Is(err, ErrNotFound) {
		return sessionMissingError()
	}
	return sessionStorageError()
}

func (s *Service) rotateSession(ctx context.Context, source *Session) (*Session, error) {
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	candidate := copySession(source)
	var expires int
	if source.IsOAuth() {
		result, err := s.usa.RefreshApp(callCtx, source.OAuthClientID, source.RefreshToken)
		if err != nil {
			return nil, err
		}
		if result.TokenType != "" && !strings.EqualFold(result.TokenType, "Bearer") {
			return nil, errors.New("invalid refreshed token type")
		}
		candidate.AccessToken, candidate.RefreshToken, expires = result.AccessToken, firstNonEmpty(result.RefreshToken, source.RefreshToken), result.ExpiresIn
	} else {
		result, err := s.usa.Refresh(callCtx, source.RefreshToken)
		if err != nil {
			return nil, err
		}
		candidate.AccessToken, candidate.RefreshToken, expires = result.AccessToken, firstNonEmpty(result.RefreshToken, source.RefreshToken), result.ExpiresIn
	}
	if candidate.AccessToken == "" || len(candidate.AccessToken) > 64<<10 || strings.ContainsAny(candidate.AccessToken, "\r\n\t ") || len(candidate.RefreshToken) > 64<<10 || expires <= 0 || expires > 366*24*3600 {
		return nil, errors.New("invalid refreshed credential response")
	}
	candidate.AccessExpiresAt = s.now().UTC().Add(time.Duration(expires) * time.Second)
	return candidate, nil
}

func (s *Service) verifyRefreshedSession(ctx context.Context, session *Session) (json.RawMessage, error) {
	callCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if session.IsOAuth() {
		user, err := s.usa.AppMe(callCtx, session.AccessToken)
		if err != nil {
			return nil, err
		}
		return markOAuthUser(user), nil
	}
	return s.usa.Me(callCtx, session.AccessToken)
}

func (s *Service) revokeSessionLocally(ctx context.Context, id string, candidate *Session, expectedVersion string) error {
	localCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	_, err := s.store.ApplySessionAuthority(localCtx, id, sessionAuthorityCommand{Action: "revoke", Candidate: candidate, ExpectedVersion: expectedVersion})
	if err == nil {
		s.sessionCoordinator(id).revoked.Store(true)
	}
	return err
}

func (s *Service) revokeLateSessionCandidate(id string, candidate *Session) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	state, err := s.store.ApplySessionAuthority(ctx, id, sessionAuthorityCommand{Action: "add_revocation", Candidate: candidate})
	if err != nil {
		return
	}
	_ = s.finishSessionRevocation(ctx, id, state.Revocation)
}

func (s *Service) finishSessionRevocation(ctx context.Context, id string, record *sessionRevocationRecord) error {
	if record == nil {
		return nil
	}
	for _, session := range record.Sessions {
		// Native owns desktop authorization and revocation of its token family.
		if isDesktopCloudPurpose(session.Purpose) {
			continue
		}
		if session.IsOAuth() {
			if session.RefreshToken != "" {
				if err := s.usa.RevokeApp(ctx, session.RefreshToken, "refresh_token"); err != nil {
					return sessionPlatformTemporaryError(err)
				}
			}
			if session.AccessToken != "" {
				if err := s.usa.RevokeApp(ctx, session.AccessToken, "access_token"); err != nil {
					return sessionPlatformTemporaryError(err)
				}
			}
		} else if session.RefreshToken != "" {
			if err := s.usa.Logout(ctx, session.RefreshToken); err != nil {
				return sessionPlatformTemporaryError(err)
			}
		}
	}
	_, err := s.store.ApplySessionAuthority(ctx, id, sessionAuthorityCommand{Action: "clear_revocation", ExpectedRevocationID: record.ID})
	if err != nil {
		return sessionStorageError()
	}
	return nil
}

func (s *Service) coordinatedLogout(ctx context.Context, id string) error {
	id = strings.TrimSpace(id)
	coordinator := s.sessionCoordinator(id)
	var candidate *Session
	if pending := coordinator.candidate(); pending != nil {
		candidate = pending.Candidate
	}
	state, err := s.store.ApplySessionAuthority(ctx, id, sessionAuthorityCommand{Action: "revoke", Candidate: candidate})
	if err != nil {
		return sessionStorageError()
	}
	coordinator.revoked.Store(true)
	if err = s.finishSessionRevocation(ctx, id, state.Revocation); err != nil {
		return err
	}
	coordinator.remember(nil)
	return nil
}

func (s *Service) coordinatedRefreshUser(ctx context.Context, session *Session) (json.RawMessage, error) {
	if session == nil {
		return nil, sessionMissingError()
	}
	source := copySession(session)
	for attempt := 0; attempt < 2; attempt++ {
		version := sessionCredentialVersion(source)
		user, err := s.verifyRefreshedSession(ctx, source)
		if err == nil && sessionUserMatches(user, source.UserID) {
			_, saveErr := s.store.ApplySessionAuthority(ctx, source.ID, sessionAuthorityCommand{Action: "update_user", UserID: source.UserID, User: user, ExpectedVersion: version})
			if saveErr == nil {
				return user, nil
			}
			if !errors.Is(saveErr, errSessionAuthorityConflict) {
				return nil, s.sessionAuthorityError(saveErr)
			}
		} else if err != nil && !sessionDefiniteRejection(err) {
			return nil, sessionPlatformTemporaryError(err)
		} else {
			state, readErr := s.store.ReadSessionAuthority(ctx, source.ID)
			if readErr != nil {
				return nil, sessionStorageError()
			}
			if state.Session == nil || state.Revocation != nil {
				return nil, sessionMissingError()
			}
			if sessionCredentialVersion(state.Session) == version {
				if revokeErr := s.revokeSessionLocally(ctx, source.ID, nil, version); revokeErr != nil {
					return nil, s.sessionAuthorityError(revokeErr)
				}
				if err != nil {
					return nil, sessionMissingError()
				}
				return nil, &APIError{Status: http.StatusBadGateway, Reason: "account_identity_mismatch", Message: "USA-Zero account identity did not match the session"}
			}
		}
		// A response using an older access token must not revoke or overwrite a
		// concurrently refreshed session. Retry the read once with current data.
		state, readErr := s.store.ReadSessionAuthority(ctx, source.ID)
		if readErr != nil {
			return nil, sessionStorageError()
		}
		if state.Session == nil || state.Revocation != nil || state.Session.UserID != source.UserID {
			return nil, sessionMissingError()
		}
		source = copySession(state.Session)
	}
	return nil, sessionStorageError()
}
