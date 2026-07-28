package handler

import (
	"context"
	"net/http"
	"time"
)

func Health() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true,
		})
	}
}

// Ready reports whether the gateway can serve requests that require persistent dependencies.
func Ready(check func(context.Context) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if check != nil {
			if err := check(ctx); err != nil {
				writeJSON(w, http.StatusServiceUnavailable, map[string]any{
					"ok":    false,
					"error": "dependencies unavailable",
				})
				return
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}
