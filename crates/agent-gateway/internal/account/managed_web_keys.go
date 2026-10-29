package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const managedKeyMask = "••••••••"
const managedWebMaxSafeID = 1<<53 - 1

// ProxyManagedWeb is the public account boundary. Private model brokers still
// use ProxyUSA/OwnedAPIKey and never accept credentials supplied by the renderer.
func (s *Service) ProxyManagedWeb(ctx context.Context, session *Session, method, apiPath string, body []byte) (json.RawMessage, error) {
	path, err := managedWebProxyPath(method, apiPath, body)
	if err != nil {
		return nil, err
	}
	data, err := s.ProxyUSA(ctx, session, method, apiPath, body)
	if err != nil {
		return nil, managedWebError(err)
	}
	if path != "keys" {
		return data, nil
	}
	return projectManagedWebKeys(data, method == http.MethodPost, session)
}

func managedWebProxyPath(method, apiPath string, body []byte) (string, error) {
	denied := &APIError{Status: http.StatusForbidden, Message: "account resource is not available"}
	// Reject aliases before forwarding: the legacy API is otherwise an arbitrary
	// authenticated proxy, including key details and authentication endpoints.
	if strings.ContainsAny(apiPath, "%\\#;\x00\r\n") || strings.Contains(apiPath, "//") {
		return "", denied
	}
	path, rawQuery, _ := strings.Cut(strings.TrimPrefix(apiPath, "/"), "?")
	allowed := map[string]string{
		"user/profile": http.MethodGet, "user": http.MethodPut,
		"usage/dashboard/stats": http.MethodGet, "groups/available": http.MethodGet,
		"subscriptions": http.MethodGet, "user/password": http.MethodPut,
		"user/account-bindings/email":           http.MethodPost,
		"user/account-bindings/email/send-code": http.MethodPost,
	}
	if path == "keys" {
		if method != http.MethodGet && method != http.MethodPost {
			return "", denied
		}
		if method == http.MethodPost {
			if rawQuery != "" {
				return "", denied
			}
			var input struct {
				Name    string `json:"name"`
				GroupID int64  `json:"group_id"`
			}
			decoder := json.NewDecoder(bytes.NewReader(body))
			decoder.DisallowUnknownFields()
			if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF || strings.TrimSpace(input.Name) == "" || len(input.Name) > 256 || input.GroupID <= 0 || input.GroupID > managedWebMaxSafeID {
				return "", &APIError{Status: http.StatusBadRequest, Message: "invalid managed key request"}
			}
		} else {
			query, err := url.ParseQuery(rawQuery)
			if err != nil {
				return "", denied
			}
			for key, values := range query {
				if (key != "page" && key != "page_size") || len(values) != 1 {
					return "", denied
				}
				n, err := strconv.Atoi(values[0])
				if err != nil || n < 1 || n > 1000 {
					return "", denied
				}
			}
		}
	} else if allowed[path] != method || rawQuery != "" {
		return "", denied
	}
	return path, nil
}

func managedWebError(err error) error {
	status := http.StatusBadGateway
	var upstream *APIError
	if errors.As(err, &upstream) && upstream.Status >= 400 && upstream.Status <= 599 {
		status = upstream.Status
	}
	return &APIError{Status: status, Message: "account request failed"}
}

func projectManagedWebKeys(data json.RawMessage, single bool, session *Session) (json.RawMessage, error) {
	invalid := &APIError{Status: http.StatusBadGateway, Message: "invalid managed key response"}
	var value any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if decoder.Decode(&value) != nil {
		return nil, invalid
	}
	secrets := []string{}
	if session != nil {
		secrets = append(secrets, session.AccessToken, session.RefreshToken, session.ID)
	}
	var collect func(any)
	collect = func(v any) {
		switch v := v.(type) {
		case []any:
			for _, item := range v {
				collect(item)
			}
		case map[string]any:
			for key, item := range v {
				field := strings.ToLower(strings.NewReplacer("_", "", "-", "").Replace(key))
				switch field {
				case "key", "apikey", "accesstoken", "refreshtoken", "temptoken", "secret", "password", "authorization":
					if secret, ok := item.(string); ok && secret != "" {
						secrets = append(secrets, secret)
					}
				}
				collect(item)
			}
		}
	}
	collect(value)
	sort.Slice(secrets, func(i, j int) bool { return len(secrets[i]) > len(secrets[j]) })
	clean := func(value string) string {
		for _, secret := range secrets {
			if secret != "" {
				value = strings.ReplaceAll(value, secret, "[hidden]")
			}
		}
		return value
	}
	var fields func(map[string]any, []string, []string) map[string]any
	fields = func(row map[string]any, text, numbers []string) map[string]any {
		result := map[string]any{}
		for _, field := range text {
			if value, ok := row[field].(string); ok {
				result[field] = clean(value)
			}
		}
		for _, field := range numbers {
			if value, ok := row[field].(json.Number); ok {
				result[field] = value
			}
		}
		return result
	}
	project := func(value any) (map[string]any, bool) {
		row, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		id, ok := row["id"].(json.Number)
		if !ok {
			return nil, false
		}
		if n, err := id.Int64(); err != nil || n <= 0 || n > managedWebMaxSafeID {
			return nil, false
		}
		result := fields(row, []string{"name", "status", "created_at"}, []string{"id", "group_id", "quota", "quota_used"})
		if row["group_id"] == nil {
			result["group_id"] = nil
		}
		key, _ := row["key"].(string)
		configured := strings.TrimSpace(key) != "" || row["key_configured"] == true
		result["key"], result["key_masked"], result["key_configured"] = "", true, configured
		if configured {
			result["key"] = managedKeyMask
		}
		if group, ok := row["group"].(map[string]any); ok {
			result["group"] = fields(group, []string{"name", "description", "platform", "subscription_type", "status"}, []string{"id", "rate_multiplier"})
		}
		return result, true
	}
	if single {
		result, ok := project(value)
		if !ok {
			return nil, invalid
		}
		return json.Marshal(result)
	}
	page, ok := value.(map[string]any)
	if !ok {
		return nil, invalid
	}
	items, ok := page["items"].([]any)
	if !ok {
		return nil, invalid
	}
	projected := make([]map[string]any, 0, len(items))
	for _, item := range items {
		row, ok := project(item)
		if !ok {
			return nil, invalid
		}
		projected = append(projected, row)
	}
	result := fields(page, nil, []string{"total", "page", "page_size", "pages"})
	result["items"] = projected
	return json.Marshal(result)
}

func (h *HTTPHandler) registerManagedWebKeys(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/managed-provider-keys/{id}/reveal", h.withSession(h.revealManagedWebKey))
}

func (h *HTTPHandler) revealManagedWebKey(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil || id <= 0 || id > managedWebMaxSafeID || strconv.FormatInt(id, 10) != r.PathValue("id") {
		writeError(w, &APIError{Status: http.StatusBadRequest, Message: "invalid managed key ID"})
		return
	}
	var input struct {
		Password string `json:"password"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if !decodeRequest(w, r, &input) {
		return
	}
	key, err := h.service.RevealManagedWebKey(r.Context(), session, id, input.Password)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"key": key})
}

func (s *Service) currentManagedWebSession(ctx context.Context, expected *Session) (*Session, error) {
	if expected == nil {
		return nil, sessionMissingError()
	}
	current, err := s.Session(ctx, expected.ID)
	if err != nil {
		return nil, err
	}
	if !sameSessionIdentity(current, expected) {
		return nil, sessionMissingError()
	}
	return current, nil
}

// RevealManagedWebKey binds a one-operation password proof to a live account and
// owned key. The proof never creates/replaces a ZeroAgent OAuth session.
func (s *Service) RevealManagedWebKey(ctx context.Context, session *Session, id int64, password string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()
	current, err := s.currentManagedWebSession(ctx, session)
	if err != nil {
		return "", err
	}
	var identity struct {
		Email string `json:"email"`
	}
	if json.Unmarshal(current.User, &identity) != nil {
		return "", passwordProofDenied()
	}
	if err := s.VerifyPassword(ctx, current, identity.Email, password); err != nil {
		return "", err
	}
	current, err = s.currentManagedWebSession(ctx, current)
	if err != nil {
		return "", err
	}
	if _, err = s.RefreshUser(ctx, current); err != nil {
		return "", err
	}
	current, err = s.currentManagedWebSession(ctx, current)
	if err != nil {
		return "", err
	}
	var key string
	if current.IsOAuth() {
		key, err = s.usa.AppOwnedAPIKey(ctx, current.AccessToken, id)
	} else {
		key, err = s.usa.OwnedAPIKey(ctx, current.AccessToken, id)
	}
	if err != nil {
		return "", managedWebError(err)
	}
	latest, err := s.currentManagedWebSession(ctx, current)
	if err != nil {
		return "", err
	}
	if sessionCredentialVersion(latest) != sessionCredentialVersion(current) {
		return "", &APIError{Status: http.StatusConflict, Message: "account credentials changed; retry the operation"}
	}
	return key, nil
}

func passwordProofDenied() error {
	return &APIError{Status: http.StatusForbidden, Message: "密码验证失败"}
}

func (s *Service) managedPasswordProof(ctx context.Context, email, password string) (*LoginResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	defer func() {
		for i := range body {
			body[i] = 0
		}
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.usa.origin+"/api/v1/auth/login", bytes.NewReader(body))
	if err != nil {
		return nil, managedWebError(err)
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	client := *s.usa.client
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	client.Jar = nil
	response, err := client.Do(req)
	if err != nil {
		return nil, managedWebError(err)
	}
	defer func() { _ = response.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	defer func() {
		for i := range data {
			data[i] = 0
		}
	}()
	if err != nil || len(data) > 1<<20 {
		return nil, managedWebError(err)
	}
	var envelope struct {
		Code json.RawMessage            `json:"code"`
		Data map[string]json.RawMessage `json:"data"`
	}
	if json.Unmarshal(data, &envelope) != nil {
		return nil, managedWebError(nil)
	}
	result := &LoginResult{}
	// Extract cleanup candidates independently of malformed identity/flags.
	_ = json.Unmarshal(envelope.Data["access_token"], &result.AccessToken)
	_ = json.Unmarshal(envelope.Data["refresh_token"], &result.RefreshToken)
	_ = json.Unmarshal(envelope.Data["temp_token"], &result.TempToken)
	_ = json.Unmarshal(envelope.Data["requires_2fa"], &result.Requires2FA)
	var user struct {
		ID int64 `json:"id"`
	}
	_ = json.Unmarshal(envelope.Data["user"], &user)
	result.UserID = user.ID
	var code int
	codeError := json.Unmarshal(envelope.Code, &code)
	if response.StatusCode < 200 || response.StatusCode >= 300 || codeError != nil || code != 0 {
		if response.StatusCode == 400 || response.StatusCode == 401 || response.StatusCode == 403 || (response.StatusCode >= 200 && response.StatusCode < 300) {
			return result, passwordProofDenied()
		}
		status := http.StatusBadGateway
		if response.StatusCode == 429 {
			status = 429
		}
		return result, &APIError{Status: status, Message: "暂时无法验证密码，请稍后重试"}
	}
	return result, nil
}

func (s *Service) cleanupManagedPasswordProof(ctx context.Context, original *Session, result *LoginResult) error {
	if result == nil {
		return nil
	}
	defer func() { result.AccessToken, result.RefreshToken, result.TempToken = "", "", "" }()
	refresh := result.RefreshToken
	if refresh == "" {
		return nil
	}
	cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	// Never let a reflected current credential turn a proof into an OAuth logout.
	protected := []string{original.AccessToken, original.RefreshToken}
	latest, err := s.store.GetSession(cleanupCtx, original.ID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return sessionStorageError()
	}
	if latest != nil {
		protected = append(protected, latest.AccessToken, latest.RefreshToken)
	}
	for _, token := range protected {
		if token != "" && (token == refresh || token == result.AccessToken) {
			return passwordProofDenied()
		}
	}
	// Legacy password credentials use /auth/logout, not the app OAuth revoker.
	// The platform only promises refresh revocation here; an issued access JWT
	// may remain valid until expiry and is never returned or persisted by us.
	if err := s.usa.Logout(cleanupCtx, refresh); err != nil {
		return &APIError{Status: http.StatusBadGateway, Message: "密码验证临时凭据清理失败，请稍后重试", Reason: "password_proof_cleanup_failed"}
	}
	return nil
}
