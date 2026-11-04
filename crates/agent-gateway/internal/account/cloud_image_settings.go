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

// Account preference only: credentials remain in the managed platform.
const CloudImageSettingsSchema = `CREATE TABLE IF NOT EXISTS zeroagent_cloud_image_settings (
 user_id BIGINT PRIMARY KEY CHECK(user_id>0), provider_key_id BIGINT NOT NULL DEFAULT 0,
 model TEXT NOT NULL DEFAULT '', version BIGINT NOT NULL CHECK(version>0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);`

type CloudImageSettings struct {
	ProviderKeyID int64     `json:"provider_key_id"`
	Model         string    `json:"model"`
	Version       int64     `json:"version"`
	UpdatedAt     time.Time `json:"updated_at"`
}
type cloudImageSettingsStore interface {
	GetCloudImageSettings(context.Context, int64) (*CloudImageSettings, error)
	SetCloudImageSettings(context.Context, int64, int64, CloudImageSettings) (*CloudImageSettings, error)
}

var errCloudImageSettingsConflict = errors.New("image settings changed")

func validCloudImageSettings(v CloudImageSettings) bool {
	return v.ProviderKeyID == 0 && v.Model == "" || validCloudModelLimitKey(1, v.ProviderKeyID, v.Model)
}
func (s *MemoryStore) GetCloudImageSettings(ctx context.Context, id int64) (*CloudImageSettings, error) {
	if id <= 0 {
		return nil, ErrCloudRunInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	v := s.cloudImageSettings[id]
	return &v, nil
}
func (s *MemoryStore) SetCloudImageSettings(ctx context.Context, id, expected int64, v CloudImageSettings) (*CloudImageSettings, error) {
	if id <= 0 || expected < 0 || expected >= 1<<53 || !validCloudImageSettings(v) {
		return nil, ErrCloudRunInvalid
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cloudImageSettings[id].Version != expected {
		return nil, errCloudImageSettingsConflict
	}
	v.Version = expected + 1
	v.UpdatedAt = s.now().UTC()
	if s.cloudImageSettings == nil {
		s.cloudImageSettings = map[int64]CloudImageSettings{}
	}
	s.cloudImageSettings[id] = v
	return &v, nil
}
func (s *PersistentStore) GetCloudImageSettings(ctx context.Context, id int64) (*CloudImageSettings, error) {
	if id <= 0 {
		return nil, ErrCloudRunInvalid
	}
	var v CloudImageSettings
	err := s.db.QueryRowContext(ctx, `SELECT provider_key_id,model,version,updated_at FROM zeroagent_cloud_image_settings WHERE user_id=$1`, id).Scan(&v.ProviderKeyID, &v.Model, &v.Version, &v.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	return &v, err
}
func (s *PersistentStore) SetCloudImageSettings(ctx context.Context, id, expected int64, v CloudImageSettings) (*CloudImageSettings, error) {
	if id <= 0 || expected < 0 || expected >= 1<<53 || !validCloudImageSettings(v) {
		return nil, ErrCloudRunInvalid
	}
	var err error
	if expected == 0 {
		err = s.db.QueryRowContext(ctx, `INSERT INTO zeroagent_cloud_image_settings(user_id,provider_key_id,model,version) VALUES($1,$2,$3,1) ON CONFLICT(user_id) DO NOTHING RETURNING provider_key_id,model,version,updated_at`, id, v.ProviderKeyID, v.Model).Scan(&v.ProviderKeyID, &v.Model, &v.Version, &v.UpdatedAt)
	} else {
		err = s.db.QueryRowContext(ctx, `UPDATE zeroagent_cloud_image_settings SET provider_key_id=$2,model=$3,version=version+1,updated_at=clock_timestamp() WHERE user_id=$1 AND version=$4 RETURNING provider_key_id,model,version,updated_at`, id, v.ProviderKeyID, v.Model, expected).Scan(&v.ProviderKeyID, &v.Model, &v.Version, &v.UpdatedAt)
	}
	if errors.Is(err, sql.ErrNoRows) {
		err = errCloudImageSettingsConflict
	}
	return &v, err
}

func (s *Service) validateCloudImageModel(ctx context.Context, session *Session, v CloudImageSettings) error {
	if !validCloudImageSettings(v) {
		return ErrCloudRunInvalid
	}
	if v.Model == "" {
		return nil
	}
	raw, err := s.WebProviderModels(ctx, session, v.ProviderKeyID)
	if err != nil {
		return err
	}
	var list struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &list) != nil {
		return ErrCloudRunInvalid
	}
	for _, m := range list.Data {
		if m.ID == v.Model {
			return nil
		}
	}
	return &APIError{Status: 400, Reason: "image_model_unavailable", Message: "所选生图模型不在当前分组中，请重新选择。"}
}
func (h *HTTPHandler) cloudImageSettingsResource(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	store, ok := h.service.store.(cloudImageSettingsStore)
	if !ok {
		writeError(w, &APIError{Status: 503, Message: "图像设置暂不可用"})
		return
	}
	var value *CloudImageSettings
	var err error
	if r.Method == http.MethodPut {
		if !h.cloudWriteAllowed(w, r) {
			return
		}
		var input struct {
			ExpectedVersion int64  `json:"expected_version"`
			ProviderKeyID   int64  `json:"provider_key_id"`
			Model           string `json:"model"`
		}
		if !decodeCloudProjectRequest(w, r, &input) {
			return
		}
		v := CloudImageSettings{ProviderKeyID: input.ProviderKeyID, Model: strings.TrimSpace(input.Model)}
		if err = h.service.validateCloudImageModel(r.Context(), session, v); err == nil {
			value, err = store.SetCloudImageSettings(r.Context(), session.UserID, input.ExpectedVersion, v)
		}
	} else {
		value, err = store.GetCloudImageSettings(r.Context(), session.UserID)
	}
	if errors.Is(err, errCloudImageSettingsConflict) {
		err = &APIError{Status: 409, Reason: "image_settings_changed", Message: "图像设置已在其他页面更新，请重新读取后保存。"}
	}
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	writeJSON(w, 200, value)
}
