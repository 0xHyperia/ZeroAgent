package account

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const cloudModelLimitsMaxSettings = 256

// This is an explicit account preference, independent of WebSettings updates
// and local device providers. It stores no URL, API key, or model credential.
const CloudModelLimitsSchema = `
CREATE TABLE IF NOT EXISTS zeroagent_cloud_model_limits (
 user_id BIGINT NOT NULL CHECK(user_id>0),provider_key_id BIGINT NOT NULL CHECK(provider_key_id>0),
 model TEXT NOT NULL CHECK(octet_length(model) BETWEEN 1 AND 512),
 mode TEXT NOT NULL CHECK(mode IN ('platform','custom')),
 context_window BIGINT NOT NULL,max_output_tokens BIGINT NOT NULL,
 version BIGINT NOT NULL DEFAULT 1 CHECK(version>0),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(user_id,provider_key_id,model),
 CHECK((mode='platform' AND context_window=0 AND max_output_tokens=0) OR
 (context_window BETWEEN 1024 AND 2000000 AND max_output_tokens BETWEEN 128 AND 1000000 AND max_output_tokens<context_window))
);`

var errCloudModelLimitsConflict = errors.New("cloud model limits changed")

type cloudModelLimitKey struct {
	UserID, ProviderKeyID int64
	Model                 string
}

type CloudModelLimits struct {
	ProviderKeyID   int64     `json:"provider_key_id"`
	Model           string    `json:"model"`
	Mode            string    `json:"mode"`
	ContextWindow   int64     `json:"context_window"`
	MaxOutputTokens int64     `json:"max_output_tokens"`
	Version         int64     `json:"version"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type CloudModelLimitsUpdate struct {
	ExpectedVersion int64  `json:"expected_version"`
	Mode            string `json:"mode"`
	ContextWindow   int64  `json:"context_window"`
	MaxOutputTokens int64  `json:"max_output_tokens"`
}

type cloudModelLimitsStore interface {
	GetCloudModelLimits(context.Context, int64, int64, string) (*CloudModelLimits, error)
	SetCloudModelLimits(context.Context, int64, int64, string, CloudModelLimitsUpdate) (*CloudModelLimits, error)
}

func validCloudModelLimitKey(userID, keyID int64, model string) bool {
	return userID > 0 && keyID > 0 && len(model) > 0 && len(model) <= 512 && strings.TrimSpace(model) == model && utf8.ValidString(model) && !strings.ContainsRune(model, 0)
}

func validCloudModelLimitUpdate(input CloudModelLimitsUpdate) bool {
	if input.ExpectedVersion < 0 || input.ExpectedVersion >= 1<<53 || (input.Mode != "platform" && input.Mode != "custom") {
		return false
	}
	if input.Mode == "platform" && input.ContextWindow == 0 && input.MaxOutputTokens == 0 {
		return true
	}
	return input.ContextWindow >= 1024 && input.ContextWindow <= 2_000_000 && input.MaxOutputTokens >= 128 && input.MaxOutputTokens <= 1_000_000 && input.MaxOutputTokens < input.ContextWindow
}

func (s *MemoryStore) GetCloudModelLimits(ctx context.Context, userID, keyID int64, model string) (*CloudModelLimits, error) {
	if !validCloudModelLimitKey(userID, keyID, model) {
		return nil, ErrCloudRunInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	item, ok := s.cloudModelLimits[cloudModelLimitKey{userID, keyID, model}]
	if !ok {
		return nil, ErrNotFound
	}
	return &item, nil
}

func (s *MemoryStore) SetCloudModelLimits(ctx context.Context, userID, keyID int64, model string, input CloudModelLimitsUpdate) (*CloudModelLimits, error) {
	if !validCloudModelLimitKey(userID, keyID, model) || !validCloudModelLimitUpdate(input) {
		return nil, ErrCloudRunInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := cloudModelLimitKey{userID, keyID, model}
	item, exists := s.cloudModelLimits[key]
	if item.Version != input.ExpectedVersion {
		return nil, errCloudModelLimitsConflict
	}
	if !exists {
		count := 0
		for saved := range s.cloudModelLimits {
			if saved.UserID == userID {
				count++
			}
		}
		if count >= cloudModelLimitsMaxSettings {
			return nil, ErrCloudProjectQuota
		}
	}
	item = CloudModelLimits{keyID, model, input.Mode, input.ContextWindow, input.MaxOutputTokens, item.Version + 1, s.now().UTC()}
	if s.cloudModelLimits == nil {
		s.cloudModelLimits = make(map[cloudModelLimitKey]CloudModelLimits)
	}
	s.cloudModelLimits[key] = item
	return &item, nil
}

func scanCloudModelLimits(row interface{ Scan(...any) error }) (*CloudModelLimits, error) {
	var item CloudModelLimits
	err := row.Scan(&item.ProviderKeyID, &item.Model, &item.Mode, &item.ContextWindow, &item.MaxOutputTokens, &item.Version, &item.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &item, nil
}

const cloudModelLimitColumns = `provider_key_id,model,mode,context_window,max_output_tokens,version,updated_at`

func (s *PersistentStore) GetCloudModelLimits(ctx context.Context, userID, keyID int64, model string) (*CloudModelLimits, error) {
	if !validCloudModelLimitKey(userID, keyID, model) {
		return nil, ErrCloudRunInvalid
	}
	return scanCloudModelLimits(s.db.QueryRowContext(ctx, `SELECT `+cloudModelLimitColumns+` FROM zeroagent_cloud_model_limits WHERE user_id=$1 AND provider_key_id=$2 AND model=$3`, userID, keyID, model))
}

func (s *PersistentStore) SetCloudModelLimits(ctx context.Context, userID, keyID int64, model string, input CloudModelLimitsUpdate) (*CloudModelLimits, error) {
	if !validCloudModelLimitKey(userID, keyID, model) || !validCloudModelLimitUpdate(input) {
		return nil, ErrCloudRunInvalid
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	// Serialize only this account's preferences; concurrent first saves cannot
	// bypass the row bound, while another account remains independent.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended('zeroagent_model_limits:'||$1::text,0))`, userID); err != nil {
		return nil, err
	}
	if input.ExpectedVersion == 0 {
		var exists bool
		var count int
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_model_limits WHERE user_id=$1 AND provider_key_id=$2 AND model=$3), (SELECT count(*) FROM zeroagent_cloud_model_limits WHERE user_id=$1)`, userID, keyID, model).Scan(&exists, &count); err != nil {
			return nil, err
		}
		if exists {
			return nil, errCloudModelLimitsConflict
		}
		if count >= cloudModelLimitsMaxSettings {
			return nil, ErrCloudProjectQuota
		}
	}
	var item *CloudModelLimits
	if input.ExpectedVersion == 0 {
		item, err = scanCloudModelLimits(tx.QueryRowContext(ctx, `INSERT INTO zeroagent_cloud_model_limits(user_id,provider_key_id,model,mode,context_window,max_output_tokens) VALUES($1,$2,$3,$4,$5,$6) RETURNING `+cloudModelLimitColumns, userID, keyID, model, input.Mode, input.ContextWindow, input.MaxOutputTokens))
	} else {
		item, err = scanCloudModelLimits(tx.QueryRowContext(ctx, `UPDATE zeroagent_cloud_model_limits SET mode=$4,context_window=$5,max_output_tokens=$6,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND provider_key_id=$2 AND model=$3 AND version=$7 RETURNING `+cloudModelLimitColumns, userID, keyID, model, input.Mode, input.ContextWindow, input.MaxOutputTokens, input.ExpectedVersion))
		if errors.Is(err, ErrNotFound) {
			return nil, errCloudModelLimitsConflict
		}
	}
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	return item, nil
}

func (h *HTTPHandler) cloudModelLimitsResource(w http.ResponseWriter, r *http.Request, session *Session) {
	if r.Method == http.MethodPut && !h.cloudWriteAllowed(w, r) {
		return
	}
	query := r.URL.Query()
	for key, values := range query {
		if (key != "provider_key_id" && key != "model") || len(values) != 1 {
			writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
			return
		}
	}
	keyID, err := strconv.ParseInt(query.Get("provider_key_id"), 10, 64)
	model := query.Get("model")
	if err != nil || !validCloudModelLimitKey(session.UserID, keyID, model) {
		writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
		return
	}
	store, ok := h.service.store.(cloudModelLimitsStore)
	if !ok {
		writeError(w, &APIError{Status: http.StatusServiceUnavailable, Message: "cloud model preferences are unavailable"})
		return
	}
	var update CloudModelLimitsUpdate
	if r.Method == http.MethodPut {
		if !decodeCloudProjectRequest(w, r, &update) {
			return
		}
		if !validCloudModelLimitUpdate(update) {
			writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
			return
		}
	}
	// The server validates ownership using the same app-scoped USA path as a
	// model request. No key is returned, persisted here, or sent to the browser.
	if _, err := h.service.WebAPIKeyForID(r.Context(), session, keyID); err != nil {
		writeError(w, err)
		return
	}
	var item *CloudModelLimits
	if r.Method == http.MethodPut {
		item, err = store.SetCloudModelLimits(r.Context(), session.UserID, keyID, model, update)
	} else {
		item, err = store.GetCloudModelLimits(r.Context(), session.UserID, keyID, model)
		if errors.Is(err, ErrNotFound) {
			err = nil
		}
	}
	if err != nil {
		switch {
		case errors.Is(err, errCloudModelLimitsConflict):
			writeError(w, &APIError{Status: 409, Reason: "cloud_model_limits_changed", Message: "model preferences changed on another device; reload before saving"})
		case errors.Is(err, ErrCloudProjectQuota):
			writeError(w, &APIError{Status: 409, Reason: "cloud_model_limits_quota", Message: "account model preference limit reached"})
		default:
			writeError(w, cloudRunAPIError(err))
		}
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"setting": item})
}
