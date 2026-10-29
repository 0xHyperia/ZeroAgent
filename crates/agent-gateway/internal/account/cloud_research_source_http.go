package account

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

func (h *HTTPHandler) registerCloudResearchSources(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/web-chat/sources", h.withSession(h.listCloudResearchSources))
	mux.HandleFunc("GET /api/web-chat/sources/{id}", h.withSession(h.getCloudResearchSource))
	mux.HandleFunc("GET /api/web-chat/sources/{id}/content", h.withSession(h.cloudResearchSourceContent))
	mux.HandleFunc("DELETE /api/web-chat/sources/{id}", h.withSession(h.deleteCloudResearchSource))
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
	case errors.Is(err, ErrCloudResearchSourceInvalid), errors.Is(err, ErrCloudFileInvalid):
		status, message = http.StatusBadRequest, "来源请求或行号无效。"
	case errors.Is(err, ErrCloudResearchSourceConflict):
		status, message = http.StatusConflict, "来源版本已变化，请刷新后重试。"
	case errors.Is(err, ErrCloudResearchSourceQuota):
		status, message = http.StatusConflict, "来源资料或搜索次数已达到当前限制。"
	}
	return &APIError{Status: status, Message: message}
}
func cloudResearchSourceHeaders(w http.ResponseWriter, source *CloudResearchSource) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if source != nil {
		w.Header().Set("ETag", fmt.Sprintf("\"%d\"", source.Version))
	}
}
func (h *HTTPHandler) listCloudResearchSources(w http.ResponseWriter, r *http.Request, session *Session) {
	store, err := h.cloudResearchSourceStore()
	if err != nil {
		writeError(w, cloudResearchSourceAPIError(err))
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			writeError(w, cloudResearchSourceAPIError(ErrCloudResearchSourceInvalid))
			return
		}
	}
	sources, err := store.ListCloudResearchSources(r.Context(), session.UserID, r.URL.Query().Get("conversation_id"), r.URL.Query().Get("before"), limit+1)
	if err != nil {
		writeError(w, cloudResearchSourceAPIError(err))
		return
	}
	next := ""
	if len(sources) > limit {
		sources = sources[:limit]
		next = sources[len(sources)-1].ID
	}
	if sources == nil {
		sources = []CloudResearchSource{}
	}
	cloudResearchSourceHeaders(w, nil)
	writeJSON(w, http.StatusOK, map[string]any{"sources": sources, "next_cursor": next})
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
	cloudResearchSourceHeaders(w, source)
	writeJSON(w, http.StatusOK, map[string]any{"source": source})
}
func (h *HTTPHandler) cloudResearchSourceContent(w http.ResponseWriter, r *http.Request, session *Session) {
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
	if source.Kind != CloudResearchPage {
		writeError(w, &APIError{Status: http.StatusConflict, Reason: "source_snippet_only", Message: "此来源仅包含搜索摘要，尚未抓取网页正文。"})
		return
	}
	lines := strings.Split(source.Text, "\n")
	from, to := 1, 100
	if raw := r.URL.Query().Get("from_line"); raw != "" {
		from, err = strconv.Atoi(raw)
		if err != nil {
			writeError(w, cloudResearchSourceAPIError(ErrCloudResearchSourceInvalid))
			return
		}
		to = from + 99
	}
	if raw := r.URL.Query().Get("to_line"); raw != "" {
		to, err = strconv.Atoi(raw)
	}
	if err != nil || from < 1 || from > len(lines) || to < from || to-from >= 200 {
		writeError(w, cloudResearchSourceAPIError(ErrCloudResearchSourceInvalid))
		return
	}
	if to > len(lines) {
		to = len(lines)
	}
	selected := make([]map[string]any, 0, to-from+1)
	size := 0
	for number := from; number <= to; number++ {
		size += len(lines[number-1])
		if size > 256<<10 {
			writeError(w, &APIError{Status: http.StatusRequestEntityTooLarge, Message: "来源摘录超过当前大小限制。"})
			return
		}
		selected = append(selected, map[string]any{"line": number, "text": lines[number-1]})
	}
	cloudResearchSourceHeaders(w, source)
	writeJSON(w, http.StatusOK, map[string]any{"source_id": source.ID, "kind": source.Kind, "title": source.Title, "final_url": source.FinalURL, "sha256": source.SHA256, "observed_at": source.ObservedAt, "truncated": source.Truncated, "total_lines": len(lines), "from_line": from, "to_line": to, "lines": selected})
}
func (h *HTTPHandler) deleteCloudResearchSource(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	store, err := h.cloudResearchSourceStore()
	if err != nil {
		writeError(w, cloudResearchSourceAPIError(err))
		return
	}
	match := r.Header.Get("If-Match")
	if len(match) < 3 || match[0] != '"' || match[len(match)-1] != '"' {
		writeError(w, cloudResearchSourceAPIError(ErrCloudResearchSourceInvalid))
		return
	}
	version, err := strconv.ParseInt(match[1:len(match)-1], 10, 64)
	if err != nil || version < 1 {
		writeError(w, cloudResearchSourceAPIError(ErrCloudResearchSourceInvalid))
		return
	}
	if err = store.DeleteCloudResearchSource(r.Context(), session.UserID, r.PathValue("id"), version); err != nil {
		writeError(w, cloudResearchSourceAPIError(err))
		return
	}
	cloudResearchSourceHeaders(w, nil)
	writeJSON(w, http.StatusOK, map[string]any{"deleted": true})
}
