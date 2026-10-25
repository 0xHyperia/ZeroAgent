package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/google/uuid"
)

// ValidateBearerHeader validates the internal local-service credential. Production account and
// device authorization continue to use the account service and its execution leases.
func ValidateBearerHeader(value, expectedToken string) bool {
	parts := strings.Fields(value)
	return len(parts) == 2 && strings.EqualFold(parts[0], "Bearer") && ValidateToken(parts[1], expectedToken)
}

// HTTPMiddleware is for internal/single-host services, not a ZeroAgent account login mechanism.
func HTTPMiddleware(expectedToken string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !ValidateBearerHeader(r.Header.Get("Authorization"), expectedToken) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			w.WriteHeader(http.StatusUnauthorized)
			if r.URL.Path == "/api/image" || strings.HasPrefix(r.URL.Path, "/api/image/") {
				_ = json.NewEncoder(w).Encode(map[string]any{"version": "kbrain.image.v1", "error": map[string]any{
					"code": "IMAGE_AUTH_REQUIRED", "message": "Verified image identity is required", "retryable": false, "requestId": uuid.NewString(),
				}})
			} else {
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "unauthorized"})
			}
			return
		}
		next.ServeHTTP(w, r)
	})
}

func ValidateToken(value, expectedToken string) bool {
	value = strings.TrimSpace(value)
	expectedToken = strings.TrimSpace(expectedToken)
	if value == "" || expectedToken == "" {
		return false
	}
	valueHash := sha256.Sum256([]byte(value))
	expectedHash := sha256.Sum256([]byte(expectedToken))
	return subtle.ConstantTimeCompare(valueHash[:], expectedHash[:]) == 1
}
