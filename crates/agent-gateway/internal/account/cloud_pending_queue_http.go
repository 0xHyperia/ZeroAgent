package account

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

func (h *HTTPHandler) registerCloudPendingQueue(mux *http.ServeMux) {
	root := "/api/web-chat/conversations/{conversationID}/pending"
	mux.HandleFunc("GET "+root, h.withSession(h.getCloudPendingQueue))
	mux.HandleFunc("POST "+root, h.withSession(h.enqueueCloudPendingItem))
	mux.HandleFunc("PATCH "+root+"/{itemID}", h.withSession(h.editCloudPendingItem))
	mux.HandleFunc("DELETE "+root+"/{itemID}", h.withSession(h.removeCloudPendingItem))
	mux.HandleFunc("POST "+root+"/reorder", h.withSession(h.reorderCloudPendingQueue))
	mux.HandleFunc("POST "+root+"/{itemID}/submit", h.withSession(h.submitCloudPendingItem))
}

func cloudPendingAPIError(err error) error {
	if errors.Is(err, ErrCloudPendingConflict) {
		return &APIError{Status: http.StatusConflict, Reason: "pending_queue_changed", Message: "pending queue changed; reload before editing or sending"}
	}
	if errors.Is(err, ErrCloudPendingLimit) {
		return &APIError{Status: http.StatusRequestEntityTooLarge, Reason: "pending_queue_limit", Message: "pending queue capacity exceeded"}
	}
	return cloudRunAPIError(err)
}

func (h *HTTPHandler) pendingQueueStore() (CloudPendingQueueStore, error) {
	store, ok := h.service.store.(CloudPendingQueueStore)
	if !ok {
		return nil, &APIError{Status: http.StatusServiceUnavailable, Message: "pending message storage is unavailable"}
	}
	return store, nil
}

type cloudPendingBody struct {
	ExpectedVersion int64             `json:"expected_version,string"`
	Item            *CloudPendingItem `json:"item,omitempty"`
	ItemIDs         []string          `json:"item_ids,omitempty"`
}

func decodeCloudPendingBody(w http.ResponseWriter, r *http.Request) (cloudPendingBody, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, CloudPendingMaxItemBytes+(64<<10))
	var body cloudPendingBody
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&body); err != nil {
		writeError(w, cloudPendingAPIError(ErrCloudRunInvalid))
		return body, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, cloudPendingAPIError(ErrCloudRunInvalid))
		return body, false
	}
	if body.ExpectedVersion < 0 {
		writeError(w, cloudPendingAPIError(ErrCloudRunInvalid))
		return body, false
	}
	return body, true
}

func (h *HTTPHandler) getCloudPendingQueue(w http.ResponseWriter, r *http.Request, session *Session) {
	store, err := h.pendingQueueStore()
	if err != nil {
		writeError(w, err)
		return
	}
	queue, err := store.GetCloudPendingQueue(r.Context(), session.UserID, r.PathValue("conversationID"))
	if err != nil {
		writeError(w, cloudPendingAPIError(err))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"queue": queue})
}

func (h *HTTPHandler) mutateCloudPending(w http.ResponseWriter, r *http.Request, session *Session, kind string) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	body, ok := decodeCloudPendingBody(w, r)
	if !ok {
		return
	}
	store, err := h.pendingQueueStore()
	if err != nil {
		writeError(w, err)
		return
	}
	conversationID, err := canonicalCloudRunID(r.PathValue("conversationID"))
	if err != nil {
		writeError(w, cloudPendingAPIError(err))
		return
	}
	// Check the owning conversation before inspecting any supplied reference.
	if _, err = h.service.store.GetCloudConversation(r.Context(), session.UserID, conversationID); err != nil {
		writeError(w, cloudPendingAPIError(err))
		return
	}
	mutation := CloudPendingMutation{Kind: kind, ExpectedVersion: body.ExpectedVersion, ItemID: r.PathValue("itemID"), Order: body.ItemIDs}
	if kind == "enqueue" || kind == "edit" {
		item, err := normalizeCloudPendingItem(body.Item)
		if err != nil {
			writeError(w, cloudPendingAPIError(err))
			return
		}
		if _, err = h.service.canonicalCloudFileReferences(r.Context(), session.UserID, item.Content); err != nil {
			writeError(w, cloudPendingAPIError(err))
			return
		}
		mutation.Item = item
	}
	queue, err := store.MutateCloudPendingQueue(r.Context(), session.UserID, conversationID, mutation)
	if err != nil {
		writeError(w, cloudPendingAPIError(err))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"queue": queue})
}

func (h *HTTPHandler) enqueueCloudPendingItem(w http.ResponseWriter, r *http.Request, session *Session) {
	h.mutateCloudPending(w, r, session, "enqueue")
}
func (h *HTTPHandler) editCloudPendingItem(w http.ResponseWriter, r *http.Request, session *Session) {
	h.mutateCloudPending(w, r, session, "edit")
}
func (h *HTTPHandler) removeCloudPendingItem(w http.ResponseWriter, r *http.Request, session *Session) {
	h.mutateCloudPending(w, r, session, "remove")
}
func (h *HTTPHandler) reorderCloudPendingQueue(w http.ResponseWriter, r *http.Request, session *Session) {
	h.mutateCloudPending(w, r, session, "reorder")
}

func (h *HTTPHandler) submitCloudPendingItem(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	body, ok := decodeCloudPendingBody(w, r)
	if !ok {
		return
	}
	conversationID, err := canonicalCloudRunID(r.PathValue("conversationID"))
	if err != nil {
		writeError(w, cloudPendingAPIError(err))
		return
	}
	itemID, err := canonicalCloudRunID(r.PathValue("itemID"))
	if err != nil {
		writeError(w, cloudPendingAPIError(err))
		return
	}
	run, created, err := h.service.SubmitCloudPendingItem(r.Context(), session, conversationID, itemID, body.ExpectedVersion)
	if err != nil {
		writeError(w, cloudPendingAPIError(err))
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusAccepted
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]any{"run": run})
}
