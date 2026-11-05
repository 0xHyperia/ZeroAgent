package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const CloudGenerationSettingsSchema = `CREATE TABLE IF NOT EXISTS zeroagent_cloud_generation_settings (
 user_id BIGINT PRIMARY KEY CHECK(user_id>0), title JSONB NOT NULL, version BIGINT NOT NULL CHECK(version>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`

type CloudTitlePreferences struct {
	Enabled         bool   `json:"enabled"`
	ProviderKeyID   int64  `json:"provider_key_id"`
	Model           string `json:"model"`
	ReasoningEffort string `json:"reasoning_effort"`
	MaxOutputTokens int    `json:"max_output_tokens"`
	Prompt          string `json:"prompt"`
}
type CloudGenerationSettings struct {
	Title     CloudTitlePreferences `json:"title"`
	Version   int64                 `json:"version"`
	UpdatedAt time.Time             `json:"updated_at"`
}
type cloudGenerationSettingsStore interface {
	GetCloudGenerationSettings(context.Context, int64) (*CloudGenerationSettings, error)
	SetCloudGenerationSettings(context.Context, int64, int64, CloudTitlePreferences) (*CloudGenerationSettings, error)
}

var errCloudGenerationSettingsConflict = errors.New("generation settings changed")

func validCloudTitlePreferences(value CloudTitlePreferences) bool {
	modelValid := value.ProviderKeyID == 0 && value.Model == "" || validCloudModelLimitKey(1, value.ProviderKeyID, value.Model)
	return modelValid && (value.ReasoningEffort == "" || validCloudReasoningEffort(value.ReasoningEffort)) &&
		(value.MaxOutputTokens == 0 || value.MaxOutputTokens >= 256 && value.MaxOutputTokens <= 8192) &&
		len(value.Prompt) <= 4000 && !strings.ContainsRune(value.Prompt, 0)
}
func (s *MemoryStore) GetCloudGenerationSettings(ctx context.Context, userID int64) (*CloudGenerationSettings, error) {
	if userID <= 0 {
		return nil, ErrCloudRunInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	value := s.cloudGenerationSettings[userID]
	return &value, nil
}
func (s *MemoryStore) SetCloudGenerationSettings(ctx context.Context, userID, expected int64, title CloudTitlePreferences) (*CloudGenerationSettings, error) {
	if userID <= 0 || expected < 0 || expected >= 1<<53 || !validCloudTitlePreferences(title) {
		return nil, ErrCloudRunInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cloudGenerationSettings[userID].Version != expected {
		return nil, errCloudGenerationSettingsConflict
	}
	if s.cloudGenerationSettings == nil {
		s.cloudGenerationSettings = map[int64]CloudGenerationSettings{}
	}
	value := CloudGenerationSettings{Title: title, Version: expected + 1, UpdatedAt: s.now().UTC()}
	s.cloudGenerationSettings[userID] = value
	return &value, nil
}
func (s *PersistentStore) GetCloudGenerationSettings(ctx context.Context, userID int64) (*CloudGenerationSettings, error) {
	if userID <= 0 {
		return nil, ErrCloudRunInvalid
	}
	var raw []byte
	var value CloudGenerationSettings
	err := s.db.QueryRowContext(ctx, `SELECT title,version,updated_at FROM zeroagent_cloud_generation_settings WHERE user_id=$1`, userID).Scan(&raw, &value.Version, &value.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return &value, nil
	}
	if err == nil {
		err = json.Unmarshal(raw, &value.Title)
	}
	return &value, err
}
func (s *PersistentStore) SetCloudGenerationSettings(ctx context.Context, userID, expected int64, title CloudTitlePreferences) (*CloudGenerationSettings, error) {
	if userID <= 0 || expected < 0 || expected >= 1<<53 || !validCloudTitlePreferences(title) {
		return nil, ErrCloudRunInvalid
	}
	var value CloudGenerationSettings
	value.Title = title
	var err error
	if expected == 0 {
		err = s.db.QueryRowContext(ctx, `INSERT INTO zeroagent_cloud_generation_settings(user_id,title,version) VALUES($1,$2,1) ON CONFLICT(user_id) DO NOTHING RETURNING version,updated_at`, userID, []byte(cloudJSON(title))).Scan(&value.Version, &value.UpdatedAt)
	} else {
		err = s.db.QueryRowContext(ctx, `UPDATE zeroagent_cloud_generation_settings SET title=$3,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND version=$2 RETURNING version,updated_at`, userID, expected, []byte(cloudJSON(title))).Scan(&value.Version, &value.UpdatedAt)
	}
	if errors.Is(err, sql.ErrNoRows) {
		err = errCloudGenerationSettingsConflict
	}
	return &value, err
}
func (h *HTTPHandler) cloudGenerationSettingsResource(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	store, ok := h.service.store.(cloudGenerationSettingsStore)
	if !ok {
		writeError(w, &APIError{Status: 503, Message: "生成设置暂不可用。"})
		return
	}
	var value *CloudGenerationSettings
	var err error
	if r.Method == http.MethodPut {
		if !h.cloudWriteAllowed(w, r) {
			return
		}
		var input struct {
			ExpectedVersion int64                 `json:"expected_version"`
			Title           CloudTitlePreferences `json:"title"`
		}
		if !decodeCloudProjectRequest(w, r, &input) {
			return
		}
		input.Title.Model = strings.TrimSpace(input.Title.Model)
		input.Title.Prompt = strings.TrimSpace(input.Title.Prompt)
		if !validCloudTitlePreferences(input.Title) {
			writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
			return
		}
		if input.Title.Enabled && input.Title.Model != "" {
			err = h.service.validateCloudImageModel(r.Context(), session, CloudImageSettings{ProviderKeyID: input.Title.ProviderKeyID, Model: input.Title.Model})
		}
		if err == nil {
			value, err = store.SetCloudGenerationSettings(r.Context(), session.UserID, input.ExpectedVersion, input.Title)
		}
	} else {
		value, err = store.GetCloudGenerationSettings(r.Context(), session.UserID)
	}
	if errors.Is(err, errCloudGenerationSettingsConflict) {
		err = &APIError{Status: 409, Reason: "generation_settings_changed", Message: "生成设置已在其他页面更新。当前编辑已保留，请重新读取后核对。"}
	}
	var apiError *APIError
	if errors.As(err, &apiError) && apiError.Reason == "image_model_unavailable" {
		err = &APIError{Status: 400, Reason: "title_model_unavailable", Message: "标题模型不在当前分组中，请重新选择。"}
	}
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	writeJSON(w, http.StatusOK, value)
}
