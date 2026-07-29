package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func newTestUSAZero(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		writeEnvelope := func(data string) { _, _ = fmt.Fprintf(w, `{"code":0,"message":"success","data":%s}`, data) }
		switch r.URL.Path {
		case "/api/v1/settings/public":
			writeEnvelope(`{"registration_enabled":true,"email_verify_enabled":true,"invitation_code_enabled":false,"turnstile_enabled":false}`)
		case "/api/v1/auth/send-verify-code":
			writeEnvelope(`{"message":"verification code sent","countdown":60}`)
		case "/api/v1/auth/register":
			body, _ := io.ReadAll(r.Body)
			if !bytes.Contains(body, []byte(`"verify_code":"123456"`)) {
				t.Fatalf("registration payload missing verification code: %s", body)
			}
			writeEnvelope(`{"access_token":"register-access","refresh_token":"register-refresh","expires_in":3600,"user":{"id":3,"email":"new@example.com"}}`)
		case "/api/v1/auth/login":
			body, _ := io.ReadAll(r.Body)
			if bytes.Contains(body, []byte("two@example.com")) {
				writeEnvelope(`{"requires_2fa":true,"temp_token":"temp-2fa","user_email_masked":"t***@example.com"}`)
				return
			}
			writeEnvelope(`{"access_token":"access-1","refresh_token":"refresh-1","expires_in":3600,"user":{"id":1,"email":"one@example.com"}}`)
		case "/api/v1/auth/login/2fa":
			writeEnvelope(`{"access_token":"access-1","refresh_token":"refresh-1","expires_in":3600,"user":{"id":1,"email":"one@example.com"}}`)
		case "/api/v1/auth/me":
			if r.Header.Get("Authorization") == "Bearer access-2" {
				writeEnvelope(`{"id":2,"email":"two@example.com"}`)
			} else {
				writeEnvelope(`{"id":1,"email":"one@example.com"}`)
			}
		case "/api/v1/user/step-up":
			writeEnvelope(`{"proof":"proof-1","expires_in":60}`)
		case "/api/v1/user/step-up/consume":
			writeEnvelope(`{"valid":true,"user_id":1}`)
		case "/api/v1/keys":
			if r.Header.Get("Authorization") == "Bearer oauth-access" {
				http.Error(w, "app tokens cannot use user key routes", http.StatusUnauthorized)
				return
			}
			if r.Header.Get("Authorization") == "Bearer access-2" {
				writeEnvelope(`{"items":[{"id":42,"key":"web-key-2","name":"User Two","status":"active"}],"total":1,"page":1,"page_size":1000,"pages":1}`)
			} else {
				writeEnvelope(`{"items":[{"id":41,"key":"web-key-1","name":"ZeroAgent Web","status":"active"}],"total":1,"page":1,"page_size":1000,"pages":1}`)
			}
		case "/api/v1/app/keys":
			if r.Header.Get("Authorization") != "Bearer oauth-access" {
				http.Error(w, `{"success":false,"error":{"code":"invalid_token","message":"invalid token"}}`, http.StatusUnauthorized)
				return
			}
			_, _ = io.WriteString(w, `{"success":true,"message":"success","data":{"items":[{"id":41,"key":"web-key-1","name":"ZeroAgent Web","status":"active"}],"total":1}}`)
		case "/v1/models":
			if r.Header.Get("Authorization") != "Bearer web-key-1" {
				http.Error(w, `{"error":"invalid key"}`, http.StatusUnauthorized)
				return
			}
			_, _ = io.WriteString(w, `{"data":[{"id":"gpt-5.1"},{"id":"gpt-5.2"}]}`)
		case "/v1/chat/completions":
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\n")
			_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"world\"}}],\"usage\":{\"total_tokens\":3}}\n\n")
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func newAccountTestRuntime(t *testing.T) (*Service, *MemoryStore, http.Handler) {
	t.Helper()
	usa := newTestUSAZero(t)
	store := NewMemoryStore()
	client := NewUSAClientWithHTTPClient(usa.URL, usa.Client())
	service := NewService(store, client, time.Hour, time.Hour)
	mux := http.NewServeMux()
	NewHTTPHandler(service, true).Register(mux)
	return service, store, mux
}

func TestAccountLoginUsesSecureHttpOnlyCookieAndDoesNotExposeTokens(t *testing.T) {
	_, _, handler := newAccountTestRuntime(t)
	req := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"email":"one@example.com","password":"password"}`))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("login status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "access-1") || strings.Contains(rec.Body.String(), "refresh-1") {
		t.Fatalf("login response leaked USA tokens: %s", rec.Body.String())
	}
	cookies := rec.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != SessionCookieName || !cookies[0].HttpOnly || !cookies[0].Secure || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("unexpected session cookie: %#v", cookies)
	}
}

func TestPublicRegistrationSettingsAndVerificationCodeDoNotRequireSession(t *testing.T) {
	_, _, handler := newAccountTestRuntime(t)

	settings := httptest.NewRecorder()
	handler.ServeHTTP(settings, httptest.NewRequest(http.MethodGet, "/api/auth/settings", nil))
	if settings.Code != http.StatusOK || !strings.Contains(settings.Body.String(), `"registration_enabled":true`) {
		t.Fatalf("settings status=%d body=%s", settings.Code, settings.Body.String())
	}

	verify := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/auth/send-verify-code", strings.NewReader(`{"email":"new@example.com"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(verify, request)
	if verify.Code != http.StatusOK || !strings.Contains(verify.Body.String(), `"countdown":60`) {
		t.Fatalf("verification status=%d body=%s", verify.Code, verify.Body.String())
	}
}

func TestAccountRegistrationCreatesCookieSessionWithoutExposingTokens(t *testing.T) {
	_, _, handler := newAccountTestRuntime(t)
	request := httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(
		`{"email":"new@example.com","password":"password","verify_code":"123456","invitation_code":""}`,
	))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("registration status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "register-access") || strings.Contains(response.Body.String(), "register-refresh") {
		t.Fatalf("registration response leaked USA tokens: %s", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"email":"new@example.com"`) {
		t.Fatalf("registration response omitted user: %s", response.Body.String())
	}
	cookies := response.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != SessionCookieName || !cookies[0].HttpOnly || !cookies[0].Secure {
		t.Fatalf("unexpected registration cookie: %#v", cookies)
	}
}

func TestOAuthTransactionIsAtomicAndExpires(t *testing.T) {
	store := NewMemoryStore()
	now := time.Now().UTC()
	store.now = func() time.Time { return now }
	transaction := &OAuthTransaction{State: "state", ExpiresAt: now.Add(time.Minute)}
	if err := store.PutOAuthTransaction(context.Background(), "hash", transaction); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ConsumeOAuthTransaction(context.Background(), "hash"); err != nil {
		t.Fatalf("first consume: %v", err)
	}
	if _, err := store.ConsumeOAuthTransaction(context.Background(), "hash"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("replay consume = %v, want ErrNotFound", err)
	}
	if err := store.PutOAuthTransaction(context.Background(), "expired", &OAuthTransaction{ExpiresAt: now.Add(time.Second)}); err != nil {
		t.Fatal(err)
	}
	now = now.Add(2 * time.Second)
	if _, err := store.ConsumeOAuthTransaction(context.Background(), "expired"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired consume = %v, want ErrNotFound", err)
	}
}

func TestOAuthStartPreservesUSAZeroErrorDetails(t *testing.T) {
	usa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, `{"error":"invalid_client","error_description":"client authentication failed"}`)
	}))
	defer usa.Close()

	service := NewService(NewMemoryStore(), NewUSAClientWithHTTPClient(usa.URL, usa.Client(), "zeroagent-test-web-client-secret-32-bytes"), time.Hour, time.Hour)
	mux := http.NewServeMux()
	NewHTTPHandler(service, false, "http://127.0.0.1:50052").Register(mux)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/auth/oauth/start", strings.NewReader(`{"surface":"web"}`))
	request.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest || !strings.Contains(recorder.Body.String(), "client authentication failed") || !strings.Contains(recorder.Body.String(), "invalid_client") {
		t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
	}
}

func TestOAuthStartCallbackCreatesTypedCookieSessionAndRejectsReplay(t *testing.T) {
	var issuedState string
	usa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/app-auth/authorize/requests":
			var payload map[string]any
			_ = json.NewDecoder(r.Body).Decode(&payload)
			issuedState, _ = payload["state"].(string)
			if payload["client_id"] != "zeroagent-web" || payload["redirect_uri"] != "https://gateway.example.com/api/auth/oauth/callback" {
				t.Fatalf("unexpected authorization payload: %#v", payload)
			}
			w.WriteHeader(http.StatusCreated)
			_, _ = io.WriteString(w, `{"request_id":"request-1","expires_in":300,"authorization_uri":"/oauth/authorize?request_id=request-1"}`)
		case "/api/v1/app-auth/token":
			_ = r.ParseForm()
			clientID, clientSecret, ok := r.BasicAuth()
			if !ok || clientID != "zeroagent-web" || clientSecret != "zeroagent-test-web-client-secret-32-bytes" || r.Form.Get("code") != "code-1" || r.Form.Get("client_id") != "" || r.Form.Get("code_verifier") == "" {
				t.Fatalf("unexpected token form: %v", r.Form)
			}
			_, _ = io.WriteString(w, `{"access_token":"app-access","refresh_token":"app-refresh","token_type":"Bearer","expires_in":600,"scope":"profile:read"}`)
		case "/api/v1/app/me":
			_, _ = io.WriteString(w, `{"success":true,"message":"success","data":{"id":9,"email":"oauth@example.com"}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer usa.Close()
	store := NewMemoryStore()
	service := NewService(store, NewUSAClientWithHTTPClient(usa.URL, usa.Client(), "zeroagent-test-web-client-secret-32-bytes"), time.Hour, time.Hour)
	mux := http.NewServeMux()
	NewHTTPHandler(service, true, "https://gateway.example.com").Register(mux)

	start := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/auth/oauth/start", strings.NewReader(`{"surface":"web","return_path":"/login?from=oauth"}`))
	request.Header.Set("Content-Type", "application/json")
	mux.ServeHTTP(start, request)
	if start.Code != http.StatusOK || issuedState == "" || !strings.Contains(start.Body.String(), "request-1") {
		t.Fatalf("start status=%d state=%q body=%s", start.Code, issuedState, start.Body.String())
	}

	callbackURL := "/api/auth/oauth/callback?code=code-1&state=" + url.QueryEscape(issuedState)
	callback := httptest.NewRecorder()
	mux.ServeHTTP(callback, httptest.NewRequest(http.MethodGet, callbackURL, nil))
	if callback.Code != http.StatusSeeOther || callback.Header().Get("Location") != "/login?from=oauth&oauth=success" {
		t.Fatalf("callback status=%d location=%q body=%s", callback.Code, callback.Header().Get("Location"), callback.Body.String())
	}
	cookies := callback.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookies=%#v", cookies)
	}
	session, err := store.GetSession(context.Background(), cookies[0].Value)
	if err != nil || !session.IsOAuth() || session.OAuthClientID != "zeroagent-web" || session.UserID != 9 {
		t.Fatalf("oauth session=%#v err=%v", session, err)
	}

	replay := httptest.NewRecorder()
	mux.ServeHTTP(replay, httptest.NewRequest(http.MethodGet, callbackURL, nil))
	if replay.Code != http.StatusSeeOther || !strings.Contains(replay.Header().Get("Location"), "oauth_error=authorization_failed") {
		t.Fatalf("replay status=%d location=%q", replay.Code, replay.Header().Get("Location"))
	}
}

func TestDeviceOwnershipSelectionAndDesktopHandoffAreIsolated(t *testing.T) {
	service, _, _ := newAccountTestRuntime(t)
	ctx := context.Background()
	desktop1, err := service.DesktopSession(ctx, "access-1")
	if err != nil {
		t.Fatal(err)
	}
	desktop2, err := service.DesktopSession(ctx, "access-2")
	if err != nil {
		t.Fatal(err)
	}
	device, credential, err := service.RegisterDevice(ctx, desktop1.UserID, RegisterDeviceInput{
		InstallationID: "installation-1", Name: "Office PC", Platform: "windows", Version: "1.0.0",
		Workspaces: []Workspace{{ID: "workspace-1", Name: "ZeroAgent", Path: `E:\code\ZeroAgent`}},
	})
	if err != nil || credential == "" {
		t.Fatalf("register device: credential=%q err=%v", credential, err)
	}
	if err := service.store.SetDevicePresence(ctx, device.ID, true, time.Now().UTC()); err != nil {
		t.Fatal(err)
	}
	if _, err := service.store.GetDevice(ctx, desktop2.UserID, device.ID); err != ErrNotFound {
		t.Fatalf("second user accessed first user's device: %v", err)
	}
	target := TargetFingerprint(RuntimeKindDeviceAgent, device.ID, "workspace-1")
	lease, err := service.SelectTarget(ctx, desktop1, SelectTargetInput{
		Proof: "proof-1", RuntimeKind: RuntimeKindDeviceAgent, DeviceID: device.ID,
		WorkspaceID: "workspace-1", Target: target,
	})
	if err != nil {
		t.Fatal(err)
	}
	deviceTarget := TargetFingerprint(RuntimeKindDeviceAgent, device.ID, "")
	deviceLease, err := service.SelectTarget(ctx, desktop1, SelectTargetInput{
		Proof: "proof-2", RuntimeKind: RuntimeKindDeviceAgent, DeviceID: device.ID,
		Scope: SelectionScopeDevice, Target: deviceTarget,
	})
	if err != nil {
		t.Fatal(err)
	}
	if deviceLease.EffectiveScope() != SelectionScopeDevice || deviceLease.WorkspaceID != "" {
		t.Fatalf("unexpected device-scoped lease: %#v", deviceLease)
	}
	if _, err := service.SelectTarget(ctx, desktop1, SelectTargetInput{
		Proof: "proof-3", RuntimeKind: RuntimeKindDeviceAgent, DeviceID: device.ID,
		WorkspaceID: "workspace-1", Scope: SelectionScopeDevice, Target: target,
	}); err == nil {
		t.Fatal("device-scoped selection accepted workspace_id")
	}
	if _, err := service.SelectTarget(ctx, desktop2, SelectTargetInput{
		Proof: "proof-1", RuntimeKind: RuntimeKindDeviceAgent, DeviceID: device.ID,
		WorkspaceID: "workspace-1", Target: target,
	}); err == nil {
		t.Fatal("second user selected first user's device")
	}
	code, err := service.CreateDesktopHandoff(ctx, desktop1, lease.ID)
	if err != nil {
		t.Fatal(err)
	}
	browserSession, browserLease, err := service.ConsumeDesktopHandoff(ctx, code)
	if err != nil {
		t.Fatal(err)
	}
	if browserSession.UserID != 1 || browserLease.DeviceID != device.ID || browserLease.ControllerID != browserSession.ID {
		t.Fatalf("handoff binding mismatch: session=%#v lease=%#v", browserSession, browserLease)
	}
	if _, _, err := service.ConsumeDesktopHandoff(ctx, code); err == nil {
		t.Fatal("desktop handoff code was replayable")
	}
}

func TestDesktopDeviceManagementUsesAccountIdentity(t *testing.T) {
	service, _, handler := newAccountTestRuntime(t)
	device, _, err := service.RegisterDevice(context.Background(), 1, RegisterDeviceInput{
		InstallationID: "installation-managed", Name: "Old name", Platform: "windows", Version: "1.0.0",
		Workspaces: []Workspace{{ID: "workspace-1", Name: "ZeroAgent", Path: `E:\code\ZeroAgent`}},
	})
	if err != nil {
		t.Fatal(err)
	}

	rename := httptest.NewRequest(http.MethodPatch, "/api/desktop/devices/"+device.ID, strings.NewReader(`{"name":"Renamed PC"}`))
	rename.SetPathValue("id", device.ID)
	rename.Header.Set("Authorization", "Bearer access-1")
	rename.Header.Set("Content-Type", "application/json")
	renameResult := httptest.NewRecorder()
	handler.ServeHTTP(renameResult, rename)
	if renameResult.Code != http.StatusOK || !strings.Contains(renameResult.Body.String(), "Renamed PC") {
		t.Fatalf("rename status=%d body=%s", renameResult.Code, renameResult.Body.String())
	}

	foreignDelete := httptest.NewRequest(http.MethodDelete, "/api/desktop/devices/"+device.ID, nil)
	foreignDelete.SetPathValue("id", device.ID)
	foreignDelete.Header.Set("Authorization", "Bearer access-2")
	foreignDeleteResult := httptest.NewRecorder()
	handler.ServeHTTP(foreignDeleteResult, foreignDelete)
	if foreignDeleteResult.Code != http.StatusNotFound {
		t.Fatalf("foreign delete status=%d body=%s", foreignDeleteResult.Code, foreignDeleteResult.Body.String())
	}

	remove := httptest.NewRequest(http.MethodDelete, "/api/desktop/devices/"+device.ID, nil)
	remove.SetPathValue("id", device.ID)
	remove.Header.Set("Authorization", "Bearer access-1")
	removeResult := httptest.NewRecorder()
	handler.ServeHTTP(removeResult, remove)
	if removeResult.Code != http.StatusNoContent {
		t.Fatalf("delete status=%d body=%s", removeResult.Code, removeResult.Body.String())
	}
}

func TestAgentRegistrationLegacyUpgradeAndRotation(t *testing.T) {
	service, _, _ := newAccountTestRuntime(t)
	ctx := context.Background()
	device, token, err := service.RegisterDevice(ctx, 1, RegisterDeviceInput{
		InstallationID: "agent-identity", Name: "Desktop", Platform: "windows", Version: "1.0.0",
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(device.ID, "agent-") || !strings.HasPrefix(token, "agt_") || device.TokenIssuedAt.IsZero() {
		t.Fatalf("canonical registration missing: device=%#v token=%q", device, token)
	}
	legacyID := strings.TrimPrefix(device.ID, "agent-")
	resolved, _, err := service.AuthenticateAgent("", "", legacyID, token)
	if err != nil || resolved != device.ID {
		t.Fatalf("legacy hello did not resolve canonical agent: id=%q err=%v", resolved, err)
	}

	before := device.TokenIssuedAt
	rotated, nextToken, err := service.RotateDeviceToken(ctx, 1, device.ID)
	if err != nil {
		t.Fatal(err)
	}
	if nextToken == token || !strings.HasPrefix(nextToken, "agt_") || rotated.TokenIssuedAt.Before(before) {
		t.Fatalf("invalid rotation result: device=%#v token=%q", rotated, nextToken)
	}
	if _, _, err := service.AuthenticateAgent(device.ID, token, "", ""); !errors.Is(err, ErrUnauthorizedAgent) {
		t.Fatalf("old token remained valid after rotation: %v", err)
	}
	if resolved, _, err := service.AuthenticateAgent(device.ID, nextToken, "", ""); err != nil || resolved != device.ID {
		t.Fatalf("rotated token was rejected: id=%q err=%v", resolved, err)
	}
	if _, _, err := service.RotateDeviceToken(ctx, 2, device.ID); err == nil {
		t.Fatal("foreign account rotated an owned agent token")
	}
}

func TestRegistrationRejectsMalformedProvidedAgentID(t *testing.T) {
	service, _, _ := newAccountTestRuntime(t)
	_, _, err := service.RegisterDevice(context.Background(), 1, RegisterDeviceInput{
		InstallationID: "bad-agent-id", AgentID: "manual-agent",
	})
	var apiError *APIError
	if !errors.As(err, &apiError) || apiError.Status != http.StatusBadRequest {
		t.Fatalf("malformed agent id error = %v, want bad request", err)
	}
}

func TestWebChatStreamsAndPersistsAccountHistory(t *testing.T) {
	service, store, handler := newAccountTestRuntime(t)
	now := time.Now().UTC()
	session := &Session{
		ID: "browser-session", UserID: 1, User: json.RawMessage(`{"id":1,"email":"one@example.com"}`),
		AccessToken: "access-1", AccessExpiresAt: now.Add(time.Hour), SessionExpiresAt: now.Add(time.Hour),
	}
	if err := store.PutSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	conversation, err := service.CreateCloudConversation(context.Background(), 1, "gpt-5.1")
	if err != nil {
		t.Fatal(err)
	}
	rename := httptest.NewRequest(http.MethodPatch, "/api/web-chat/conversations/"+conversation.ID, strings.NewReader(`{"title":"Cloud project"}`))
	rename.SetPathValue("id", conversation.ID)
	rename.AddCookie(&http.Cookie{Name: SessionCookieName, Value: session.ID})
	rename.Header.Set("Content-Type", "application/json")
	renameResult := httptest.NewRecorder()
	handler.ServeHTTP(renameResult, rename)
	if renameResult.Code != http.StatusOK || !strings.Contains(renameResult.Body.String(), `"title":"Cloud project"`) {
		t.Fatalf("rename status=%d body=%s", renameResult.Code, renameResult.Body.String())
	}
	body := fmt.Sprintf(`{"conversation_id":%q,"model":"gpt-5.1","content":"Hi"}`, conversation.ID)
	req := httptest.NewRequest(http.MethodPost, "/api/web-chat/completions", strings.NewReader(body))
	req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: session.ID})
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "Hello ") || !strings.Contains(rec.Body.String(), "world") {
		t.Fatalf("stream status=%d body=%s", rec.Code, rec.Body.String())
	}
	messages, err := store.ListCloudMessages(context.Background(), 1, conversation.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 || messages[0].Role != "user" || messages[1].Role != "assistant" || string(messages[1].Content) != `"Hello world"` {
		t.Fatalf("persisted messages=%#v", messages)
	}
}

func TestWebSettingsPersistPerAccount(t *testing.T) {
	_, store, handler := newAccountTestRuntime(t)
	now := time.Now().UTC()
	for _, session := range []*Session{
		{ID: "user-one", UserID: 1, User: json.RawMessage(`{"id":1}`), AccessToken: "access-1", AccessExpiresAt: now.Add(time.Hour), SessionExpiresAt: now.Add(time.Hour)},
		{ID: "user-two", UserID: 2, User: json.RawMessage(`{"id":2}`), AccessToken: "access-2", AccessExpiresAt: now.Add(time.Hour), SessionExpiresAt: now.Add(time.Hour)},
	} {
		if err := store.PutSession(context.Background(), session); err != nil {
			t.Fatal(err)
		}
	}

	update := httptest.NewRequest(http.MethodPatch, "/api/web-settings", strings.NewReader(`{"model":"gpt-5.2","reasoning_effort":"high"}`))
	update.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "user-one"})
	update.Header.Set("Content-Type", "application/json")
	updateResult := httptest.NewRecorder()
	handler.ServeHTTP(updateResult, update)
	if updateResult.Code != http.StatusOK {
		t.Fatalf("update status=%d body=%s", updateResult.Code, updateResult.Body.String())
	}

	read := func(sessionID string) string {
		req := httptest.NewRequest(http.MethodGet, "/api/web-settings", nil)
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: sessionID})
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, req)
		if result.Code != http.StatusOK {
			t.Fatalf("read status=%d body=%s", result.Code, result.Body.String())
		}
		return result.Body.String()
	}
	if body := read("user-one"); !strings.Contains(body, `"model":"gpt-5.2"`) || !strings.Contains(body, `"reasoning_effort":"high"`) {
		t.Fatalf("updated settings missing: %s", body)
	}
	if body := read("user-two"); !strings.Contains(body, `"model":"gpt-5.1"`) || !strings.Contains(body, `"reasoning_effort":"medium"`) {
		t.Fatalf("defaults or account isolation missing: %s", body)
	}
}

func TestWebProviderModelsRequireAnOwnedActiveKey(t *testing.T) {
	_, store, handler := newAccountTestRuntime(t)
	now := time.Now().UTC()
	session := &Session{
		ID: "provider-models-user-one", UserID: 1, User: json.RawMessage(`{"id":1}`),
		AccessToken: "access-1", AccessExpiresAt: now.Add(time.Hour), SessionExpiresAt: now.Add(time.Hour),
	}
	if err := store.PutSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	oauthSession := &Session{
		ID: "provider-models-oauth", UserID: 1, User: json.RawMessage(`{"id":1}`),
		AccessToken: "oauth-access", AccessExpiresAt: now.Add(time.Hour), SessionExpiresAt: now.Add(time.Hour),
		AuthKind: AuthKindOAuth,
	}
	if err := store.PutSession(context.Background(), oauthSession); err != nil {
		t.Fatal(err)
	}

	request := func(keyID, sessionID string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/web-chat/provider-keys/"+keyID+"/models", nil)
		req.SetPathValue("id", keyID)
		if sessionID != "" {
			req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: sessionID})
		}
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, req)
		return result
	}

	owned := request("41", session.ID)
	if owned.Code != http.StatusOK || !strings.Contains(owned.Body.String(), `"gpt-5.2"`) {
		t.Fatalf("owned key models status=%d body=%s", owned.Code, owned.Body.String())
	}
	oauthOwned := request("41", oauthSession.ID)
	if oauthOwned.Code != http.StatusOK || !strings.Contains(oauthOwned.Body.String(), `"gpt-5.2"`) {
		t.Fatalf("OAuth-owned key models status=%d body=%s", oauthOwned.Code, oauthOwned.Body.String())
	}
	foreign := request("42", session.ID)
	if foreign.Code != http.StatusNotFound {
		t.Fatalf("foreign key models status=%d body=%s", foreign.Code, foreign.Body.String())
	}
	unauthenticated := request("41", "")
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated models status=%d body=%s", unauthenticated.Code, unauthenticated.Body.String())
	}
}

func TestWebChatCompletionUsesOnlyTheSelectedUsersProviderKey(t *testing.T) {
	service, store, handler := newAccountTestRuntime(t)
	now := time.Now().UTC()
	session := &Session{
		ID: "provider-completion-user-one", UserID: 1, User: json.RawMessage(`{"id":1}`),
		AccessToken: "access-1", AccessExpiresAt: now.Add(time.Hour), SessionExpiresAt: now.Add(time.Hour),
	}
	if err := store.PutSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	conversation, err := service.CreateCloudConversation(context.Background(), 1, "gpt-5.2")
	if err != nil {
		t.Fatal(err)
	}
	request := func(keyID int64) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"conversation_id":%q,"model":"gpt-5.2","provider_key_id":%d,"content":"Hi"}`,
			conversation.ID, keyID)
		req := httptest.NewRequest(http.MethodPost, "/api/web-chat/completions", strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: session.ID})
		req.Header.Set("Content-Type", "application/json")
		result := httptest.NewRecorder()
		handler.ServeHTTP(result, req)
		return result
	}

	if foreign := request(42); foreign.Code != http.StatusNotFound {
		t.Fatalf("foreign provider key status=%d body=%s", foreign.Code, foreign.Body.String())
	}
	if messages, err := store.ListCloudMessages(context.Background(), 1, conversation.ID); err != nil || len(messages) != 0 {
		t.Fatalf("foreign provider key mutated conversation: messages=%#v err=%v", messages, err)
	}
	if owned := request(41); owned.Code != http.StatusOK || !strings.Contains(owned.Body.String(), "Hello") {
		t.Fatalf("owned provider key status=%d body=%s", owned.Code, owned.Body.String())
	}
}

func TestDeviceHistoryRoutesRemainVisibleWhenDeviceIsOffline(t *testing.T) {
	service, _, handler := newAccountTestRuntime(t)
	ctx := context.Background()
	device, _, err := service.RegisterDevice(ctx, 1, RegisterDeviceInput{
		InstallationID: "history-device", Name: "Home PC", Platform: "windows", Version: "1.0.0",
		Workspaces: []Workspace{{ID: "workspace-home", Name: "Home", Path: `E:\code\home`}},
	})
	if err != nil {
		t.Fatal(err)
	}
	conversationID := "46a06475-4cb9-4216-ab00-c229fe33b784"
	service.RecordDeviceHistorySync(1, device.ID, &gatewayv2.HistorySyncEvent{
		Kind: "upsert", ConversationId: conversationID,
		Conversation: &gatewayv2.ConversationSummary{
			Id: conversationID, Title: "Offline summary", Cwd: `E:\code\home`,
			Model: "gpt-5.1", MessageCount: 4, CreatedAt: 1_700_000_000_000, UpdatedAt: 1_700_000_001_000,
		},
	})
	if err := service.MarkDeviceOffline(ctx, device.ID); err != nil {
		t.Fatal(err)
	}
	routes, err := service.ConversationRoutes(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(routes) != 1 || routes[0].WorkspaceID != "workspace-home" || routes[0].DeviceOnline || routes[0].Summary != "4 条消息 · gpt-5.1" {
		t.Fatalf("unexpected offline route: %#v", routes)
	}
	filtered, err := service.ConversationRoutesForDevice(ctx, 1, device.ID)
	if err != nil || len(filtered) != 1 || filtered[0].DeviceID != device.ID {
		t.Fatalf("device-filtered routes=%#v err=%v", filtered, err)
	}
	filtered, err = service.ConversationRoutesForDevice(ctx, 1, "3e22f236-e821-4352-8eb7-2c9ac2a86f63")
	if err != nil || len(filtered) != 0 {
		t.Fatalf("foreign device filter returned routes=%#v err=%v", filtered, err)
	}

	endpoint := "/api/desktop/conversation-routes?device_id=" + device.ID
	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, endpoint, nil))
	if unauthenticated.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated routes status=%d body=%s", unauthenticated.Code, unauthenticated.Body.String())
	}

	ownerRequest := httptest.NewRequest(http.MethodGet, endpoint, nil)
	ownerRequest.Header.Set("Authorization", "Bearer access-1")
	owner := httptest.NewRecorder()
	handler.ServeHTTP(owner, ownerRequest)
	if owner.Code != http.StatusOK || !strings.Contains(owner.Body.String(), conversationID) {
		t.Fatalf("owner routes status=%d body=%s", owner.Code, owner.Body.String())
	}

	foreignRequest := httptest.NewRequest(http.MethodGet, endpoint, nil)
	foreignRequest.Header.Set("Authorization", "Bearer access-2")
	foreign := httptest.NewRecorder()
	handler.ServeHTTP(foreign, foreignRequest)
	if foreign.Code != http.StatusOK || strings.Contains(foreign.Body.String(), conversationID) {
		t.Fatalf("foreign routes status=%d body=%s", foreign.Code, foreign.Body.String())
	}

	service.RecordDeviceHistorySync(1, device.ID, &gatewayv2.HistorySyncEvent{Kind: "delete", ConversationId: conversationID})
	routes, err = service.ConversationRoutes(ctx, 1)
	if err != nil || len(routes) != 0 {
		t.Fatalf("deleted route remained: routes=%#v err=%v", routes, err)
	}
}
