package account

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

func (h *HTTPHandler) registerCloudPrivateDrafts(mux *http.ServeMux) {
	for _, method := range []string{"GET", "PUT", "DELETE"} {
		mux.HandleFunc(method+" /api/web-chat/drafts/{scope}", h.withSession(h.cloudPrivateDraftResource))
	}
}

func cloudPrivateDraftAPIError(err error) error {
	switch {
	case errors.Is(err, ErrCloudDraftChanged):
		return &APIError{Status: 409, Reason: "draft_changed", Message: "草稿已在其他位置修改，请先读取最新草稿。"}
	case errors.Is(err, ErrCloudDraftOperationConflict):
		return &APIError{Status: 409, Reason: "draft_operation_conflict", Message: "草稿操作标识已用于其他内容。"}
	case errors.Is(err, ErrCloudDraftLimit):
		return &APIError{Status: 413, Reason: "draft_limit", Message: "草稿容量已达上限，请减少附件或清理其他草稿。"}
	default:
		return cloudRunAPIError(err)
	}
}

func (h *HTTPHandler) cloudPrivateDraftResource(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	if cloudManagementQuery(r) != nil {
		writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
		return
	}
	store, ok := h.service.store.(cloudPrivateDraftStore)
	if !ok {
		writeError(w, &APIError{Status: 503, Message: "private drafts are unavailable"})
		return
	}
	var snapshot *CloudPrivateDraftSnapshot
	var err error
	if r.Method == http.MethodGet {
		snapshot, err = store.GetCloudPrivateDraft(r.Context(), session.UserID, r.PathValue("scope"))
	} else {
		limit := int64(CloudPrivateDraftMaxBytes + 65536)
		if r.Method == http.MethodDelete {
			limit = 4096
		}
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
		decoder.DisallowUnknownFields()
		var input CloudPrivateDraftInput
		var extra any
		if err = decoder.Decode(&input); err == nil {
			err = decoder.Decode(&extra)
			if err == io.EOF {
				err = nil
			} else if err == nil {
				err = ErrCloudRunInvalid
			}
		}
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				err = ErrCloudDraftLimit
			} else {
				err = ErrCloudRunInvalid
			}
			writeError(w, cloudPrivateDraftAPIError(err))
			return
		}
		snapshot, err = store.WriteCloudPrivateDraft(r.Context(), session.UserID, r.PathValue("scope"), input, r.Method == http.MethodDelete)
	}
	if err != nil {
		writeError(w, cloudPrivateDraftAPIError(err))
		return
	}
	w.Header().Set("Cache-Control", "private, no-store")
	writeCloudHistoryJSON(w, snapshot)
}
