package account

import "net/http"

func (h *HTTPHandler) registerCloudMemories(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/web-chat/memories", h.withSession(h.createCloudMemory))
	mux.HandleFunc("GET /api/web-chat/memories", h.withSession(h.listCloudMemories))
	mux.HandleFunc("GET /api/web-chat/memories/{id}", h.withSession(h.getCloudMemory))
	mux.HandleFunc("PUT /api/web-chat/memories/{id}", h.withSession(h.updateCloudMemory))
	mux.HandleFunc("DELETE /api/web-chat/memories/{id}", h.withSession(h.deleteCloudMemory))
	mux.HandleFunc("GET /api/web-chat/memory-settings", h.withSession(h.getCloudMemorySettings))
	mux.HandleFunc("PUT /api/web-chat/memory-settings", h.withSession(h.setCloudMemorySettings))
}

func (h *HTTPHandler) cloudMemoryStore() (CloudMemoryStore, error) {
	store, ok := h.service.store.(CloudMemoryStore)
	if !ok {
		return nil, cloudProjectAPIError(nil)
	}
	return store, nil
}

func (h *HTTPHandler) createCloudMemory(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		Content string `json:"content"`
		Enabled *bool  `json:"enabled"`
	}
	if !decodeCloudProjectRequest(w, r, &input) {
		return
	}
	enabled := true
	if input.Enabled != nil {
		enabled = *input.Enabled
	}
	store, err := h.cloudMemoryStore()
	if err != nil {
		writeError(w, err)
		return
	}
	memory, err := store.CreateCloudMemory(r.Context(), &CloudMemory{UserID: session.UserID, Content: input.Content, Enabled: enabled})
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeJSON(w, 201, memory)
}

func (h *HTTPHandler) listCloudMemories(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	before, limit, ok := cloudProjectPage(w, r)
	if !ok {
		return
	}
	store, err := h.cloudMemoryStore()
	if err != nil {
		writeError(w, err)
		return
	}
	items, err := store.ListCloudMemories(r.Context(), session.UserID, before, limit+1)
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeCloudProjectPage(w, items, limit, func(m CloudMemory) string { return m.ID })
}

func (h *HTTPHandler) getCloudMemory(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	store, err := h.cloudMemoryStore()
	if err != nil {
		writeError(w, err)
		return
	}
	memory, err := store.GetCloudMemory(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeJSON(w, 200, memory)
}

func (h *HTTPHandler) updateCloudMemory(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		ExpectedVersion int64  `json:"expected_version"`
		Content         string `json:"content"`
		Enabled         *bool  `json:"enabled"`
	}
	if !decodeCloudProjectRequest(w, r, &input) {
		return
	}
	if input.Enabled == nil {
		writeError(w, cloudProjectAPIError(ErrCloudProjectInvalid))
		return
	}
	store, err := h.cloudMemoryStore()
	if err != nil {
		writeError(w, err)
		return
	}
	memory, err := store.UpdateCloudMemory(r.Context(), session.UserID, r.PathValue("id"), input.ExpectedVersion, input.Content, *input.Enabled)
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeJSON(w, 200, memory)
}

func (h *HTTPHandler) deleteCloudMemory(w http.ResponseWriter, r *http.Request, session *Session) {
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
	store, err := h.cloudMemoryStore()
	if err != nil {
		writeError(w, err)
		return
	}
	if err = store.DeleteCloudMemory(r.Context(), session.UserID, r.PathValue("id"), input.ExpectedVersion); err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	w.WriteHeader(204)
}

func (h *HTTPHandler) getCloudMemorySettings(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	store, err := h.cloudMemoryStore()
	if err != nil {
		writeError(w, err)
		return
	}
	settings, err := store.GetCloudMemorySettings(r.Context(), session.UserID)
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeJSON(w, 200, settings)
}

func (h *HTTPHandler) setCloudMemorySettings(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		ExpectedVersion *int64 `json:"expected_version"`
		Enabled         *bool  `json:"enabled"`
	}
	if !decodeCloudProjectRequest(w, r, &input) {
		return
	}
	if input.Enabled == nil || input.ExpectedVersion == nil {
		writeError(w, cloudProjectAPIError(ErrCloudProjectInvalid))
		return
	}
	store, err := h.cloudMemoryStore()
	if err != nil {
		writeError(w, err)
		return
	}
	settings, err := store.SetCloudMemorySettings(r.Context(), session.UserID, *input.ExpectedVersion, *input.Enabled)
	if err != nil {
		writeError(w, cloudProjectAPIError(err))
		return
	}
	writeJSON(w, 200, settings)
}
