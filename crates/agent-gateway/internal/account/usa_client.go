package account

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type USAClient struct {
	origin string
	client *http.Client
}

type usaEnvelope struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Reason  string          `json:"reason,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
}

type OAuthTokenResult struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
}

type appEnvelope struct {
	Success bool            `json:"success"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data"`
	Error   struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func NewUSAClient(origin string, timeout time.Duration) (*USAClient, error) {
	origin = strings.TrimRight(strings.TrimSpace(origin), "/")
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil, fmt.Errorf("invalid USA-Zero origin %q", origin)
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &USAClient{origin: origin, client: &http.Client{Timeout: timeout}}, nil
}

func NewUSAClientWithHTTPClient(origin string, client *http.Client) *USAClient {
	return &USAClient{origin: strings.TrimRight(origin, "/"), client: client}
}

func (c *USAClient) Origin() string { return c.origin }

func (c *USAClient) CreateAppAuthorizationRequest(ctx context.Context, payload map[string]any) (string, error) {
	data, err := c.request(ctx, http.MethodPost, "/api/v1/app-auth/authorize/requests", payload, "")
	if err != nil {
		return "", err
	}
	var result struct {
		RequestID string `json:"request_id"`
	}
	if json.Unmarshal(data, &result) != nil || strings.TrimSpace(result.RequestID) == "" {
		return "", &APIError{Status: http.StatusBadGateway, Message: "USA-Zero authorization response is incomplete"}
	}
	return result.RequestID, nil
}

func (c *USAClient) ExchangeAppCode(ctx context.Context, clientID, code, redirectURI, verifier string) (*OAuthTokenResult, error) {
	return c.appToken(ctx, url.Values{
		"grant_type": {"authorization_code"}, "client_id": {clientID}, "code": {code},
		"redirect_uri": {redirectURI}, "code_verifier": {verifier},
	})
}

func (c *USAClient) RefreshApp(ctx context.Context, clientID, refreshToken string) (*OAuthTokenResult, error) {
	return c.appToken(ctx, url.Values{
		"grant_type": {"refresh_token"}, "client_id": {clientID}, "refresh_token": {refreshToken},
	})
}

func (c *USAClient) RevokeApp(ctx context.Context, token, hint string) error {
	values := url.Values{"token": {token}}
	if hint != "" {
		values.Set("token_type_hint", hint)
	}
	_, err := c.formRequest(ctx, "/api/v1/app-auth/revoke", values)
	return err
}

func (c *USAClient) AppMe(ctx context.Context, accessToken string) (json.RawMessage, error) {
	return c.appRequest(ctx, http.MethodGet, "/api/v1/app/me", nil, accessToken)
}

func (c *USAClient) AppIssueStepUp(ctx context.Context, accessToken, target string) (json.RawMessage, error) {
	return c.appRequest(ctx, http.MethodPost, "/api/v1/app/execution/step-up", map[string]any{
		"purpose": StepUpPurposeTargetSwap, "target_fingerprint": target,
	}, accessToken)
}

func (c *USAClient) AppConsumeStepUp(ctx context.Context, accessToken, proof, target string) error {
	_, err := c.appRequest(ctx, http.MethodPost, "/api/v1/app/execution/step-up/consume", map[string]any{
		"proof": proof, "purpose": StepUpPurposeTargetSwap, "target_fingerprint": target,
	}, accessToken)
	return err
}

func (c *USAClient) ProxyApp(ctx context.Context, method, apiPath, accessToken string, body []byte) (json.RawMessage, error) {
	path := strings.TrimPrefix(strings.SplitN(apiPath, "?", 2)[0], "/")
	appPath := ""
	switch path {
	case "user/profile":
		appPath = "/api/v1/app/me"
	case "user":
		appPath = "/api/v1/app/me"
		if method == http.MethodPut {
			method = http.MethodPatch
		}
	case "usage/dashboard/stats":
		appPath = "/api/v1/app/usage"
	case "groups/available":
		appPath = "/api/v1/app/groups"
	case "keys":
		appPath = "/api/v1/app/keys"
		if method == http.MethodPost {
			var input struct {
				Name    string `json:"name"`
				GroupID int64  `json:"group_id"`
			}
			if json.Unmarshal(body, &input) != nil || input.GroupID <= 0 {
				return nil, &APIError{Status: http.StatusBadRequest, Message: "group_id is required"}
			}
			appPath = fmt.Sprintf("/api/v1/app/groups/%d/keys", input.GroupID)
			body, _ = json.Marshal(map[string]any{"name": input.Name})
		}
	case "subscriptions":
		appPath = "/api/v1/app/subscriptions"
	case "user/password", "user/account-bindings/email", "user/account-bindings/email/send-code":
		return nil, &APIError{Status: http.StatusForbidden, Message: "Open usa0.top account security to change password or email"}
	default:
		return nil, &APIError{Status: http.StatusForbidden, Message: "resource is not available to an authorized app"}
	}
	var payload any
	if len(body) > 0 {
		payload = json.RawMessage(body)
	}
	return c.appRequest(ctx, method, appPath, payload, accessToken)
}

func (c *USAClient) EnsureAppWebAPIKey(ctx context.Context, accessToken string) (string, error) {
	data, err := c.appRequest(ctx, http.MethodGet, "/api/v1/app/keys?page=1&page_size=100", nil, accessToken)
	if err != nil {
		return "", err
	}
	var page struct {
		Items []struct{ Key, Name, Status string } `json:"items"`
	}
	if json.Unmarshal(data, &page) != nil {
		return "", &APIError{Status: http.StatusBadGateway, Message: "USA-Zero returned invalid app keys"}
	}
	for _, key := range page.Items {
		if key.Name == "ZeroAgent Web" && key.Status == "active" && key.Key != "" {
			return key.Key, nil
		}
	}
	groups, err := c.appRequest(ctx, http.MethodGet, "/api/v1/app/groups", nil, accessToken)
	if err != nil {
		return "", err
	}
	var items []struct {
		ID     int64  `json:"id"`
		Status string `json:"status"`
	}
	if json.Unmarshal(groups, &items) != nil {
		return "", &APIError{Status: http.StatusBadGateway, Message: "USA-Zero returned invalid app groups"}
	}
	var groupID int64
	for _, group := range items {
		if group.Status == "active" {
			groupID = group.ID
			break
		}
	}
	if groupID == 0 {
		return "", &APIError{Status: http.StatusConflict, Message: "account has no active model group"}
	}
	created, err := c.appRequest(ctx, http.MethodPost, fmt.Sprintf("/api/v1/app/groups/%d/keys", groupID), map[string]any{"name": "ZeroAgent Web"}, accessToken)
	if err != nil {
		return "", err
	}
	var key struct {
		Key string `json:"key"`
	}
	if json.Unmarshal(created, &key) != nil || strings.TrimSpace(key.Key) == "" {
		return "", &APIError{Status: http.StatusBadGateway, Message: "USA-Zero did not return the web API key"}
	}
	return strings.TrimSpace(key.Key), nil
}

func (c *USAClient) AppOwnedAPIKey(ctx context.Context, accessToken string, keyID int64) (string, error) {
	data, err := c.appRequest(ctx, http.MethodGet, "/api/v1/app/keys?page=1&page_size=100", nil, accessToken)
	if err != nil {
		return "", err
	}
	var page struct {
		Items []struct {
			ID          int64 `json:"id"`
			Key, Status string
		} `json:"items"`
	}
	if json.Unmarshal(data, &page) != nil {
		return "", &APIError{Status: http.StatusBadGateway, Message: "USA-Zero returned invalid app keys"}
	}
	for _, item := range page.Items {
		if item.ID == keyID && item.Status == "active" && item.Key != "" {
			return item.Key, nil
		}
	}
	return "", &APIError{Status: http.StatusNotFound, Message: "API key not found"}
}

func (c *USAClient) Login(ctx context.Context, email, password string) (*LoginResult, error) {
	data, err := c.request(ctx, http.MethodPost, "/api/v1/auth/login", map[string]any{
		"email": email, "password": password,
	}, "")
	if err != nil {
		return nil, err
	}
	return decodeLoginResult(data)
}

func (c *USAClient) Login2FA(ctx context.Context, tempToken, code string) (*LoginResult, error) {
	data, err := c.request(ctx, http.MethodPost, "/api/v1/auth/login/2fa", map[string]any{
		"temp_token": tempToken, "totp_code": code,
	}, "")
	if err != nil {
		return nil, err
	}
	return decodeLoginResult(data)
}

func (c *USAClient) PublicSettings(ctx context.Context) (json.RawMessage, error) {
	return c.request(ctx, http.MethodGet, "/api/v1/settings/public", nil, "")
}

func (c *USAClient) SendVerifyCode(ctx context.Context, email string) (json.RawMessage, error) {
	return c.request(ctx, http.MethodPost, "/api/v1/auth/send-verify-code", map[string]any{
		"email": strings.TrimSpace(email),
	}, "")
}

func (c *USAClient) Register(ctx context.Context, email, password, verifyCode, invitationCode string) (*LoginResult, error) {
	data, err := c.request(ctx, http.MethodPost, "/api/v1/auth/register", map[string]any{
		"email":           strings.TrimSpace(email),
		"password":        password,
		"verify_code":     strings.TrimSpace(verifyCode),
		"invitation_code": strings.TrimSpace(invitationCode),
	}, "")
	if err != nil {
		return nil, err
	}
	return decodeLoginResult(data)
}

func (c *USAClient) Refresh(ctx context.Context, refreshToken string) (*LoginResult, error) {
	data, err := c.request(ctx, http.MethodPost, "/api/v1/auth/refresh", map[string]any{
		"refresh_token": refreshToken,
	}, "")
	if err != nil {
		return nil, err
	}
	result, err := decodeLoginResult(data)
	if err != nil {
		return nil, err
	}
	result.RefreshToken = firstNonEmpty(result.RefreshToken, refreshToken)
	return result, nil
}

func (c *USAClient) Logout(ctx context.Context, refreshToken string) error {
	_, err := c.request(ctx, http.MethodPost, "/api/v1/auth/logout", map[string]any{"refresh_token": refreshToken}, "")
	return err
}

func (c *USAClient) Me(ctx context.Context, accessToken string) (json.RawMessage, error) {
	return c.request(ctx, http.MethodGet, "/api/v1/auth/me", nil, accessToken)
}

func (c *USAClient) IssueStepUp(ctx context.Context, accessToken, password, target string) (json.RawMessage, error) {
	return c.request(ctx, http.MethodPost, "/api/v1/user/step-up", map[string]any{
		"password": password, "purpose": StepUpPurposeTargetSwap, "target_fingerprint": target,
	}, accessToken)
}

func (c *USAClient) ConsumeStepUp(ctx context.Context, accessToken, proof, target string) error {
	_, err := c.request(ctx, http.MethodPost, "/api/v1/user/step-up/consume", map[string]any{
		"proof": proof, "purpose": StepUpPurposeTargetSwap, "target_fingerprint": target,
	}, accessToken)
	return err
}

func (c *USAClient) Proxy(ctx context.Context, method, apiPath, accessToken string, body []byte) (json.RawMessage, error) {
	var payload any
	if len(body) > 0 {
		payload = json.RawMessage(body)
	}
	return c.request(ctx, method, "/api/v1/"+strings.TrimLeft(apiPath, "/"), payload, accessToken)
}

func (c *USAClient) EnsureWebAPIKey(ctx context.Context, accessToken string) (string, error) {
	data, err := c.request(ctx, http.MethodGet, "/api/v1/keys?page=1&page_size=1000", nil, accessToken)
	if err != nil {
		return "", err
	}
	var page struct {
		Items []struct {
			Key    string `json:"key"`
			Name   string `json:"name"`
			Status string `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(data, &page); err != nil {
		return "", err
	}
	for _, key := range page.Items {
		if key.Name == "ZeroAgent Web" && key.Status == "active" && strings.TrimSpace(key.Key) != "" {
			return strings.TrimSpace(key.Key), nil
		}
	}

	groupsData, err := c.request(ctx, http.MethodGet, "/api/v1/groups/available", nil, accessToken)
	if err != nil {
		return "", err
	}
	var groups []struct {
		ID       int64  `json:"id"`
		Status   string `json:"status"`
		Platform string `json:"platform"`
	}
	if err := json.Unmarshal(groupsData, &groups); err != nil {
		return "", err
	}
	var groupID int64
	for _, group := range groups {
		if group.Status == "active" && (group.Platform == "openai" || group.Platform == "grok") {
			groupID = group.ID
			break
		}
	}
	if groupID == 0 {
		for _, group := range groups {
			if group.Status == "active" {
				groupID = group.ID
				break
			}
		}
	}
	if groupID == 0 {
		return "", &APIError{Status: http.StatusConflict, Message: "account has no active model group"}
	}
	created, err := c.request(ctx, http.MethodPost, "/api/v1/keys", map[string]any{
		"name": "ZeroAgent Web", "group_id": groupID,
	}, accessToken)
	if err != nil {
		return "", err
	}
	var key struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(created, &key); err != nil || strings.TrimSpace(key.Key) == "" {
		return "", &APIError{Status: http.StatusBadGateway, Message: "USA-Zero did not return the web API key"}
	}
	return strings.TrimSpace(key.Key), nil
}

func (c *USAClient) ModelsForAPIKey(ctx context.Context, accessToken string, keyID int64) (json.RawMessage, error) {
	apiKey, err := c.OwnedAPIKey(ctx, accessToken, keyID)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.origin+"/v1/models", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero model gateway is unavailable"}
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, &APIError{Status: resp.StatusCode, Message: "failed to load models for API key"}
	}
	if !json.Valid(body) {
		return nil, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero returned an invalid model list"}
	}
	return json.RawMessage(body), nil
}

func (c *USAClient) OwnedAPIKey(ctx context.Context, accessToken string, keyID int64) (string, error) {
	if keyID <= 0 {
		return "", &APIError{Status: http.StatusBadRequest, Message: "invalid API key ID"}
	}
	data, err := c.request(ctx, http.MethodGet, "/api/v1/keys?page=1&page_size=1000", nil, accessToken)
	if err != nil {
		return "", err
	}
	var page struct {
		Items []struct {
			ID     int64  `json:"id"`
			Key    string `json:"key"`
			Status string `json:"status"`
		} `json:"items"`
	}
	if err := json.Unmarshal(data, &page); err != nil {
		return "", err
	}
	var apiKey string
	for _, item := range page.Items {
		if item.ID == keyID && item.Status == "active" {
			apiKey = strings.TrimSpace(item.Key)
			break
		}
	}
	if apiKey == "" {
		return "", &APIError{Status: http.StatusNotFound, Message: "API key not found"}
	}
	return apiKey, nil
}

func (c *USAClient) StreamChatCompletion(ctx context.Context, apiKey string, payload []byte) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.origin+"/v1/chat/completions", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)
	response, err := c.client.Do(req)
	if err != nil {
		return nil, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero model gateway is unavailable"}
	}
	return response, nil
}

func (c *USAClient) request(ctx context.Context, method, path string, body any, accessToken string) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.origin+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero service is unavailable"}
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var envelope usaEnvelope
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero returned an invalid response"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || envelope.Code != 0 {
		status := resp.StatusCode
		if status < 400 {
			status = http.StatusBadRequest
		}
		return nil, &APIError{Status: status, Code: envelope.Code, Reason: envelope.Reason, Message: firstNonEmpty(envelope.Message, "USA-Zero request failed")}
	}
	return envelope.Data, nil
}

func (c *USAClient) appToken(ctx context.Context, values url.Values) (*OAuthTokenResult, error) {
	data, err := c.formRequest(ctx, "/api/v1/app-auth/token", values)
	if err != nil {
		return nil, err
	}
	var result OAuthTokenResult
	if json.Unmarshal(data, &result) != nil || result.AccessToken == "" {
		return nil, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero token response is incomplete"}
	}
	return &result, nil
}

func (c *USAClient) formRequest(ctx context.Context, path string, values url.Values) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.origin+path, strings.NewReader(values.Encode()))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero service is unavailable"}
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var oauthErr struct {
			Error            string `json:"error"`
			ErrorDescription string `json:"error_description"`
		}
		_ = json.Unmarshal(data, &oauthErr)
		return nil, &APIError{Status: resp.StatusCode, Reason: oauthErr.Error, Message: firstNonEmpty(oauthErr.ErrorDescription, "USA-Zero OAuth request failed")}
	}
	return data, nil
}

func (c *USAClient) appRequest(ctx context.Context, method, path string, body any, accessToken string) (json.RawMessage, error) {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.origin+path, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero service is unavailable"}
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	var envelope appEnvelope
	if json.Unmarshal(data, &envelope) != nil {
		return nil, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero returned an invalid app response"}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !envelope.Success {
		return nil, &APIError{Status: resp.StatusCode, Reason: envelope.Error.Code, Message: firstNonEmpty(envelope.Error.Message, envelope.Message, "USA-Zero app request failed")}
	}
	return envelope.Data, nil
}

func decodeLoginResult(data json.RawMessage) (*LoginResult, error) {
	var raw struct {
		Requires2FA     bool            `json:"requires_2fa"`
		TempToken       string          `json:"temp_token"`
		UserEmailMasked string          `json:"user_email_masked"`
		AccessToken     string          `json:"access_token"`
		RefreshToken    string          `json:"refresh_token"`
		ExpiresIn       int             `json:"expires_in"`
		User            json.RawMessage `json:"user"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	result := &LoginResult{
		Requires2FA: raw.Requires2FA, TempToken: raw.TempToken, UserEmailMasked: raw.UserEmailMasked,
		AccessToken: raw.AccessToken, RefreshToken: raw.RefreshToken, ExpiresIn: raw.ExpiresIn, User: raw.User,
	}
	if raw.Requires2FA {
		return result, nil
	}
	if raw.AccessToken == "" || len(raw.User) == 0 {
		return nil, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero login response is incomplete"}
	}
	var user struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(raw.User, &user); err != nil || user.ID <= 0 {
		return nil, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero user identity is invalid"}
	}
	result.UserID = user.ID
	return result, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
