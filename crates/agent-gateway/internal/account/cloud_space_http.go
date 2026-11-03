package account

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
)

func (h *HTTPHandler) registerCloudSpace(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/web-chat/space", h.withSession(h.listCloudSpace))
	mux.HandleFunc("PUT /api/web-chat/space/{kind}/{id}", h.withSession(h.putCloudSpaceMetadata))
}
func cloudSpaceAPIError(err error) error {
	if errors.Is(err, ErrCloudSpacePageChanged) {
		return &APIError{Status: 409, Message: "资料已更新，请刷新列表后继续浏览。"}
	}
	if errors.Is(err, ErrCloudSpaceConflict) {
		return &APIError{Status: 409, Message: "资料已变更，或文件夹仍有内容，请刷新后重试。"}
	}
	return cloudFileAPIError(err)
}
func (h *HTTPHandler) listCloudSpace(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "private, no-store")
	store, ok := h.service.store.(CloudSpaceStore)
	if !ok {
		writeError(w, cloudSpaceAPIError(nil))
		return
	}
	q := r.URL.Query()
	offset := 0
	for key, values := range q {
		if len(values) != 1 || !strings.Contains("|q|category|scope|folder|sort|offset|cursor|type|origin|", "|"+key+"|") {
			writeError(w, cloudSpaceAPIError(ErrCloudFileInvalid))
			return
		}
	}
	if q.Get("offset") != "" {
		var err error
		offset, err = strconv.Atoi(q.Get("offset"))
		if err != nil || offset < 0 || offset > 5000 {
			writeError(w, cloudSpaceAPIError(ErrCloudFileInvalid))
			return
		}
	}
	category, scope, order := q.Get("category"), q.Get("scope"), q.Get("sort")
	if category == "" {
		category = "all"
	}
	if scope == "" {
		scope = "all"
	}
	if order == "" {
		order = "updated"
	}
	if len(q.Get("q")) > 200 || !strings.Contains("|all|recent|uploads|outputs|images|documents|sites|", "|"+category+"|") || !strings.Contains("|all|starred|trash|", "|"+scope+"|") || !strings.Contains("|updated|name|size|", "|"+order+"|") {
		writeError(w, cloudSpaceAPIError(ErrCloudFileInvalid))
		return
	}
	if q.Get("folder") != "" {
		if _, err := canonicalCloudFileID(q.Get("folder")); err != nil {
			writeError(w, cloudSpaceAPIError(err))
			return
		}
	}
	page, err := store.QueryCloudSpace(r.Context(), session.UserID, CloudSpaceQuery{Query: q.Get("q"), Category: category, Scope: scope, Folder: q.Get("folder"), Sort: order, Type: q.Get("type"), Origin: q.Get("origin"), Cursor: q.Get("cursor"), Offset: offset})
	if err != nil {
		writeError(w, cloudSpaceAPIError(err))
		return
	}
	writeJSON(w, 200, page)
}
func (h *HTTPHandler) putCloudSpaceMetadata(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "private, no-store")
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		Name     string `json:"name"`
		FolderID string `json:"folder_id"`
		Starred  bool   `json:"starred"`
		Trashed  bool   `json:"trashed"`
		Version  int64  `json:"version"`
	}
	if !decodeCloudProjectRequest(w, r, &input) {
		return
	}
	store, ok := h.service.store.(CloudSpaceStore)
	if !ok {
		writeError(w, cloudSpaceAPIError(nil))
		return
	}
	m, err := store.PutCloudSpaceMetadata(r.Context(), session.UserID, CloudSpaceMetadata{ID: r.PathValue("id"), Kind: r.PathValue("kind"), Name: input.Name, FolderID: input.FolderID, Starred: input.Starred, Trashed: input.Trashed, Version: input.Version})
	if err != nil {
		writeError(w, cloudSpaceAPIError(err))
		return
	}
	writeJSON(w, 200, m)
}
