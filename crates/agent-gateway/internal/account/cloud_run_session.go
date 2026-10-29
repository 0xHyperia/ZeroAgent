package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// A run persists an uncredentialed lookup reference, never the browser's bearer
// cookie. Only the private account store can resolve it to a live session.
func cloudSessionReference(id string) string {
	digest := sha256.Sum256([]byte(id))
	return hex.EncodeToString(digest[:])
}

func cloudSessionReferenceKey(ref string) string { return "zeroagent:cloud-session-ref:" + ref }

type cloudRunSessionStore interface {
	BindCloudRunSession(context.Context, *Session) (string, error)
	GetCloudRunSession(context.Context, string) (*Session, error)
}

func (s *MemoryStore) BindCloudRunSession(ctx context.Context, session *Session) (string, error) {
	if session == nil {
		return "", ErrNotFound
	}
	current, err := s.GetSession(ctx, session.ID)
	if err != nil || current.UserID != session.UserID {
		return "", ErrNotFound
	}
	return cloudSessionReference(session.ID), nil
}

func (s *MemoryStore) GetCloudRunSession(_ context.Context, ref string) (*Session, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, session := range s.sessions {
		if session.SessionExpiresAt.After(s.now()) && cloudSessionReference(session.ID) == ref {
			copy := cloneSession(session)
			return &copy, nil
		}
	}
	return nil, ErrNotFound
}

var bindCloudRunSessionScript = redis.NewScript(`
local session = redis.call('GET', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if not session or ttl <= 0 then return 0 end
local owner = cjson.decode(session)
if tostring(owner.user_id) ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[2], ARGV[1], 'PX', ttl)
return 1
`)

func (s *PersistentStore) BindCloudRunSession(ctx context.Context, session *Session) (string, error) {
	if session == nil {
		return "", ErrNotFound
	}
	ref := cloudSessionReference(session.ID)
	bound, err := bindCloudRunSessionScript.Run(ctx, s.rdb, []string{sessionKey(session.ID), cloudSessionReferenceKey(ref)}, session.ID, session.UserID).Int()
	if err != nil {
		return "", err
	}
	if bound != 1 {
		return "", ErrNotFound
	}
	return ref, nil
}

func (s *PersistentStore) GetCloudRunSession(ctx context.Context, ref string) (*Session, error) {
	if len(ref) != 64 || strings.TrimSpace(ref) != ref {
		return nil, ErrNotFound
	}
	id, err := s.rdb.Get(ctx, cloudSessionReferenceKey(ref)).Result()
	if err == redis.Nil {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if cloudSessionReference(id) != ref {
		return nil, ErrNotFound
	}
	session, err := s.GetSession(ctx, id)
	if err != nil {
		return nil, err
	}
	if !session.SessionExpiresAt.After(time.Now()) {
		return nil, ErrNotFound
	}
	return session, nil
}
