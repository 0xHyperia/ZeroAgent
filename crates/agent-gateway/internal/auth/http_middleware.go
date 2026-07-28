package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"strings"
)

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
