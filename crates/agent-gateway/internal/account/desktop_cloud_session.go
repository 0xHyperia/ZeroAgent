package account

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

const desktopCloudAccessPurpose = "desktop_cloud_access"
const desktopCloudAccessPrefix = "desktop-cloud:"

func desktopCloudRoute(method, path string) bool {
	if strings.HasPrefix(path, "/api/web-chat/") {
		return true
	}
	if path == "/api/web-settings" {
		return method == http.MethodGet || method == http.MethodPatch
	}
	return method == http.MethodGet && (path == "/api/auth/me" || path == "/api/environments")
}

func isDesktopCloudPurpose(purpose string) bool {
	return purpose == desktopCloudAccessPurpose || purpose == "desktop_cloud" || purpose == desktopCloudExecutionPurpose
}

func desktopBearer(r *http.Request) string {
	scheme, token, ok := strings.Cut(strings.TrimSpace(r.Header.Get("Authorization")), " ")
	if !ok || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}

func (h *HTTPHandler) serveDesktopCloud(w http.ResponseWriter, r *http.Request, next authenticatedHandler) {
	session, err := h.service.desktopCloudAccess(r.Context(), desktopBearer(r))
	if err != nil {
		writeError(w, err)
		return
	}
	if !matchesRequestAccount(w, r, session) {
		return
	}
	if err := h.service.store.PutSession(r.Context(), session); err != nil {
		writeError(w, sessionStorageError())
		return
	}
	next(w, r, session)
}

func (s *Service) desktopCloudAccess(ctx context.Context, token string) (*Session, error) {
	var claims struct {
		ClientID   string `json:"client_id"`
		TokenUse   string `json:"token_use"`
		Delegation string `json:"delegation"`
		Subject    string `json:"sub"`
		GrantID    string `json:"grant_id"`
		SessionID  string `json:"session_id"`
		FamilyID   string `json:"family_id"`
		Expires    int64  `json:"exp"`
	}
	parts := strings.SplitN(token, ".", 4)
	if len(parts) != 3 || len(token) > 8192 {
		return nil, sessionMissingError()
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || json.Unmarshal(payload, &claims) != nil ||
		claims.TokenUse != "app" || claims.ClientID != "zeroagent-desktop" || claims.Delegation != "" ||
		claims.GrantID == "" || claims.SessionID == "" || claims.FamilyID == "" {
		return nil, sessionMissingError()
	}
	userID, err := strconv.ParseInt(claims.Subject, 10, 64)
	expires := time.Unix(claims.Expires, 0).UTC()
	if err != nil || userID <= 0 || !expires.After(s.now()) {
		return nil, sessionMissingError()
	}
	// AppMe verifies the signature, active desktop authorization and account.
	// Only after verification may claims be used to identify an execution reference.
	user, err := s.usa.AppMe(ctx, token)
	if err != nil {
		return nil, err
	}
	if !sessionUserMatches(user, userID) {
		return nil, sessionMissingError()
	}
	identity, err := json.Marshal([]string{claims.Subject, claims.GrantID, claims.SessionID, claims.FamilyID})
	if err != nil {
		return nil, err
	}
	return &Session{
		ID: desktopCloudAccessPrefix + hashToken(string(identity)), UserID: userID,
		User: markOAuthUser(user), AccessToken: token, AuthKind: AuthKindOAuth,
		OAuthClientID: claims.ClientID, Purpose: desktopCloudAccessPurpose,
		AccessExpiresAt: expires, SessionExpiresAt: expires,
	}, nil
}

// Keep a private reference for existing Cloud Run workers. Replace it only
// with a later native access token so a slow request cannot undo rotation.
// The reference expires with the native token and has no refresh credential.
var putDesktopCloudAccessScript = redis.NewScript(`
local previous = redis.call("GET", KEYS[1])
if previous and cjson.decode(previous).access_expires_at >= ARGV[2] then return 0 end
redis.call("SET", KEYS[1], ARGV[1], "PX", ARGV[3])
redis.call("PEXPIRE", KEYS[2], ARGV[3])
return 1
`)
