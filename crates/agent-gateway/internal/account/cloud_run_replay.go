package account

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
)

// Private replay lookup must not re-resolve attachments, model keys or the
// original execution session. A fresh authenticated account may recover its
// accepted task; this never grants authority to resume or rebind execution.
type cloudRunReplayStore interface {
	GetCloudRunByClientRequest(context.Context, int64, string) (*CloudRun, error)
}

func logicalCloudRunContent(raw json.RawMessage) (json.RawMessage, error) {
	var parts []map[string]any
	if len(raw) == 0 || raw[0] != '[' {
		return append(json.RawMessage(nil), raw...), nil
	}
	if json.Unmarshal(raw, &parts) != nil {
		return nil, ErrCloudRunInvalid
	}
	for index, part := range parts {
		switch part["type"] {
		case "file_reference":
			parts[index] = map[string]any{"type": "file_reference", "file_id": part["file_id"]}
		case "artifact_reference":
			parts[index] = map[string]any{"type": "artifact_reference", "version_id": part["version_id"]}
		}
	}
	return json.Marshal(parts)
}

func cloudRunLogicalRequestHash(input CreateCloudRunInput) (string, error) {
	logical, err := logicalCloudRunContent(input.Content)
	if err != nil {
		return "", err
	}
	input.Content = logical
	encoded, err := json.Marshal(input)
	if err != nil {
		return "", ErrCloudRunInvalid
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func (s *MemoryStore) GetCloudRunByClientRequest(ctx context.Context, uid int64, requestID string) (*CloudRun, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if uid <= 0 || strings.TrimSpace(requestID) == "" || len(requestID) > 128 {
		return nil, ErrCloudRunInvalid
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.cloudRuns == nil {
		return nil, ErrNotFound
	}
	id, ok := s.cloudRuns.requests[strconv.FormatInt(uid, 10)+":"+requestID]
	if !ok {
		return nil, ErrNotFound
	}
	run, ok := s.cloudRuns.runs[id]
	if !ok || run.UserID != uid {
		return nil, ErrNotFound
	}
	conversation, ok := s.cloudConversations[run.ConversationID]
	if !ok || conversation.UserID != uid {
		return nil, ErrNotFound
	}
	result := cloudPublicRun(run)
	result.RequestHash = run.RequestHash
	return result, nil
}

type cloudReplayScanner struct {
	cloudRunScanner
	hash *string
}

func (s cloudReplayScanner) Scan(dest ...any) error {
	return s.cloudRunScanner.Scan(append(dest, s.hash)...)
}

func (s *PersistentStore) GetCloudRunByClientRequest(ctx context.Context, uid int64, requestID string) (*CloudRun, error) {
	if uid <= 0 || strings.TrimSpace(requestID) == "" || len(requestID) > 128 {
		return nil, ErrCloudRunInvalid
	}
	columns := strings.Replace(cloudRunPublicColumns, "OUTPUT_COLUMN", "r.output", 1)
	var hash string
	run, err := scanCloudRunView(cloudReplayScanner{cloudRunScanner: s.db.QueryRowContext(ctx, `SELECT `+columns+`,r.request_hash FROM zeroagent_cloud_runs r JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.user_id=$1 AND r.client_request_id=$2`, uid, requestID), hash: &hash})
	if err != nil {
		return nil, err
	}
	run.RequestHash = hash
	return run, nil
}

func (s *Service) replayCloudRun(ctx context.Context, session *Session, input CreateCloudRunInput, hash string) (*CloudRun, error) {
	lookup, ok := s.store.(cloudRunReplayStore)
	if !ok {
		return nil, &APIError{Status: http.StatusServiceUnavailable, Message: "cloud task replay storage is unavailable"}
	}
	run, err := lookup.GetCloudRunByClientRequest(ctx, session.UserID, input.ClientRequestID)
	if err != nil {
		return nil, err
	}
	if run.ConversationID != input.ConversationID || run.RequestHash != hash {
		return nil, ErrCloudRunConflict
	}
	// A logout or account replacement during the lookup must not turn a stale
	// pointer into a new read capability. Never replace the accepted SessionRef.
	current, err := s.Session(ctx, session.ID)
	if err != nil {
		return nil, err
	}
	if current.UserID != session.UserID {
		return nil, sessionMissingError()
	}
	return run, nil
}

func (s *Service) replayCloudRunAfterValidationFailure(ctx context.Context, session *Session, input CreateCloudRunInput, hash string, original error) (*CloudRun, bool, error) {
	run, err := s.replayCloudRun(ctx, session, input, hash)
	if err == nil {
		return run, false, nil
	}
	if errors.Is(err, ErrNotFound) {
		return nil, false, original
	}
	return nil, false, err
}
