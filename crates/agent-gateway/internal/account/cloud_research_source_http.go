package account

import (
	"errors"
	"net/http"
)

func (h *HTTPHandler) registerCloudResearchSources(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/web-chat/sources/{id}", h.withSession(h.getCloudResearchSource))
}
func (h *HTTPHandler) cloudResearchSourceStore() (CloudResearchSourceStore, error) {
	store, ok := h.service.store.(CloudResearchSourceStore)
	if !ok {
		return nil, ErrCloudResearchSourceInvalid
	}
	return store, nil
}
func cloudResearchSourceAPIError(err error) error {
	status, message := http.StatusServiceUnavailable, "来源资料暂时不可用，请稍后重试。"
	switch {
	case errors.Is(err, ErrNotFound):
		status, message = http.StatusNotFound, "来源不存在或已删除。"
	case errors.Is(err, ErrCloudResearchSourceInvalid):
		status, message = http.StatusBadRequest, "来源标识无效。"
	}
	return &APIError{Status: status, Message: message}
}
func (h *HTTPHandler) getCloudResearchSource(w http.ResponseWriter, r *http.Request, session *Session) {
	store, err := h.cloudResearchSourceStore()
	if err != nil {
		writeError(w, cloudResearchSourceAPIError(err))
		return
	}
	source, err := store.GetCloudResearchSource(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudResearchSourceAPIError(err))
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	writeJSON(w, http.StatusOK, map[string]any{"source": map[string]string{
		"id": source.ID, "title": source.Title, "url": source.URL, "final_url": source.FinalURL,
	}})
}
