package account

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// VerifyPassword checks the current account without creating a ZeroAgent session
// or returning the temporary upstream login credentials to the browser.
func (s *Service) VerifyPassword(ctx context.Context, session *Session, email, password string) (err error) {
	current, err := s.currentManagedWebSession(ctx, session)
	if err != nil {
		return err
	}
	var identity struct {
		ID    int64  `json:"id"`
		Email string `json:"email"`
	}
	if json.Unmarshal(current.User, &identity) != nil || identity.ID != current.UserID || strings.TrimSpace(identity.Email) == "" || !strings.EqualFold(strings.TrimSpace(email), strings.TrimSpace(identity.Email)) || password == "" || len(password) > 2048 {
		return passwordProofDenied()
	}
	// Parse even a failed response privately: a platform can have issued a
	// refresh credential before returning an invalid identity or error envelope.
	result, err := s.managedPasswordProof(ctx, strings.TrimSpace(identity.Email), password)
	defer func() {
		if cleanupErr := s.cleanupManagedPasswordProof(ctx, current, result); cleanupErr != nil {
			err = cleanupErr
		}
	}()
	if err != nil {
		return err
	}
	if result == nil || (!result.Requires2FA && (result.UserID != current.UserID || result.AccessToken == "")) || (result.Requires2FA && strings.TrimSpace(result.TempToken) == "") {
		return passwordProofDenied()
	}
	// A pending proof must not approve a session revoked while USA-Zero was replying.
	_, err = s.currentManagedWebSession(ctx, current)
	return err
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
