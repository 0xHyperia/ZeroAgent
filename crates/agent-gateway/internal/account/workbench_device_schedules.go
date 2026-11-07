package account

import (
	"context"
	"net/http"
)

type DeviceScheduleSummary struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
	NextAt int64  `json:"next_at,omitempty"`
}

// RegisterDeviceSchedules exposes only the projection permitted by account enrollment.
// Full history and all mutations still use the explicitly selected device controller.
func (h *HTTPHandler) RegisterDeviceSchedules(mux *http.ServeMux, read func(context.Context, string) ([]DeviceScheduleSummary, error)) {
	mux.HandleFunc("GET /api/web-chat/device-schedules/{device}", h.withSession(func(w http.ResponseWriter, r *http.Request, session *Session) {
		w.Header().Set("Cache-Control", "no-store")
		device, err := h.service.Device(r.Context(), session.UserID, r.PathValue("device"))
		if err != nil || device.RevokedAt != nil {
			writeError(w, &APIError{Status: http.StatusNotFound, Message: "device not found"})
			return
		}
		items, err := read(r.Context(), device.ID)
		if err != nil {
			writeError(w, &APIError{Status: http.StatusServiceUnavailable, Message: "device schedules unavailable"})
			return
		}
		current, err := h.service.Device(r.Context(), session.UserID, device.ID)
		if err != nil || current.RevokedAt != nil || !current.TokenIssuedAt.Equal(device.TokenIssuedAt) {
			writeError(w, &APIError{Status: http.StatusNotFound, Message: "device not found"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"tasks": items})
	}))
}
