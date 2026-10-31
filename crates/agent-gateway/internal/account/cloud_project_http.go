package account

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
)

func (h *HTTPHandler) registerCloudProjects(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/web-chat/projects", h.withSession(h.createCloudProject))
	mux.HandleFunc("GET /api/web-chat/projects", h.withSession(h.listCloudProjects))
	mux.HandleFunc("GET /api/web-chat/projects/{id}", h.withSession(h.getCloudProject))
	mux.HandleFunc("PUT /api/web-chat/projects/{id}", h.withSession(h.updateCloudProject))
	mux.HandleFunc("DELETE /api/web-chat/projects/{id}", h.withSession(h.deleteCloudProject))
	mux.HandleFunc("GET /api/web-chat/projects/{id}/conversations", h.withSession(h.listCloudProjectConversations))
	mux.HandleFunc("GET /api/web-chat/conversations/{id}/project", h.withSession(h.getCloudConversationProject))
	mux.HandleFunc("PUT /api/web-chat/conversations/{id}/project", h.withSession(h.setCloudConversationProject))
	mux.HandleFunc("GET /api/web-chat/projects/{id}/files", h.withSession(h.listCloudProjectFiles))
	mux.HandleFunc("PUT /api/web-chat/projects/{id}/files/{file_id}", h.withSession(h.setCloudProjectFile))
	mux.HandleFunc("DELETE /api/web-chat/projects/{id}/files/{file_id}", h.withSession(h.setCloudProjectFile))
}

func cloudProjectAPIError(err error) error {
	status, message := http.StatusServiceUnavailable, "cloud work storage is unavailable"
	switch {
	case errors.Is(err, ErrNotFound):
		status, message = 404, "cloud resource was not found"
	case errors.Is(err, ErrCloudProjectInvalid):
		status, message = 400, "invalid cloud project or memory request"
	case errors.Is(err, ErrCloudProjectConflict):
		status, message = 409, "resource changed; reload before saving"
	case errors.Is(err, ErrCloudProjectQuota):
		status, message = 409, "cloud project or memory resource limit reached"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		status, message = 408, "cloud work operation timed out"
	}
	return &APIError{Status: status, Message: message}
}

func decodeCloudProjectRequest(w http.ResponseWriter, r *http.Request, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if decoder.Decode(out) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		writeError(w, cloudProjectAPIError(ErrCloudProjectInvalid))
		return false
	}
	return true
}

func cloudProjectPage(w http.ResponseWriter, r *http.Request) (string, int, bool) {
	query := r.URL.Query()
	for key, values := range query {
		if (key != "before_id" && key != "limit") || len(values) != 1 {
			writeError(w, cloudProjectAPIError(ErrCloudProjectInvalid))
			return "", 0, false
		}
	}
	limit := 50
	if query.Get("limit") != "" {
		parsed, err := strconv.Atoi(query.Get("limit"))
		if err != nil || parsed < 1 || parsed > 100 {
			writeError(w, cloudProjectAPIError(ErrCloudProjectInvalid))
			return "", 0, false
		}
		limit = parsed
	}
	return query.Get("before_id"), limit, true
}

func writeCloudProjectPage[T any](w http.ResponseWriter, items []T, limit int, id func(T) string) {
	next := ""
	if len(items) > limit {
		items = items[:limit]
		next = id(items[len(items)-1])
	}
	writeJSON(w, 200, map[string]any{"items": items, "next_before_id": next})
}

func (h *HTTPHandler) cloudProjectStore() (CloudProjectStore, error) {
	store, ok := h.service.store.(CloudProjectStore)
	if !ok {
		return nil, cloudProjectAPIError(nil)
	}
	return store, nil
}

func (h *HTTPHandler) createCloudProject(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input CloudProjectUpdate
	if !decodeCloudProjectRequest(w, r, &input) {
		return
	}
	store, err := h.cloudProjectStore()
	if err != nil {
		writeError(w, err)
		return
	}
	project := &CloudProject{UserID: session.UserID, Name: input.Name, Description: input.Description, Instructions: input.Instructions}
	if input.Icon != nil {
		project.Icon = *input.Icon
	}
	if input.Color != nil {
		project.Color = *input.Color
	}
	project, err = store.CreateCloudProject(r.Context(), project)
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeJSON(w, 201, project)
}

func (h *HTTPHandler) getCloudProject(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	store, err := h.cloudProjectStore()
	if err != nil {
		writeError(w, err)
		return
	}
	project, err := store.GetCloudProject(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeJSON(w, 200, project)
}

func (h *HTTPHandler) listCloudProjects(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	before, limit, ok := cloudProjectPage(w, r)
	if !ok {
		return
	}
	store, err := h.cloudProjectStore()
	if err != nil {
		writeError(w, err)
		return
	}
	items, err := store.ListCloudProjects(r.Context(), session.UserID, before, limit+1)
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeCloudProjectPage(w, items, limit, func(p CloudProject) string { return p.ID })
}

func (h *HTTPHandler) updateCloudProject(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		ExpectedVersion int64   `json:"expected_version"`
		Name            string  `json:"name"`
		Description     string  `json:"description"`
		Instructions    string  `json:"instructions"`
		Icon            *string `json:"icon,omitempty"`
		Color           *string `json:"color,omitempty"`
	}
	if !decodeCloudProjectRequest(w, r, &input) {
		return
	}
	store, err := h.cloudProjectStore()
	if err != nil {
		writeError(w, err)
		return
	}
	project, err := store.UpdateCloudProject(r.Context(), session.UserID, r.PathValue("id"), input.ExpectedVersion, CloudProjectUpdate{Name: input.Name, Description: input.Description, Instructions: input.Instructions, Icon: input.Icon, Color: input.Color})
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeJSON(w, 200, project)
}

func (h *HTTPHandler) deleteCloudProject(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		ExpectedVersion int64 `json:"expected_version"`
	}
	if !decodeCloudProjectRequest(w, r, &input) {
		return
	}
	store, err := h.cloudProjectStore()
	if err != nil {
		writeError(w, err)
		return
	}
	if err = store.DeleteCloudProject(r.Context(), session.UserID, r.PathValue("id"), input.ExpectedVersion); err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	w.WriteHeader(204)
}

func (h *HTTPHandler) getCloudConversationProject(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	store, err := h.cloudProjectStore()
	if err != nil {
		writeError(w, err)
		return
	}
	binding, err := store.GetCloudConversationProject(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeJSON(w, 200, binding)
}

func (h *HTTPHandler) setCloudConversationProject(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		ProjectID       string `json:"project_id"`
		ExpectedVersion *int64 `json:"expected_version"`
	}
	if !decodeCloudProjectRequest(w, r, &input) {
		return
	}
	if input.ExpectedVersion == nil {
		writeError(w, cloudProjectAPIError(ErrCloudProjectInvalid))
		return
	}
	store, err := h.cloudProjectStore()
	if err != nil {
		writeError(w, err)
		return
	}
	binding, err := store.SetCloudConversationProject(r.Context(), session.UserID, r.PathValue("id"), input.ProjectID, *input.ExpectedVersion)
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeJSON(w, 200, binding)
}

func (h *HTTPHandler) listCloudProjectConversations(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	before, limit, ok := cloudProjectPage(w, r)
	if !ok {
		return
	}
	store, err := h.cloudProjectStore()
	if err != nil {
		writeError(w, err)
		return
	}
	items, err := store.ListCloudProjectConversations(r.Context(), session.UserID, r.PathValue("id"), before, limit+1)
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeCloudProjectPage(w, items, limit, func(p CloudProjectConversation) string { return p.ConversationID })
}

func (h *HTTPHandler) setCloudProjectFile(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		ExpectedVersion int64 `json:"expected_version"`
	}
	if !decodeCloudProjectRequest(w, r, &input) {
		return
	}
	store, err := h.cloudProjectStore()
	if err != nil {
		writeError(w, err)
		return
	}
	project, err := store.SetCloudProjectFile(r.Context(), session.UserID, r.PathValue("id"), r.PathValue("file_id"), input.ExpectedVersion, r.Method == http.MethodPut)
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeJSON(w, 200, project)
}

func (h *HTTPHandler) listCloudProjectFiles(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	before, limit, ok := cloudProjectPage(w, r)
	if !ok {
		return
	}
	store, err := h.cloudProjectStore()
	if err != nil {
		writeError(w, err)
		return
	}
	items, err := store.ListCloudProjectFiles(r.Context(), session.UserID, r.PathValue("id"), before, limit+1)
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	capabilities := make([]*CloudFile, len(items))
	for i := range items {
		capabilities[i] = &items[i]
	}
	h.service.cloudFileCapabilities(r.Context(), capabilities...)
	writeCloudProjectPage(w, items, limit, func(p CloudFile) string { return p.ID })
}
