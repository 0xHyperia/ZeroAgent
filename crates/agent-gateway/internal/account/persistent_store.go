package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	_ "github.com/lib/pq"
	"github.com/redis/go-redis/v9"
)

const devicePresenceTTL = 90 * time.Second

// Presence ownership prevents a displaced Agent session from renewing or
// deleting the key claimed by its replacement, including across Gateway instances.
var renewDeviceSessionPresenceScript = redis.NewScript(`
local current = redis.call("GET", KEYS[1])
if not current then
  redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[2])
  return 1
end
if current ~= ARGV[1] then return 0 end
redis.call("PEXPIRE", KEYS[1], ARGV[2])
return 1
`)

var releaseDeviceSessionPresenceScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end
redis.call("DEL", KEYS[1])
return 1
`)

var consumeDesktopHandoffScript = redis.NewScript(`
local value = redis.call("GET", KEYS[1])
if value then redis.call("DEL", KEYS[1]) end
return value
`)

var consumeOAuthTransactionScript = redis.NewScript(`
local value = redis.call("GET", KEYS[1])
if value then redis.call("DEL", KEYS[1]) end
return value
`)

type PersistentStore struct {
	db  *sql.DB
	rdb *redis.Client
}

func OpenPersistentStore(ctx context.Context, databaseURL, redisURL string) (*PersistentStore, error) {
	databaseURL = strings.TrimSpace(databaseURL)
	redisURL = strings.TrimSpace(redisURL)
	if databaseURL == "" || redisURL == "" {
		return nil, fmt.Errorf("DATABASE_URL and REDIS_URL must both be configured for persistent account storage")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(20)
	db.SetMaxIdleConns(5)
	db.SetConnMaxLifetime(30 * time.Minute)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("connect PostgreSQL: %w", err)
	}
	options, err := redis.ParseURL(redisURL)
	if err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("parse Redis URL: %w", err)
	}
	rdb := redis.NewClient(options)
	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		_ = db.Close()
		return nil, fmt.Errorf("connect Redis: %w", err)
	}
	store := &PersistentStore{db: db, rdb: rdb}
	if err := store.migrate(ctx); err != nil {
		_ = store.Close()
		return nil, err
	}
	return store, nil
}

func (s *PersistentStore) Close() error {
	var result error
	if s.rdb != nil {
		result = errors.Join(result, s.rdb.Close())
	}
	if s.db != nil {
		result = errors.Join(result, s.db.Close())
	}
	return result
}

func (s *PersistentStore) Ready(ctx context.Context) error {
	if err := s.db.PingContext(ctx); err != nil {
		return fmt.Errorf("postgres readiness: %w", err)
	}
	if err := s.rdb.Ping(ctx).Err(); err != nil {
		return fmt.Errorf("redis readiness: %w", err)
	}
	return nil
}

func (s *PersistentStore) migrate(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS zerobox_devices (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL,
  installation_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  credential_hash TEXT NOT NULL,
  workspaces JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  UNIQUE (user_id, installation_id)
);
CREATE INDEX IF NOT EXISTS zerobox_devices_user_idx ON zerobox_devices (user_id, revoked_at);

CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  owner_user_id BIGINT NOT NULL,
  legacy_device_id UUID NULL UNIQUE,
  installation_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  token_sha256 TEXT NOT NULL,
  workspaces JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  token_issued_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ NULL,
  UNIQUE (owner_user_id, installation_id)
);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents (owner_user_id, revoked_at);
INSERT INTO agents
  (agent_id,owner_user_id,legacy_device_id,installation_id,display_name,platform,app_version,
   token_sha256,workspaces,created_at,token_issued_at,last_seen_at,revoked_at)
SELECT 'agent-' || id::text,user_id,id,installation_id,display_name,platform,app_version,
       credential_hash,workspaces,created_at,created_at,last_seen_at,revoked_at
FROM zerobox_devices
ON CONFLICT (agent_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS zerobox_conversation_routes (
  user_id BIGINT NOT NULL,
  conversation_id UUID PRIMARY KEY,
  runtime_kind TEXT NOT NULL,
  device_id UUID NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS zerobox_conversation_routes_user_idx ON zerobox_conversation_routes (user_id, updated_at DESC);
ALTER TABLE zerobox_conversation_routes ADD COLUMN IF NOT EXISTS agent_id TEXT NULL;
UPDATE zerobox_conversation_routes
SET agent_id='agent-' || device_id::text
WHERE agent_id IS NULL AND device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS zerobox_cloud_conversations (
  id UUID PRIMARY KEY,
  user_id BIGINT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS zerobox_cloud_conversations_user_idx ON zerobox_cloud_conversations (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS zeroagent_cloud_conversations_page_idx ON zerobox_cloud_conversations (user_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS zerobox_cloud_messages (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES zerobox_cloud_conversations(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL,
  role TEXT NOT NULL,
  content JSONB NOT NULL,
  usage JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS zerobox_cloud_messages_conversation_idx ON zerobox_cloud_messages (conversation_id, created_at);

CREATE TABLE IF NOT EXISTS zerobox_web_settings (
  user_id BIGINT PRIMARY KEY,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin ZeroAgent account schema migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate ZeroAgent account schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, CloudRunSchema); err != nil {
		return fmt.Errorf("migrate ZeroAgent cloud run schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, CloudImageSettingsSchema); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, CloudModelLimitsSchema); err != nil {
		return fmt.Errorf("migrate ZeroAgent cloud model preference schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, CloudToolSchema); err != nil {
		return fmt.Errorf("migrate ZeroAgent cloud tool schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, CloudResearchSourceSchema); err != nil {
		return fmt.Errorf("migrate ZeroAgent cloud source schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, CloudFileSchema); err != nil {
		return fmt.Errorf("migrate ZeroAgent cloud file schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, CloudArtifactSchema); err != nil {
		return fmt.Errorf("migrate ZeroAgent cloud artifact schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, CloudSpaceSchema); err != nil {
		return fmt.Errorf("migrate ZeroAgent cloud space schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, CloudSiteSchema); err != nil {
		return fmt.Errorf("migrate ZeroAgent cloud site schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, CloudBranchSchema); err != nil {
		return fmt.Errorf("migrate ZeroAgent cloud branch schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, CloudProjectSchema); err != nil {
		return fmt.Errorf("migrate ZeroAgent cloud project schema: %w", err)
	}
	if _, err := tx.ExecContext(ctx, CloudMemorySchema); err != nil {
		return fmt.Errorf("migrate ZeroAgent cloud memory schema: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit ZeroAgent account schema migration: %w", err)
	}
	return nil
}

func (s *PersistentStore) PutSession(ctx context.Context, session *Session) error {
	data, err := json.Marshal(session)
	if err != nil {
		return err
	}
	ttl := time.Until(session.SessionExpiresAt)
	if ttl <= 0 {
		return ErrNotFound
	}
	return s.rdb.Set(ctx, sessionKey(session.ID), data, ttl).Err()
}

func (s *PersistentStore) GetSession(ctx context.Context, id string) (*Session, error) {
	data, err := s.rdb.Get(ctx, sessionKey(id)).Bytes()
	if err == redis.Nil {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var session Session
	if err := json.Unmarshal(data, &session); err != nil {
		return nil, err
	}
	return &session, nil
}

func (s *PersistentStore) DeleteSession(ctx context.Context, id string) error {
	return s.rdb.Del(ctx, sessionKey(id), cloudSessionReferenceKey(cloudSessionReference(id))).Err()
}

func (s *PersistentStore) UpsertDevice(ctx context.Context, device *Device) error {
	workspaces, err := json.Marshal(device.Workspaces)
	if err != nil {
		return err
	}
	tokenIssuedAt := device.TokenIssuedAt
	if tokenIssuedAt.IsZero() {
		tokenIssuedAt = device.CreatedAt
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO agents
  (agent_id, owner_user_id, installation_id, display_name, platform, app_version, token_sha256,
   workspaces, created_at, token_issued_at, last_seen_at, revoked_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
ON CONFLICT (agent_id) DO UPDATE SET
  platform=EXCLUDED.platform, app_version=EXCLUDED.app_version,
  token_sha256=EXCLUDED.token_sha256, token_issued_at=EXCLUDED.token_issued_at, workspaces=EXCLUDED.workspaces,
  last_seen_at=EXCLUDED.last_seen_at, revoked_at=EXCLUDED.revoked_at`,
		device.ID, device.UserID, device.InstallationID, device.Name, device.Platform, device.Version,
		device.CredentialHash, workspaces, device.CreatedAt, tokenIssuedAt, device.LastSeenAt, device.RevokedAt,
	)
	return err
}

func (s *PersistentStore) SetDeviceName(ctx context.Context, userID int64, deviceID, name string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE agents SET display_name=$3 WHERE agent_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL`, canonicalAgentID(deviceID), userID, name)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PersistentStore) GetDevice(ctx context.Context, userID int64, deviceID string) (*Device, error) {
	row := s.db.QueryRowContext(ctx, deviceSelect+` WHERE agent_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL`, canonicalAgentID(deviceID), userID)
	device, err := scanDevice(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	device.Online = s.rdb.Exists(ctx, presenceKey(device.ID)).Val() > 0
	return device, nil
}

func (s *PersistentStore) GetDeviceByID(ctx context.Context, deviceID string) (*Device, error) {
	canonical := canonicalAgentID(deviceID)
	row := s.db.QueryRowContext(ctx, deviceSelect+` WHERE (agent_id=$1 OR legacy_device_id::text=$2) AND revoked_at IS NULL`, canonical, strings.TrimPrefix(canonical, "agent-"))
	device, err := scanDevice(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	device.Online = s.rdb.Exists(ctx, presenceKey(device.ID)).Val() > 0
	return device, nil
}

func (s *PersistentStore) GetDeviceByInstallation(ctx context.Context, userID int64, installationID string) (*Device, error) {
	row := s.db.QueryRowContext(ctx, deviceSelect+` WHERE owner_user_id=$1 AND installation_id=$2 AND revoked_at IS NULL`, userID, installationID)
	device, err := scanDevice(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	device.Online = s.rdb.Exists(ctx, presenceKey(device.ID)).Val() > 0
	return device, nil
}

func (s *PersistentStore) ListDevices(ctx context.Context, userID int64) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, deviceSelect+` WHERE owner_user_id=$1 AND revoked_at IS NULL ORDER BY display_name`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	devices := make([]Device, 0)
	for rows.Next() {
		device, err := scanDevice(rows)
		if err != nil {
			return nil, err
		}
		devices = append(devices, *device)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	pipe := s.rdb.Pipeline()
	commands := make([]*redis.IntCmd, len(devices))
	for index := range devices {
		commands[index] = pipe.Exists(ctx, presenceKey(devices[index].ID))
	}
	if _, err := pipe.Exec(ctx); err != nil && err != redis.Nil {
		return nil, err
	}
	for index := range devices {
		devices[index].Online = commands[index].Val() > 0
	}
	return devices, nil
}

func (s *PersistentStore) DeleteDevice(ctx context.Context, userID int64, deviceID string) error {
	deviceID = canonicalAgentID(deviceID)
	result, err := s.db.ExecContext(ctx, `UPDATE agents SET revoked_at=NOW() WHERE agent_id=$1 AND owner_user_id=$2 AND revoked_at IS NULL`, deviceID, userID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return s.rdb.Del(ctx, presenceKey(deviceID)).Err()
}

func (s *PersistentStore) SetDevicePresence(ctx context.Context, deviceID string, online bool, at time.Time) error {
	deviceID = canonicalAgentID(deviceID)
	if err := s.touchDeviceLastSeen(ctx, deviceID, at); err != nil {
		return err
	}
	if online {
		return s.rdb.Set(ctx, presenceKey(deviceID), "1", devicePresenceTTL).Err()
	}
	return s.rdb.Del(ctx, presenceKey(deviceID)).Err()
}

func (s *PersistentStore) ClaimDeviceSessionPresence(
	ctx context.Context,
	deviceID string,
	sessionID string,
	at time.Time,
) error {
	deviceID = canonicalAgentID(deviceID)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return ErrNotFound
	}
	if err := s.touchDeviceLastSeen(ctx, deviceID, at); err != nil {
		return err
	}
	return s.rdb.Set(ctx, presenceKey(deviceID), sessionID, devicePresenceTTL).Err()
}

func (s *PersistentStore) RenewDeviceSessionPresence(
	ctx context.Context,
	deviceID string,
	sessionID string,
	at time.Time,
) (bool, error) {
	deviceID = canonicalAgentID(deviceID)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return false, nil
	}
	renewed, err := renewDeviceSessionPresenceScript.Run(
		ctx,
		s.rdb,
		[]string{presenceKey(deviceID)},
		sessionID,
		devicePresenceTTL.Milliseconds(),
	).Int64()
	if err != nil || renewed == 0 {
		return false, err
	}
	if err := s.touchDeviceLastSeen(ctx, deviceID, at); err != nil {
		_, _ = releaseDeviceSessionPresenceScript.Run(
			context.Background(),
			s.rdb,
			[]string{presenceKey(deviceID)},
			sessionID,
		).Result()
		return false, err
	}
	return true, nil
}

func (s *PersistentStore) ReleaseDeviceSessionPresence(
	ctx context.Context,
	deviceID string,
	sessionID string,
	at time.Time,
) (bool, error) {
	deviceID = canonicalAgentID(deviceID)
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return false, nil
	}
	released, err := releaseDeviceSessionPresenceScript.Run(
		ctx,
		s.rdb,
		[]string{presenceKey(deviceID)},
		sessionID,
	).Int64()
	if err != nil || released == 0 {
		return false, err
	}
	if err := s.touchDeviceLastSeen(ctx, deviceID, at); err != nil {
		return false, err
	}
	return true, nil
}

func (s *PersistentStore) touchDeviceLastSeen(
	ctx context.Context,
	deviceID string,
	at time.Time,
) error {
	result, err := s.db.ExecContext(
		ctx,
		`UPDATE agents SET last_seen_at=$2 WHERE agent_id=$1 AND revoked_at IS NULL`,
		deviceID,
		at.UTC(),
	)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PersistentStore) PutSelectionLease(ctx context.Context, lease *SelectionLease) error {
	data, err := json.Marshal(lease)
	if err != nil {
		return err
	}
	ttl := time.Until(lease.ExpiresAt)
	if ttl <= 0 {
		return ErrNotFound
	}
	return s.rdb.Set(ctx, leaseKey(lease.ID), data, ttl).Err()
}

func (s *PersistentStore) GetSelectionLease(ctx context.Context, id string) (*SelectionLease, error) {
	data, err := s.rdb.Get(ctx, leaseKey(id)).Bytes()
	if err == redis.Nil {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var lease SelectionLease
	if err := json.Unmarshal(data, &lease); err != nil {
		return nil, err
	}
	return &lease, nil
}

func (s *PersistentStore) PutCloudConversation(ctx context.Context, conversation *CloudConversation) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO zerobox_cloud_conversations (id,user_id,title,model,created_at,updated_at,pinned,archived,management_version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title,model=EXCLUDED.model,updated_at=EXCLUDED.updated_at
WHERE zerobox_cloud_conversations.user_id=EXCLUDED.user_id`,
		conversation.ID, conversation.UserID, conversation.Title, conversation.Model, conversation.CreatedAt, conversation.UpdatedAt, conversation.Pinned, conversation.Archived, conversation.ManagementVersion)
	return err
}

func (s *PersistentStore) GetCloudConversation(ctx context.Context, userID int64, id string) (*CloudConversation, error) {
	var conversation CloudConversation
	err := s.db.QueryRowContext(ctx, `SELECT id::text,user_id,title,model,created_at,updated_at,pinned,archived,management_version FROM zerobox_cloud_conversations WHERE id=$1 AND user_id=$2`, id, userID).Scan(
		&conversation.ID, &conversation.UserID, &conversation.Title, &conversation.Model, &conversation.CreatedAt, &conversation.UpdatedAt, &conversation.Pinned, &conversation.Archived, &conversation.ManagementVersion)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	return &conversation, err
}

func (s *PersistentStore) ListCloudConversations(ctx context.Context, userID int64) ([]CloudConversation, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id::text,user_id,title,model,created_at,updated_at,pinned,archived,management_version FROM zerobox_cloud_conversations WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 500`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := make([]CloudConversation, 0)
	for rows.Next() {
		var conversation CloudConversation
		if err := rows.Scan(&conversation.ID, &conversation.UserID, &conversation.Title, &conversation.Model, &conversation.CreatedAt, &conversation.UpdatedAt, &conversation.Pinned, &conversation.Archived, &conversation.ManagementVersion); err != nil {
			return nil, err
		}
		items = append(items, conversation)
	}
	return items, rows.Err()
}

func (s *PersistentStore) DeleteCloudConversation(ctx context.Context, userID int64, id string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM zerobox_cloud_conversations WHERE id=$1 AND user_id=$2`, id, userID)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if count == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PersistentStore) AddCloudMessage(ctx context.Context, message *CloudMessage) error {
	if message == nil {
		return ErrCloudRunInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	var owned string
	err = tx.QueryRowContext(ctx, `SELECT id::text FROM zerobox_cloud_conversations WHERE id=$1 AND user_id=$2 FOR UPDATE`, message.ConversationID, message.UserID).Scan(&owned)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	now, err := cloudRunDBTime(ctx, tx)
	if err != nil {
		return err
	}
	message.CreatedAt, err = nextCloudMessageTimeTx(ctx, tx, message.UserID, message.ConversationID, now)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO zerobox_cloud_messages (id,conversation_id,user_id,role,content,usage,created_at,presentation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
		message.ID, message.ConversationID, message.UserID, message.Role, message.Content, nullableJSON(message.Usage), message.CreatedAt, nullableJSON(message.Presentation))
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE zerobox_cloud_conversations SET updated_at=$3 WHERE id=$1 AND user_id=$2`, message.ConversationID, message.UserID, message.CreatedAt); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *PersistentStore) ListCloudMessages(ctx context.Context, userID int64, conversationID string) ([]CloudMessage, error) {
	return boundedLegacyCloudMessages(ctx, s, userID, conversationID)
}

func (s *PersistentStore) PutWebSettings(ctx context.Context, userID int64, settings WebSettings) error {
	data, err := json.Marshal(settings)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
INSERT INTO zerobox_web_settings (user_id,settings,updated_at)
VALUES ($1,$2,NOW())
ON CONFLICT (user_id) DO UPDATE SET settings=EXCLUDED.settings,updated_at=EXCLUDED.updated_at`, userID, data)
	return err
}

func (s *PersistentStore) GetWebSettings(ctx context.Context, userID int64) (*WebSettings, error) {
	var data []byte
	if err := s.db.QueryRowContext(ctx, `SELECT settings FROM zerobox_web_settings WHERE user_id=$1`, userID).Scan(&data); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrNotFound
		}
		return nil, err
	}
	var settings WebSettings
	if err := json.Unmarshal(data, &settings); err != nil {
		return nil, err
	}
	return &settings, nil
}

func (s *PersistentStore) PutConversationRoute(ctx context.Context, route *ConversationRoute) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO zerobox_conversation_routes
  (user_id,conversation_id,runtime_kind,device_id,agent_id,workspace_id,title,summary,created_at,updated_at)
VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9)
ON CONFLICT (conversation_id) DO UPDATE SET
  runtime_kind=EXCLUDED.runtime_kind,device_id=NULL,agent_id=EXCLUDED.agent_id,workspace_id=EXCLUDED.workspace_id,
  title=EXCLUDED.title,summary=EXCLUDED.summary,updated_at=EXCLUDED.updated_at
WHERE zerobox_conversation_routes.user_id=EXCLUDED.user_id`,
		route.UserID, route.ConversationID, route.RuntimeKind, canonicalAgentID(firstNonEmpty(route.AgentID, route.DeviceID)), route.WorkspaceID,
		route.Title, route.Summary, route.CreatedAt, route.UpdatedAt)
	return err
}

func (s *PersistentStore) DeleteConversationRoute(ctx context.Context, userID int64, conversationID string) error {
	result, err := s.db.ExecContext(ctx, `DELETE FROM zerobox_conversation_routes WHERE user_id=$1 AND conversation_id=$2`, userID, conversationID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *PersistentStore) ListConversationRoutes(ctx context.Context, userID int64) ([]ConversationRoute, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT conversation_id::text,user_id,runtime_kind,COALESCE(agent_id,''),workspace_id,title,summary,created_at,updated_at FROM zerobox_conversation_routes WHERE user_id=$1 ORDER BY updated_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	items := make([]ConversationRoute, 0)
	for rows.Next() {
		var route ConversationRoute
		if err := rows.Scan(&route.ConversationID, &route.UserID, &route.RuntimeKind, &route.DeviceID, &route.WorkspaceID, &route.Title, &route.Summary, &route.CreatedAt, &route.UpdatedAt); err != nil {
			return nil, err
		}
		route.AgentID = route.DeviceID
		items = append(items, route)
	}
	return items, rows.Err()
}

func (s *PersistentStore) PutDesktopHandoff(ctx context.Context, codeHash string, handoff *DesktopHandoff) error {
	data, err := json.Marshal(handoff)
	if err != nil {
		return err
	}
	ttl := time.Until(handoff.ExpiresAt)
	if ttl <= 0 {
		return ErrNotFound
	}
	return s.rdb.Set(ctx, handoffKey(codeHash), data, ttl).Err()
}

func (s *PersistentStore) ConsumeDesktopHandoff(ctx context.Context, codeHash string) (*DesktopHandoff, error) {
	value, err := consumeDesktopHandoffScript.Run(ctx, s.rdb, []string{handoffKey(codeHash)}).Text()
	if err == redis.Nil {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var handoff DesktopHandoff
	if err := json.Unmarshal([]byte(value), &handoff); err != nil {
		return nil, err
	}
	return &handoff, nil
}

func (s *PersistentStore) PutOAuthTransaction(ctx context.Context, stateHash string, transaction *OAuthTransaction) error {
	data, err := json.Marshal(transaction)
	if err != nil {
		return err
	}
	ttl := time.Until(transaction.ExpiresAt)
	if ttl <= 0 {
		return ErrNotFound
	}
	return s.rdb.Set(ctx, oauthTransactionKey(stateHash), data, ttl).Err()
}

func (s *PersistentStore) ConsumeOAuthTransaction(ctx context.Context, stateHash string) (*OAuthTransaction, error) {
	value, err := consumeOAuthTransactionScript.Run(ctx, s.rdb, []string{oauthTransactionKey(stateHash)}).Text()
	if err == redis.Nil {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var transaction OAuthTransaction
	if err := json.Unmarshal([]byte(value), &transaction); err != nil {
		return nil, err
	}
	if !transaction.ExpiresAt.After(time.Now()) {
		return nil, ErrNotFound
	}
	return &transaction, nil
}

func nullableJSON(value json.RawMessage) any {
	if len(value) == 0 || string(value) == "null" {
		return nil
	}
	return value
}

const deviceSelect = `SELECT agent_id,owner_user_id,COALESCE(legacy_device_id::text,''),installation_id,display_name,platform,app_version,token_sha256,workspaces,created_at,token_issued_at,last_seen_at,revoked_at FROM agents`

type rowScanner interface{ Scan(dest ...any) error }

func scanDevice(row rowScanner) (*Device, error) {
	var device Device
	var workspaces []byte
	var revoked sql.NullTime
	if err := row.Scan(
		&device.ID, &device.UserID, &device.LegacyDeviceID, &device.InstallationID, &device.Name, &device.Platform, &device.Version,
		&device.CredentialHash, &workspaces, &device.CreatedAt, &device.TokenIssuedAt, &device.LastSeenAt, &revoked,
	); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(workspaces, &device.Workspaces); err != nil {
		return nil, err
	}
	if revoked.Valid {
		device.RevokedAt = &revoked.Time
	}
	device.AgentID = device.ID
	if device.LegacyDeviceID == "" {
		device.LegacyDeviceID = strings.TrimPrefix(device.ID, "agent-")
	}
	return &device, nil
}

func sessionKey(id string) string                 { return "zeroagent:web-session:" + id }
func presenceKey(id string) string                { return "zeroagent:device-presence:" + id }
func leaseKey(id string) string                   { return "zeroagent:selection-lease:" + id }
func handoffKey(codeHash string) string           { return "zeroagent:desktop-handoff:" + codeHash }
func oauthTransactionKey(stateHash string) string { return "zeroagent:oauth-transaction:" + stateHash }
