package account

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
)

func (h *HTTPHandler) registerCloudConversationManagement(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/web-chat/conversations/catalog", h.withSession(h.cloudConversationCatalog))
	mux.HandleFunc("GET /api/web-chat/conversations/search", h.withSession(h.searchCloudConversations))
	mux.HandleFunc("PATCH /api/web-chat/conversations/{id}/management", h.withSession(h.manageCloudConversation))
	mux.HandleFunc("GET /api/web-chat/conversations/{id}/metadata", h.withSession(h.cloudConversationMetadata))
	mux.HandleFunc("GET /api/web-chat/conversations/{id}/messages/{message_id}/window", h.withSession(h.cloudConversationWindow))
	mux.HandleFunc("GET /api/web-chat/conversations/{id}/branches", h.withSession(h.cloudConversationBranches))
}

func (h *HTTPHandler) cloudConversationMetadata(w http.ResponseWriter, r *http.Request, session *Session) {
	id, err := canonicalCloudRunID(r.PathValue("id"))
	if err != nil || cloudManagementQuery(r) != nil {
		writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
		return
	}
	conversation, err := h.service.store.GetCloudConversation(r.Context(), session.UserID, id)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	writeCloudHistoryJSON(w, map[string]any{"conversation": conversation})
}

func (h *HTTPHandler) cloudManagementStore(w http.ResponseWriter) (cloudConversationManagementStore, bool) {
	store, ok := h.service.store.(cloudConversationManagementStore)
	if !ok {
		writeError(w, &APIError{Status: 503, Message: "conversation management is unavailable"})
	}
	return store, ok
}

func cloudManagementQuery(r *http.Request, allowed ...string) error {
	for key, values := range r.URL.Query() {
		found := false
		for _, name := range allowed {
			if key == name {
				found = true
				break
			}
		}
		if !found || len(values) != 1 {
			return ErrCloudRunInvalid
		}
	}
	return nil
}

func cloudManagementNumber(r *http.Request, key string, fallback, minValue, maxValue int) (int, error) {
	if r.URL.Query().Get(key) == "" {
		return fallback, nil
	}
	n, err := strconv.Atoi(r.URL.Query().Get(key))
	if err != nil || n < minValue || n > maxValue {
		return 0, ErrCloudRunInvalid
	}
	return n, nil
}

func (h *HTTPHandler) manageCloudConversation(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	store, ok := h.cloudManagementStore(w)
	if !ok {
		return
	}
	var patch CloudConversationManagementPatch
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&patch) != nil || decoder.Decode(&extra) != io.EOF {
		writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
		return
	}
	c, err := store.ManageCloudConversation(r.Context(), session.UserID, r.PathValue("id"), patch)
	if errors.Is(err, ErrCloudRunConflict) {
		writeError(w, &APIError{Status: 409, Reason: "conversation_changed", Message: "会话状态已在其他位置更新，请刷新后重试。"})
		return
	}
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	writeCloudHistoryJSON(w, map[string]any{"conversation": c})
}

func (h *HTTPHandler) cloudConversationCatalog(w http.ResponseWriter, r *http.Request, session *Session) {
	if err := cloudManagementQuery(r, "scope", "cursor", "limit"); err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	limit, err := cloudManagementNumber(r, "limit", 50, 1, 100)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "active"
	}
	store, ok := h.cloudManagementStore(w)
	if !ok {
		return
	}
	page, err := store.CloudConversationCatalog(r.Context(), session.UserID, scope, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	writeCloudHistoryJSON(w, page)
}

func (h *HTTPHandler) searchCloudConversations(w http.ResponseWriter, r *http.Request, session *Session) {
	if err := cloudManagementQuery(r, "q", "scope", "cursor", "limit"); err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	limit, err := cloudManagementNumber(r, "limit", 20, 1, 100)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	scope := r.URL.Query().Get("scope")
	if scope == "" {
		scope = "all"
	}
	store, ok := h.cloudManagementStore(w)
	if !ok {
		return
	}
	page, err := store.SearchCloudConversations(r.Context(), session.UserID, r.URL.Query().Get("q"), scope, r.URL.Query().Get("cursor"), limit)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	writeCloudHistoryJSON(w, page)
}

func (h *HTTPHandler) cloudConversationBranches(w http.ResponseWriter, r *http.Request, session *Session) {
	if err := cloudManagementQuery(r, "cursor", "limit"); err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	limit, err := cloudManagementNumber(r, "limit", 30, 1, 100)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	store, ok := h.cloudManagementStore(w)
	if !ok {
		return
	}
	page, err := store.CloudConversationBranches(r.Context(), session.UserID, r.PathValue("id"), r.URL.Query().Get("cursor"), limit)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	writeCloudHistoryJSON(w, page)
}

func (h *HTTPHandler) cloudConversationWindow(w http.ResponseWriter, r *http.Request, session *Session) {
	if err := cloudManagementQuery(r, "before", "after"); err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	before, err := cloudManagementNumber(r, "before", 20, 0, 49)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	after, err := cloudManagementNumber(r, "after", 20, 0, 49)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	store, ok := h.cloudManagementStore(w)
	if !ok {
		return
	}
	cid, mid, err := validateCloudWindow(r.PathValue("id"), r.PathValue("message_id"), before, after)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	heads, err := store.CloudConversationWindowHeads(r.Context(), session.UserID, cid, mid, before, after)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	history, err := h.service.cloudHistoryStore()
	if err != nil {
		writeError(w, err)
		return
	}
	anchor := -1
	order := map[string]int{}
	for i, head := range heads.Items {
		order[head.ID] = i
		if head.ID == mid {
			anchor = i
		}
	}
	if anchor < 0 {
		writeError(w, cloudRunAPIError(ErrNotFound))
		return
	}
	// Allocate the bounded body budget to the requested match first, followed
	// by its closest context. Oversized bodies remain explicit loadable heads.
	ids := []string{mid}
	for offset := 1; len(ids) < len(heads.Items); offset++ {
		if anchor-offset >= 0 {
			ids = append(ids, heads.Items[anchor-offset].ID)
		}
		if anchor+offset < len(heads.Items) {
			ids = append(ids, heads.Items[anchor+offset].ID)
		}
	}
	messages, err := history.GetCloudHistoryMessages(r.Context(), session.UserID, cid, ids, CloudHistoryPageBytes)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	sort.Slice(messages, func(i, j int) bool { return order[messages[i].ID] < order[messages[j].ID] })
	page := CloudConversationWindow{Messages: messages, AnchorID: mid, HasBefore: heads.HasBefore, HasAfter: heads.HasAfter}
	if page.HasBefore {
		page.NextBeforeID = heads.Items[0].ID
	}
	if page.HasAfter {
		page.NextAfterID = heads.Items[len(heads.Items)-1].ID
	}
	writeCloudHistoryJSON(w, page)
}
