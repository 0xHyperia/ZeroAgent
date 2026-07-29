package account

import (
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const maxRequestBodyBytes = 2 << 20

type HTTPHandler struct {
	service      *Service
	cookieSecure bool
	publicOrigin string
}

func NewHTTPHandler(service *Service, cookieSecure bool, publicOrigin ...string) *HTTPHandler {
	origin := ""
	if len(publicOrigin) > 0 {
		origin = normalizePublicOrigin(publicOrigin[0])
	}
	return &HTTPHandler{service: service, cookieSecure: cookieSecure, publicOrigin: origin}
}

func (h *HTTPHandler) Register(mux *http.ServeMux) {
	h.registerWebChat(mux)
	mux.HandleFunc("GET /api/auth/settings", h.publicSettings)
	mux.HandleFunc("POST /api/auth/send-verify-code", h.sendVerifyCode)
	mux.HandleFunc("POST /api/auth/register", h.registerAccount)
	mux.HandleFunc("POST /api/auth/login", h.login)
	mux.HandleFunc("POST /api/auth/oauth/start", h.startOAuth)
	mux.HandleFunc("GET /api/auth/oauth/callback", h.oauthCallback)
	mux.HandleFunc("POST /api/auth/oauth/complete", h.completeOAuth)
	mux.HandleFunc("GET /api/auth/handoff", h.consumeDesktopHandoff)
	mux.HandleFunc("POST /api/auth/2fa", h.login2FA)
	mux.HandleFunc("POST /api/auth/refresh", h.withSession(h.refresh))
	mux.HandleFunc("POST /api/auth/logout", h.logout)
	mux.HandleFunc("GET /api/auth/me", h.withSession(h.me))
	mux.HandleFunc("GET /api/environments", h.withSession(h.environments))
	mux.HandleFunc("GET /api/conversation-routes", h.withSession(h.conversationRoutes))
	mux.HandleFunc("POST /api/execution-target/select", h.withSession(h.selectTarget))
	mux.HandleFunc("POST /api/devices/register", h.withSession(h.registerDevice))
	mux.HandleFunc("PATCH /api/devices/{id}", h.withSession(h.renameDevice))
	mux.HandleFunc("DELETE /api/devices/{id}", h.withSession(h.revokeDevice))
	mux.HandleFunc("POST /api/devices/{id}/rotate-token", h.withSession(h.rotateDeviceToken))
	mux.HandleFunc("/api/usa-zero/", h.withSession(h.proxyUSAZero))
	mux.HandleFunc("POST /api/desktop/devices/register", h.withDesktopSession(h.registerDevice))
	mux.HandleFunc("PATCH /api/desktop/devices/{id}", h.withDesktopSession(h.renameDevice))
	mux.HandleFunc("DELETE /api/desktop/devices/{id}", h.withDesktopSession(h.revokeDevice))
	mux.HandleFunc("POST /api/desktop/devices/{id}/rotate-token", h.withDesktopSession(h.rotateDeviceToken))
	mux.HandleFunc("GET /api/desktop/environments", h.withDesktopSession(h.desktopEnvironments))
	mux.HandleFunc("GET /api/desktop/conversation-routes", h.withDesktopSession(h.conversationRoutes))
	mux.HandleFunc("POST /api/desktop/execution-target/select", h.withDesktopSession(h.selectTarget))
	mux.HandleFunc("POST /api/desktop/handoff", h.withDesktopSession(h.createDesktopHandoff))
}

func (h *HTTPHandler) startOAuth(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Surface        string `json:"surface"`
		ReturnPath     string `json:"return_path"`
		InstallationID string `json:"installation_id"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	request.Surface = strings.ToLower(strings.TrimSpace(request.Surface))
	redirectURI := "top.usa0.zeroagent:/oauth/callback"
	if request.Surface == "web" {
		origin, err := h.callbackOrigin(r)
		if err != nil {
			writeError(w, err)
			return
		}
		redirectURI = origin + "/api/auth/oauth/callback"
	}
	authorizeURL, err := h.service.StartOAuth(r.Context(), request.Surface, redirectURI, request.ReturnPath, request.InstallationID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"authorize_url": authorizeURL})
}

func (h *HTTPHandler) oauthCallback(w http.ResponseWriter, r *http.Request) {
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	session, returnPath, err := h.service.CompleteOAuth(r.Context(), state, code, "web")
	if err != nil {
		message := "authorization_failed"
		if upstream := strings.TrimSpace(r.URL.Query().Get("error")); upstream != "" {
			message = upstream
		}
		h.redirectOAuthResult(w, r, returnPath, message)
		return
	}
	h.setSessionCookie(w, session)
	h.redirectOAuthResult(w, r, returnPath, "")
}

func (h *HTTPHandler) completeOAuth(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Code  string `json:"code"`
		State string `json:"state"`
		Error string `json:"error"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	if strings.TrimSpace(request.Error) != "" {
		_, _, _ = h.service.CompleteOAuth(r.Context(), request.State, "", "android")
		writeError(w, &APIError{Status: http.StatusBadRequest, Message: request.Error})
		return
	}
	session, _, err := h.service.CompleteOAuth(r.Context(), request.State, request.Code, "android")
	if err != nil {
		writeError(w, err)
		return
	}
	h.setSessionCookie(w, session)
	writeRawObject(w, http.StatusOK, "user", session.User)
}

func (h *HTTPHandler) callbackOrigin(r *http.Request) (string, error) {
	if h.publicOrigin != "" {
		return h.publicOrigin, nil
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	} else if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			forwarded := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0]))
			if forwarded == "http" || forwarded == "https" {
				scheme = forwarded
			}
		}
	}
	origin := normalizePublicOrigin(scheme + "://" + r.Host)
	if origin == "" {
		return "", &APIError{Status: http.StatusBadRequest, Message: "Gateway public origin is invalid"}
	}
	return origin, nil
}

func (h *HTTPHandler) redirectOAuthResult(w http.ResponseWriter, r *http.Request, returnPath, oauthError string) {
	target, err := url.Parse(sanitizeReturnPath(returnPath))
	if err != nil {
		target = &url.URL{Path: "/"}
	}
	query := target.Query()
	if oauthError != "" {
		query.Set("oauth_error", oauthError)
	} else {
		query.Set("oauth", "success")
	}
	target.RawQuery = query.Encode()
	http.Redirect(w, r, target.String(), http.StatusSeeOther)
}

func normalizePublicOrigin(raw string) string {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return ""
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return ""
	}
	parsed.Path = ""
	return strings.TrimRight(parsed.String(), "/")
}

func (h *HTTPHandler) publicSettings(w http.ResponseWriter, r *http.Request) {
	settings, err := h.service.PublicSettings(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, settings)
}

func (h *HTTPHandler) sendVerifyCode(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Email string `json:"email"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	result, err := h.service.SendVerifyCode(r.Context(), request.Email)
	if err != nil {
		writeError(w, err)
		return
	}
	writeRawJSON(w, http.StatusOK, result)
}

func (h *HTTPHandler) registerAccount(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Email          string `json:"email"`
		Password       string `json:"password"`
		VerifyCode     string `json:"verify_code"`
		InvitationCode string `json:"invitation_code"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	result, session, err := h.service.Register(
		r.Context(), request.Email, request.Password, request.VerifyCode, request.InvitationCode,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	h.setSessionCookie(w, session)
	writeRawObject(w, http.StatusOK, "user", result.User)
}

func (h *HTTPHandler) conversationRoutes(w http.ResponseWriter, r *http.Request, session *Session) {
	routes, err := h.service.ConversationRoutesForDevice(r.Context(), session.UserID, r.URL.Query().Get("device_id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": routes})
}

func (h *HTTPHandler) login(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	result, session, err := h.service.Login(r.Context(), request.Email, request.Password)
	if err != nil {
		writeError(w, err)
		return
	}
	if result.Requires2FA {
		writeJSON(w, http.StatusOK, map[string]any{
			"requires_2fa": true, "temp_token": result.TempToken, "user_email_masked": result.UserEmailMasked,
		})
		return
	}
	h.setSessionCookie(w, session)
	writeRawObject(w, http.StatusOK, "user", result.User)
}

func (h *HTTPHandler) login2FA(w http.ResponseWriter, r *http.Request) {
	var request struct {
		TempToken string `json:"temp_token"`
		TOTPCode  string `json:"totp_code"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	result, session, err := h.service.Login2FA(r.Context(), request.TempToken, request.TOTPCode)
	if err != nil {
		writeError(w, err)
		return
	}
	h.setSessionCookie(w, session)
	writeRawObject(w, http.StatusOK, "user", result.User)
}

func (h *HTTPHandler) createDesktopHandoff(w http.ResponseWriter, r *http.Request, session *Session) {
	var request struct {
		SelectionLease string `json:"selection_lease"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	code, err := h.service.CreateDesktopHandoff(r.Context(), session, request.SelectionLease)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"handoff_code": code, "expires_in": 60})
}

func (h *HTTPHandler) consumeDesktopHandoff(w http.ResponseWriter, r *http.Request) {
	session, lease, err := h.service.ConsumeDesktopHandoff(r.Context(), r.URL.Query().Get("code"))
	if err != nil {
		writeError(w, err)
		return
	}
	h.setSessionCookie(w, session)
	query := url.Values{}
	query.Set("selection_lease", lease.ID)
	query.Set("runtime_kind", lease.RuntimeKind)
	query.Set("device_id", lease.DeviceID)
	query.Set("agent_id", lease.AgentID)
	query.Set("workspace_id", lease.WorkspaceID)
	query.Set("conversation_id", lease.ConversationID)
	if r.URL.Query().Get("controller_surface") == "desktop_embed" {
		query.Set("controller_surface", "desktop_embed")
		query.Set("local_device_id", r.URL.Query().Get("local_device_id"))
	}
	http.Redirect(w, r, "/?"+query.Encode(), http.StatusSeeOther)
}

func (h *HTTPHandler) refresh(w http.ResponseWriter, r *http.Request, session *Session) {
	updated, err := h.service.Refresh(r.Context(), session.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	h.setSessionCookie(w, updated)
	writeRawObject(w, http.StatusOK, "user", updated.User)
}

func (h *HTTPHandler) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(SessionCookieName); err == nil {
		_ = h.service.Logout(r.Context(), cookie.Value)
	}
	h.clearSessionCookie(w)
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) me(w http.ResponseWriter, r *http.Request, session *Session) {
	user, err := h.service.RefreshUser(r.Context(), session)
	if err != nil {
		writeError(w, err)
		return
	}
	writeRawObject(w, http.StatusOK, "user", user)
}

func (h *HTTPHandler) environments(w http.ResponseWriter, r *http.Request, session *Session) {
	desktop := strings.EqualFold(strings.TrimSpace(r.URL.Query().Get("surface")), "desktop")
	environments, err := h.service.Environments(r.Context(), session.UserID, desktop, r.URL.Query().Get("local_device_id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"environments": environments})
}

func (h *HTTPHandler) desktopEnvironments(w http.ResponseWriter, r *http.Request, session *Session) {
	environments, err := h.service.Environments(r.Context(), session.UserID, true, r.URL.Query().Get("local_device_id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"environments": environments})
}

func (h *HTTPHandler) selectTarget(w http.ResponseWriter, r *http.Request, session *Session) {
	var request SelectTargetInput
	if !decodeRequest(w, r, &request) {
		return
	}
	lease, err := h.service.SelectTarget(r.Context(), session, request)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, publicSelectionLease(lease))
}

func publicSelectionLease(lease *SelectionLease) map[string]any {
	return map[string]any{
		"selection_lease":    lease.ID,
		"user_id":            lease.UserID,
		"runtime_kind":       lease.RuntimeKind,
		"device_id":          lease.DeviceID,
		"agent_id":           lease.AgentID,
		"workspace_id":       lease.WorkspaceID,
		"scope":              lease.Scope,
		"target_fingerprint": lease.Target,
		"conversation_id":    lease.ConversationID,
		"expires_at":         lease.ExpiresAt,
	}
}

func (h *HTTPHandler) registerDevice(w http.ResponseWriter, r *http.Request, session *Session) {
	var request RegisterDeviceInput
	if !decodeRequest(w, r, &request) {
		return
	}
	device, credential, err := h.service.RegisterDevice(r.Context(), session.UserID, request)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"device": device, "agent_id": device.ID, "agent_token": credential,
		"device_id": device.ID, "device_credential": credential,
	})
}

func (h *HTTPHandler) rotateDeviceToken(w http.ResponseWriter, r *http.Request, session *Session) {
	device, token, err := h.service.RotateDeviceToken(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"device": device, "agent_id": device.ID, "agent_token": token,
		"device_id": device.ID, "device_credential": token,
	})
}

func (h *HTTPHandler) renameDevice(w http.ResponseWriter, r *http.Request, session *Session) {
	var request struct {
		Name string `json:"name"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	device, err := h.service.RenameDevice(r.Context(), session.UserID, r.PathValue("id"), request.Name)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"device": device})
}

func (h *HTTPHandler) revokeDevice(w http.ResponseWriter, r *http.Request, session *Session) {
	if err := h.service.RevokeDevice(r.Context(), session.UserID, r.PathValue("id")); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) proxyUSAZero(w http.ResponseWriter, r *http.Request, session *Session) {
	apiPath := strings.TrimPrefix(r.URL.Path, "/api/usa-zero/")
	if r.URL.RawQuery != "" {
		apiPath += "?" + r.URL.RawQuery
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRequestBodyBytes))
	if err != nil {
		writeError(w, &APIError{Status: http.StatusRequestEntityTooLarge, Message: "request body is too large"})
		return
	}
	data, err := h.service.ProxyUSA(r.Context(), session, r.Method, apiPath, body)
	if err != nil {
		var apiError *APIError
		if errors.As(err, &apiError) {
			writeJSON(w, apiError.Status, map[string]any{
				"code": apiError.Code, "message": apiError.Message, "reason": apiError.Reason,
			})
			return
		}
		writeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"code":0,"message":"success","data":`))
	_, _ = w.Write(data)
	_, _ = w.Write([]byte("}"))
}

type authenticatedHandler func(http.ResponseWriter, *http.Request, *Session)

func (h *HTTPHandler) withSession(next authenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie(SessionCookieName)
		if err != nil || strings.TrimSpace(cookie.Value) == "" {
			writeError(w, &APIError{Status: http.StatusUnauthorized, Message: "account login required"})
			return
		}
		session, err := h.service.Session(r.Context(), cookie.Value)
		if err != nil {
			h.clearSessionCookie(w)
			writeError(w, err)
			return
		}
		next(w, r, session)
	}
}

func (h *HTTPHandler) withDesktopSession(next authenticatedHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		header := strings.TrimSpace(r.Header.Get("Authorization"))
		parts := strings.SplitN(header, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			writeError(w, &APIError{Status: http.StatusUnauthorized, Message: "USA-Zero access token is required"})
			return
		}
		session, err := h.service.DesktopSession(r.Context(), parts[1])
		if err != nil {
			writeError(w, err)
			return
		}
		next(w, r, session)
	}
}

func (h *HTTPHandler) setSessionCookie(w http.ResponseWriter, session *Session) {
	maxAge := int(time.Until(session.SessionExpiresAt).Seconds())
	if maxAge < 1 {
		maxAge = 1
	}
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookieName, Value: session.ID, Path: "/", HttpOnly: true,
		Secure: h.cookieSecure, SameSite: http.SameSiteStrictMode,
		Expires: session.SessionExpiresAt, MaxAge: maxAge,
	})
}

func (h *HTTPHandler) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name: SessionCookieName, Value: "", Path: "/", HttpOnly: true,
		Secure: h.cookieSecure, SameSite: http.SameSiteStrictMode,
		Expires: time.Unix(1, 0), MaxAge: -1,
	})
}

func decodeRequest(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeError(w, &APIError{Status: http.StatusBadRequest, Message: "invalid request body"})
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, &APIError{Status: http.StatusBadRequest, Message: "request body must contain one JSON object"})
		return false
	}
	return true
}

func writeError(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	message := "internal server error"
	code := 0
	reason := ""
	var apiError *APIError
	if errors.As(err, &apiError) {
		status, message, code, reason = apiError.Status, apiError.Message, apiError.Code, apiError.Reason
	}
	if status < 400 {
		status = http.StatusInternalServerError
	}
	writeJSON(w, status, map[string]any{"error": message, "code": code, "reason": reason})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeRawObject(w http.ResponseWriter, status int, key string, value json.RawMessage) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(`{"` + key + `":`))
	_, _ = w.Write(value)
	_, _ = w.Write([]byte("}"))
}

func writeRawJSON(w http.ResponseWriter, status int, value json.RawMessage) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(value)
}
