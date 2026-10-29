package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

const sessionRefreshLease = 45 * time.Second

var (
	errSessionAuthorityBusy     = errors.New("account session refresh is already running")
	errSessionAuthorityConflict = errors.New("account session authority changed")
)

// These private records contain credentials and are stored only alongside the
// existing trusted account-session store. Never serialize them to HTTP or Run.
type sessionRefreshRecord struct {
	ID          string
	State       string
	BaseVersion string
	Candidate   *Session
	ExpiresAt   time.Time
}

type sessionRevocationRecord struct {
	ID        string
	UserID    int64
	Sessions  []Session
	ExpiresAt time.Time
}

type sessionAuthoritySnapshot struct {
	Session    *Session
	Refresh    *sessionRefreshRecord
	Revocation *sessionRevocationRecord
	LockOwner  string
	LockUntil  time.Time
}

type sessionAuthorityCommand struct {
	Action               string
	Owner                string
	ExpectedVersion      string
	ExpectedRefreshID    string
	CandidateVersion     string
	Refresh              *sessionRefreshRecord
	Candidate            *Session
	UserID               int64
	User                 json.RawMessage
	ExpectedRevocationID string
}

type sessionAuthorityStore interface {
	ReadSessionAuthority(context.Context, string) (*sessionAuthoritySnapshot, error)
	ApplySessionAuthority(context.Context, string, sessionAuthorityCommand) (*sessionAuthoritySnapshot, error)
}

type memorySessionRefreshState struct {
	records map[string]*sessionAuthoritySnapshot
}

func sessionCredentialVersion(session *Session) string {
	if session == nil {
		return ""
	}
	copy := cloneSession(*session)
	copy.User = nil
	encoded, _ := json.Marshal(copy)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func copySession(session *Session) *Session {
	if session == nil {
		return nil
	}
	copy := cloneSession(*session)
	return &copy
}

func cloneSessionAuthority(input *sessionAuthoritySnapshot) *sessionAuthoritySnapshot {
	if input == nil {
		return &sessionAuthoritySnapshot{}
	}
	copy := *input
	copy.Session = copySession(input.Session)
	if input.Refresh != nil {
		record := *input.Refresh
		record.Candidate = copySession(record.Candidate)
		copy.Refresh = &record
	}
	if input.Revocation != nil {
		record := *input.Revocation
		record.Sessions = make([]Session, len(input.Revocation.Sessions))
		for i, session := range input.Revocation.Sessions {
			record.Sessions[i] = cloneSession(session)
		}
		copy.Revocation = &record
	}
	return &copy
}

func expireSessionAuthority(snapshot *sessionAuthoritySnapshot, now time.Time) {
	if snapshot.Session != nil && !snapshot.Session.SessionExpiresAt.After(now) {
		snapshot.Session = nil
	}
	if snapshot.Refresh != nil && !snapshot.Refresh.ExpiresAt.After(now) {
		snapshot.Refresh = nil
	}
	if snapshot.Revocation != nil && !snapshot.Revocation.ExpiresAt.After(now) {
		snapshot.Revocation = nil
	}
	if !snapshot.LockUntil.After(now) {
		snapshot.LockOwner = ""
		snapshot.LockUntil = time.Time{}
	}
}

func sessionUserMatches(user json.RawMessage, userID int64) bool {
	var identity struct {
		ID int64 `json:"id"`
	}
	return json.Unmarshal(user, &identity) == nil && identity.ID == userID && userID > 0
}

func sameSessionIdentity(a, b *Session) bool {
	return a != nil && b != nil && a.ID == b.ID && a.UserID == b.UserID && a.AuthKind == b.AuthKind && a.OAuthClientID == b.OAuthClientID && a.SessionExpiresAt.Equal(b.SessionExpiresAt)
}

func transitionSessionAuthority(input *sessionAuthoritySnapshot, id string, command sessionAuthorityCommand, now time.Time) (*sessionAuthoritySnapshot, error) {
	state := cloneSessionAuthority(input)
	expireSessionAuthority(state, now)
	if command.Action == "release" {
		if state.LockOwner == command.Owner {
			state.LockOwner = ""
			state.LockUntil = time.Time{}
		}
		return state, nil
	}
	if command.Action == "revoke" || command.Action == "add_revocation" {
		if command.ExpectedVersion != "" && state.Session != nil && sessionCredentialVersion(state.Session) != command.ExpectedVersion {
			return nil, errSessionAuthorityConflict
		}
		if command.Action == "add_revocation" && state.Session != nil && state.Revocation == nil {
			return nil, errSessionAuthorityConflict
		}
		var sessions []Session
		userID := int64(0)
		expires := now.Add(24 * time.Hour)
		if state.Revocation != nil {
			sessions = append(sessions, state.Revocation.Sessions...)
			userID = state.Revocation.UserID
			if state.Revocation.ExpiresAt.After(expires) {
				expires = state.Revocation.ExpiresAt
			}
		}
		appendSession := func(session *Session) error {
			if session == nil {
				return nil
			}
			if session.ID != id || session.UserID <= 0 || (userID != 0 && session.UserID != userID) {
				return errSessionAuthorityConflict
			}
			userID = session.UserID
			if session.SessionExpiresAt.After(expires) {
				expires = session.SessionExpiresAt
			}
			for _, previous := range sessions {
				if previous.AccessToken == session.AccessToken && previous.RefreshToken == session.RefreshToken {
					return nil
				}
			}
			sessions = append(sessions, cloneSession(*session))
			return nil
		}
		if err := appendSession(state.Session); err != nil {
			return nil, err
		}
		if state.Refresh != nil {
			if err := appendSession(state.Refresh.Candidate); err != nil {
				return nil, err
			}
		}
		if err := appendSession(command.Candidate); err != nil {
			return nil, err
		}
		if len(sessions) > 16 {
			return nil, errSessionAuthorityConflict
		}
		state.Session, state.Refresh, state.LockOwner, state.LockUntil = nil, nil, "", time.Time{}
		if len(sessions) > 0 {
			state.Revocation = &sessionRevocationRecord{ID: uuid.NewString(), UserID: userID, Sessions: sessions, ExpiresAt: expires}
		}
		return state, nil
	}
	if command.Action == "clear_revocation" {
		if state.Revocation == nil {
			return state, nil
		}
		if state.Revocation.ID != command.ExpectedRevocationID {
			return nil, errSessionAuthorityConflict
		}
		state.Revocation = nil
		return state, nil
	}
	if state.Session == nil || state.Revocation != nil {
		return nil, ErrNotFound
	}
	if command.Action == "update_user" {
		if state.Session.UserID != command.UserID || !sessionUserMatches(command.User, command.UserID) {
			return nil, errSessionAuthorityConflict
		}
		if command.ExpectedVersion != "" && sessionCredentialVersion(state.Session) != command.ExpectedVersion {
			return nil, errSessionAuthorityConflict
		}
		state.Session.User = append(json.RawMessage(nil), command.User...)
		return state, nil
	}
	if strings.TrimSpace(command.Owner) == "" {
		return nil, errSessionAuthorityConflict
	}
	if command.Action == "acquire" {
		if state.LockOwner != "" && state.LockOwner != command.Owner {
			return nil, errSessionAuthorityBusy
		}
		state.LockOwner, state.LockUntil = command.Owner, now.Add(sessionRefreshLease)
		return state, nil
	}
	if state.LockOwner != command.Owner || !state.LockUntil.After(now) {
		return nil, errSessionAuthorityConflict
	}
	if sessionCredentialVersion(state.Session) != command.ExpectedVersion {
		return nil, errSessionAuthorityConflict
	}
	switch command.Action {
	case "begin":
		if state.Refresh != nil && (state.Refresh.ID != command.ExpectedRefreshID || state.Refresh.State != "pending") {
			return nil, errSessionAuthorityConflict
		}
		if state.Refresh == nil && command.ExpectedRefreshID != "" {
			return nil, errSessionAuthorityConflict
		}
		if command.Refresh == nil || command.Refresh.ID == "" || command.Refresh.BaseVersion != command.ExpectedVersion {
			return nil, errSessionAuthorityConflict
		}
		if command.Refresh.Candidate != nil && !sameSessionIdentity(command.Refresh.Candidate, state.Session) {
			return nil, errSessionAuthorityConflict
		}
		copy := *command.Refresh
		copy.State = "inflight"
		copy.Candidate = copySession(copy.Candidate)
		copy.ExpiresAt = state.Session.SessionExpiresAt
		state.Refresh = &copy
	case "stage":
		if state.Refresh == nil || state.Refresh.ID != command.ExpectedRefreshID || state.Refresh.BaseVersion != command.ExpectedVersion || !sameSessionIdentity(command.Candidate, state.Session) {
			return nil, errSessionAuthorityConflict
		}
		state.Refresh.State = "pending"
		state.Refresh.Candidate = copySession(command.Candidate)
	case "unknown":
		if state.Refresh == nil || state.Refresh.ID != command.ExpectedRefreshID {
			return nil, errSessionAuthorityConflict
		}
		state.Refresh.State = "unknown"
	case "commit":
		if state.Refresh == nil || state.Refresh.ID != command.ExpectedRefreshID || state.Refresh.State != "pending" ||
			state.Refresh.BaseVersion != command.ExpectedVersion || !sameSessionIdentity(state.Refresh.Candidate, state.Session) ||
			sessionCredentialVersion(state.Refresh.Candidate) != command.CandidateVersion {
			return nil, errSessionAuthorityConflict
		}
		state.Session = copySession(state.Refresh.Candidate)
		state.Refresh = nil
	default:
		return nil, errSessionAuthorityConflict
	}
	return state, nil
}

func (s *MemoryStore) sessionAuthorityLocked(id string) *sessionAuthoritySnapshot {
	var state *sessionAuthoritySnapshot
	if s.sessionRefresh != nil {
		state = s.sessionRefresh.records[id]
	}
	copy := cloneSessionAuthority(state)
	if session, ok := s.sessions[id]; ok {
		copy.Session = copySession(&session)
	} else {
		copy.Session = nil
	}
	expireSessionAuthority(copy, s.now())
	return copy
}

func (s *MemoryStore) ReadSessionAuthority(ctx context.Context, id string) (*sessionAuthoritySnapshot, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.sessionAuthorityLocked(id), nil
}

func (s *MemoryStore) ApplySessionAuthority(ctx context.Context, id string, command sessionAuthorityCommand) (*sessionAuthoritySnapshot, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state, err := transitionSessionAuthority(s.sessionAuthorityLocked(id), id, command, s.now())
	if err != nil {
		return nil, err
	}
	if state.Session == nil {
		delete(s.sessions, id)
	} else {
		s.sessions[id] = cloneSession(*state.Session)
	}
	if s.sessionRefresh == nil {
		s.sessionRefresh = &memorySessionRefreshState{records: make(map[string]*sessionAuthoritySnapshot)}
	}
	stored := cloneSessionAuthority(state)
	stored.Session = nil
	if stored.Refresh == nil && stored.Revocation == nil && stored.LockOwner == "" {
		delete(s.sessionRefresh.records, id)
	} else {
		s.sessionRefresh.records[id] = stored
	}
	return cloneSessionAuthority(state), nil
}

func sessionAuthorityKeys(id string) []string {
	ref := cloudSessionReference(id)
	return []string{sessionKey(id), "zeroagent:session-refresh:" + ref, "zeroagent:session-revocation:" + ref, "zeroagent:session-refresh-lock:" + ref, cloudSessionReferenceKey(ref)}
}

type sessionAuthorityRedisReader interface {
	MGet(context.Context, ...string) *redis.SliceCmd
	Time(context.Context) *redis.TimeCmd
}

func readRedisSessionAuthority(ctx context.Context, reader sessionAuthorityRedisReader, keys []string) (*sessionAuthoritySnapshot, time.Time, error) {
	values, err := reader.MGet(ctx, keys[:4]...).Result()
	if err != nil {
		return nil, time.Time{}, err
	}
	now, err := reader.Time(ctx).Result()
	if err != nil {
		return nil, time.Time{}, err
	}
	state := &sessionAuthoritySnapshot{}
	for index, target := range []any{&state.Session, &state.Refresh, &state.Revocation} {
		if values[index] != nil {
			raw, ok := values[index].(string)
			if !ok || json.Unmarshal([]byte(raw), target) != nil {
				return nil, time.Time{}, errors.New("invalid private account session state")
			}
		}
	}
	if values[3] != nil {
		raw, ok := values[3].(string)
		if !ok {
			return nil, time.Time{}, errors.New("invalid account refresh lock")
		}
		var lock struct {
			Owner string
			Until time.Time
		}
		if json.Unmarshal([]byte(raw), &lock) != nil {
			return nil, time.Time{}, errors.New("invalid account refresh lock")
		}
		state.LockOwner, state.LockUntil = lock.Owner, lock.Until
	}
	expireSessionAuthority(state, now)
	return state, now, nil
}

func (s *PersistentStore) ReadSessionAuthority(ctx context.Context, id string) (*sessionAuthoritySnapshot, error) {
	state, _, err := readRedisSessionAuthority(ctx, s.rdb, sessionAuthorityKeys(id))
	return state, err
}

func (s *PersistentStore) ApplySessionAuthority(ctx context.Context, id string, command sessionAuthorityCommand) (*sessionAuthoritySnapshot, error) {
	keys := sessionAuthorityKeys(id)
	for attempt := 0; attempt < 24; attempt++ {
		var result *sessionAuthoritySnapshot
		err := s.rdb.Watch(ctx, func(tx *redis.Tx) error {
			before, now, err := readRedisSessionAuthority(ctx, tx, keys)
			if err != nil {
				return err
			}
			after, err := transitionSessionAuthority(before, id, command, now)
			if err != nil {
				return err
			}
			_, err = tx.TxPipelined(ctx, func(pipe redis.Pipeliner) error {
				write := func(key string, value any, expires time.Time) error {
					if value == nil || !expires.After(now) {
						pipe.Del(ctx, key)
						return nil
					}
					encoded, err := json.Marshal(value)
					if err != nil {
						return err
					}
					pipe.Set(ctx, key, encoded, expires.Sub(now))
					return nil
				}
				if after.Session == nil {
					pipe.Del(ctx, keys[0], keys[4])
				} else {
					if err := write(keys[0], after.Session, after.Session.SessionExpiresAt); err != nil {
						return err
					}
				}
				if after.Refresh == nil {
					pipe.Del(ctx, keys[1])
				} else if err := write(keys[1], after.Refresh, after.Refresh.ExpiresAt); err != nil {
					return err
				}
				if after.Revocation == nil {
					pipe.Del(ctx, keys[2])
				} else if err := write(keys[2], after.Revocation, after.Revocation.ExpiresAt); err != nil {
					return err
				}
				if after.LockOwner == "" {
					pipe.Del(ctx, keys[3])
				} else if err := write(keys[3], struct {
					Owner string
					Until time.Time
				}{after.LockOwner, after.LockUntil}, after.LockUntil); err != nil {
					return err
				}
				return nil
			})
			if err == nil {
				result = after
			}
			return err
		}, keys...)
		if !errors.Is(err, redis.TxFailedErr) {
			return result, err
		}
		timer := time.NewTimer(time.Duration(attempt+1) * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
	return nil, errSessionAuthorityBusy
}

var _ sessionAuthorityStore = (*MemoryStore)(nil)
var _ sessionAuthorityStore = (*PersistentStore)(nil)
