package account

import (
	"encoding/json"
	"net/http"
	"strconv"
)

func writeCloudHistoryJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Keeping JSON as JSON avoids multiplying a large explicit message's '<'
	// bytes sixfold. The renderer must treat message text as untrusted data.
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}

func cloudHistoryRequest(r *http.Request) (string, int, error) {
	query := r.URL.Query()
	limit := 50
	for key, values := range query {
		if (key != "before_id" && key != "limit") || len(values) != 1 {
			return "", 0, ErrCloudRunInvalid
		}
	}
	if query.Get("limit") != "" {
		parsed, err := strconv.Atoi(query.Get("limit"))
		if err != nil || parsed < 1 || parsed > CloudHistoryMaxPage {
			return "", 0, ErrCloudRunInvalid
		}
		limit = parsed
	}
	return query.Get("before_id"), limit, nil
}

func (h *HTTPHandler) getCloudHistoryMessage(w http.ResponseWriter, r *http.Request, session *Session) {
	message, err := h.service.CloudHistoryMessage(r.Context(), session.UserID, r.PathValue("id"), r.PathValue("message_id"))
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	writeCloudHistoryJSON(w, map[string]any{"message": message})
}

func (h *HTTPHandler) listCloudHistoryHeads(w http.ResponseWriter, r *http.Request, session *Session) {
	before, limit, err := cloudHistoryRequest(r)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	store, err := h.service.cloudHistoryStore()
	if err != nil {
		writeError(w, err)
		return
	}
	page, err := store.ListCloudMessageHeads(r.Context(), session.UserID, r.PathValue("id"), before, limit)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	writeCloudHistoryJSON(w, page)
}
