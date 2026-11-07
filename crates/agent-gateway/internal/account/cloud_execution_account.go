package account

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"

	"github.com/google/uuid"
)

const desktopCloudExecutionPurpose = "desktop_cloud_execution"

// Plans store account-owned work. The account index points to existing Gateway
// sessions through the same private references used by ordinary Cloud Runs.
func (s *Service) rememberCloudExecutionSession(ctx context.Context, store *PersistentStore, session *Session) error {
	ref, err := store.BindCloudRunSession(ctx, session)
	if errors.Is(err, ErrNotFound) {
		return sessionMissingError()
	}
	if err != nil {
		return err
	}
	source := "web"
	var refreshAt *time.Time
	if session.Purpose == desktopCloudExecutionPurpose {
		source = "desktop"
		next := s.now().UTC().Add(8 * time.Hour)
		refreshAt = &next
	}
	_, err = store.db.ExecContext(ctx, `INSERT INTO zeroagent_cloud_execution_accounts(user_id,source,session_ref,refresh_at)
 VALUES ($1,$2,$3,$4) ON CONFLICT(user_id,source) DO UPDATE
 SET session_ref=EXCLUDED.session_ref,refresh_at=EXCLUDED.refresh_at`, session.UserID, source, ref, refreshAt)
	return err
}

func cloudExecutionSessionUnavailable(err error) bool {
	var api *APIError
	return errors.Is(err, ErrNotFound) || (errors.As(err, &api) &&
		(api.Status == http.StatusUnauthorized || api.Status == http.StatusForbidden))
}

func (s *Service) verifyCloudExecutionSession(ctx context.Context, id string, uid int64) (*Session, error) {
	session, err := s.Session(ctx, id)
	if err != nil {
		return nil, err
	}
	if session.UserID != uid {
		return nil, sessionMissingError()
	}
	if session.IsOAuth() && !isDesktopCloudPurpose(session.Purpose) {
		user, err := s.usa.AppMe(ctx, session.AccessToken)
		if err != nil {
			return nil, err
		}
		if !sessionUserMatches(user, uid) {
			return nil, sessionMissingError()
		}
	}
	return session, nil
}

func (s *Service) cloudExecutionSession(ctx context.Context, store *PersistentStore, uid int64) (*Session, bool, error) {
	rows, err := store.db.QueryContext(ctx, `SELECT session_ref FROM zeroagent_cloud_execution_accounts
 WHERE user_id=$1 ORDER BY source DESC`, uid)
	if err != nil {
		return nil, false, err
	}
	var refs []string
	for rows.Next() {
		var ref string
		if err := rows.Scan(&ref); err != nil {
			rows.Close()
			return nil, false, err
		}
		refs = append(refs, ref)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	var temporary error
	for _, ref := range refs {
		session, err := store.GetCloudRunSession(ctx, ref)
		if err == nil && session.UserID == uid && (session.Purpose == "" || session.Purpose == desktopCloudExecutionPurpose) {
			session, err = s.verifyCloudExecutionSession(ctx, session.ID, uid)
			if err == nil {
				return session, true, nil
			}
		}
		if err != nil && !cloudExecutionSessionUnavailable(err) {
			temporary = err
		}
	}
	if temporary != nil {
		return nil, len(refs) > 0, temporary
	}
	return nil, len(refs) > 0, sessionMissingError()
}

// Desktop refresh tokens remain in the native client. If an ordinary Gateway
// session is already available, reuse it. Otherwise the existing first-party
// exchange derives cloud access from the current desktop login without consent.
func (s *Service) ensureCloudExecutionAccount(ctx context.Context, store *PersistentStore, actor *Session) error {
	if actor.Purpose == "" {
		return s.rememberCloudExecutionSession(ctx, store, actor)
	}
	if actor.Purpose != desktopCloudAccessPurpose {
		return sessionMissingError()
	}
	if _, _, err := s.cloudExecutionSession(ctx, store, actor.UserID); err == nil {
		return nil
	} else if !cloudExecutionSessionUnavailable(err) {
		return err
	}
	return s.exchangeDesktopExecutionSession(ctx, store, actor)
}

func (s *Service) exchangeDesktopExecutionSession(ctx context.Context, store *PersistentStore, actor *Session) error {
	tokens, err := s.usa.ExchangeDesktopCloud(ctx, actor.AccessToken)
	if err != nil {
		var api *APIError
		if errors.As(err, &api) && (api.Reason == "unsupported_grant_type" || api.Reason == "invalid_client") {
			return &APIError{Status: http.StatusServiceUnavailable, Reason: "cloud_execution_unavailable", Message: "The current account service does not support cloud execution from the desktop"}
		}
		return err
	}
	if tokens.RefreshToken == "" || tokens.ExpiresIn <= 0 {
		return sessionStorageError()
	}
	user, err := s.usa.AppMe(ctx, tokens.AccessToken)
	if err != nil {
		return err
	}
	if !sessionUserMatches(user, actor.UserID) {
		return sessionMissingError()
	}
	session := &Session{
		ID: uuid.NewString(), UserID: actor.UserID, User: markOAuthUser(user),
		AccessToken: tokens.AccessToken, RefreshToken: tokens.RefreshToken,
		AccessExpiresAt: s.accessExpiry(tokens.ExpiresIn), SessionExpiresAt: s.now().UTC().Add(s.sessionTTL),
		AuthKind: AuthKindOAuth, OAuthClientID: "zeroagent-web", Purpose: desktopCloudExecutionPurpose,
	}
	if err := store.PutSession(ctx, session); err != nil {
		return err
	}
	return s.rememberCloudExecutionSession(ctx, store, session)
}

// The desktop exchange's refresh window is shorter than the lifetime of a plan.
// Refresh eligible existing sessions ahead of that window, even on idle days.
func (s *Service) refreshCloudExecutionAccount(ctx context.Context, store *PersistentStore) error {
	var uid int64
	var ref string
	now := s.now().UTC()
	err := store.db.QueryRowContext(ctx, `WITH due AS (
 SELECT a.user_id,a.source FROM zeroagent_cloud_execution_accounts a
 WHERE a.refresh_at <= $1 AND EXISTS (
  SELECT 1 FROM zeroagent_cloud_schedules s WHERE s.user_id=a.user_id AND s.enabled AND s.next_at IS NOT NULL AND s.deleted_at IS NULL
 ) ORDER BY a.refresh_at LIMIT 1 FOR UPDATE SKIP LOCKED
) UPDATE zeroagent_cloud_execution_accounts a SET refresh_at=$2 FROM due
 WHERE a.user_id=due.user_id AND a.source=due.source RETURNING a.user_id,a.session_ref`, now, now.Add(15*time.Minute)).Scan(&uid, &ref)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	session, err := store.GetCloudRunSession(ctx, ref)
	if err == nil {
		if session.UserID != uid || session.Purpose != desktopCloudExecutionPurpose {
			return sessionMissingError()
		}
		_, err = s.Refresh(ctx, session.ID)
	}
	var next *time.Time
	if err == nil {
		at := now.Add(8 * time.Hour)
		next = &at
	} else if !cloudExecutionSessionUnavailable(err) {
		return err
	}
	_, err = store.db.ExecContext(ctx, `UPDATE zeroagent_cloud_execution_accounts SET refresh_at=$3
 WHERE user_id=$1 AND session_ref=$2`, uid, ref, next)
	return err
}
