package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// VerifyPassword checks the current account without creating a ZeroAgent session
// or returning the temporary upstream login credentials to the browser.
func (s *Service) VerifyPassword(ctx context.Context, session *Session, email, password string) error {
	denied := func() error { return &APIError{Status: http.StatusForbidden, Message: "密码验证失败"} }
	var identity struct {
		ID    int64  `json:"id"`
		Email string `json:"email"`
	}
	if session == nil || json.Unmarshal(session.User, &identity) != nil || identity.ID != session.UserID || strings.TrimSpace(identity.Email) == "" || !strings.EqualFold(strings.TrimSpace(email), strings.TrimSpace(identity.Email)) || password == "" {
		return denied()
	}
	result, err := s.usa.Login(ctx, strings.TrimSpace(identity.Email), password)
	if err != nil {
		var apiErr *APIError
		if errors.As(err, &apiErr) && (apiErr.Status == http.StatusBadRequest || apiErr.Status == http.StatusUnauthorized || apiErr.Status == http.StatusForbidden) {
			return denied()
		}
		status := http.StatusBadGateway
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusTooManyRequests {
			status = http.StatusTooManyRequests
		}
		return &APIError{Status: status, Message: "暂时无法验证密码，请稍后重试"}
	}
	if result == nil || (!result.Requires2FA && result.UserID != session.UserID) || (result.Requires2FA && strings.TrimSpace(result.TempToken) == "") {
		return denied()
	}
	// A pending proof must not approve a session revoked while USA-Zero was replying.
	current, err := s.store.GetSession(ctx, session.ID)
	if err != nil || current == nil || current.UserID != session.UserID || current.AuthKind != session.AuthKind || current.OAuthClientID != session.OAuthClientID {
		return &APIError{Status: http.StatusUnauthorized, Message: "account session is missing or expired"}
	}
	return nil
}

func (h *HTTPHandler) verifyPassword(w http.ResponseWriter, r *http.Request, session *Session) {
	var input struct {
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if !decodeRequest(w, r, &input) {
		return
	}
	if err := h.service.VerifyPassword(r.Context(), session, input.Email, input.Password); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"verified": true})
}
