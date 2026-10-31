package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

func (h *HTTPHandler) registerCloudRuns(mux *http.ServeMux) {
	h.registerCloudPendingQueue(mux)
	h.registerCloudPrivateDrafts(mux)
	mux.HandleFunc("POST /api/web-chat/runs", h.withSession(h.createCloudRun))
	mux.HandleFunc("GET /api/web-chat/runs", h.withSession(h.listCloudRuns))
	mux.HandleFunc("GET /api/web-chat/runs/{id}", h.withSession(h.getCloudRun))
	mux.HandleFunc("POST /api/web-chat/runs/{id}/cancel", h.withSession(h.cancelCloudRun))
	mux.HandleFunc("GET /api/web-chat/runs/{id}/events", h.withSession(h.cloudRunEvents))
}

func (h *HTTPHandler) cloudRunStore() (CloudRunStore, error) {
	store, ok := h.service.store.(CloudRunStore)
	if !ok {
		return nil, &APIError{Status: http.StatusServiceUnavailable, Message: "cloud task storage is unavailable"}
	}
	return store, nil
}

func (h *HTTPHandler) cloudWriteAllowed(w http.ResponseWriter, r *http.Request) bool {
	origin := strings.TrimRight(r.Header.Get("Origin"), "/")
	expected := h.publicOrigin
	if expected == "" {
		scheme := "http"
		if r.TLS != nil {
			scheme = "https"
		}
		expected = scheme + "://" + r.Host
	}
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" || (origin != "" && origin != expected) {
		writeError(w, &APIError{Status: http.StatusForbidden, Message: "request origin is not allowed"})
		return false
	}
	return true
}

func decodeCloudRunRequest(w http.ResponseWriter, r *http.Request) (CreateCloudRunInput, bool) {
	r.Body = http.MaxBytesReader(w, r.Body, CloudRunMaxInputBytes)
	var input CreateCloudRunInput
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
		return input, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
		return input, false
	}
	return input, true
}

func (h *HTTPHandler) createCloudRun(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	input, ok := decodeCloudRunRequest(w, r)
	if !ok {
		return
	}
	run, created, err := h.service.CreateCloudRun(r.Context(), session, input)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusAccepted
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]any{"run": run})
}

func (h *HTTPHandler) listCloudRuns(w http.ResponseWriter, r *http.Request, session *Session) {
	store, err := h.cloudRunStore()
	if err != nil {
		writeError(w, err)
		return
	}
	conversationID := strings.TrimSpace(r.URL.Query().Get("conversation_id"))
	if _, err := uuid.Parse(conversationID); err != nil {
		writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
		return
	}
	if _, err := h.service.store.GetCloudConversation(r.Context(), session.UserID, conversationID); err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	requestID := strings.TrimSpace(r.URL.Query().Get("client_request_id"))
	if len(requestID) > 128 {
		writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
		return
	}
	if messageID := strings.TrimSpace(r.URL.Query().Get("user_message_id")); messageID != "" {
		parsed, parseErr := uuid.Parse(messageID)
		if parseErr != nil || requestID != "" || r.URL.Query().Get("active") == "true" {
			writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
			return
		}
		views, ok := store.(cloudRunTurnHeadStore)
		if !ok {
			writeError(w, &APIError{Status: http.StatusServiceUnavailable, Message: "cloud task status is unavailable"})
			return
		}
		run, err := views.GetCloudRunForUserMessage(r.Context(), session.UserID, conversationID, parsed.String())
		if err != nil && !errors.Is(err, ErrNotFound) {
			writeError(w, cloudRunAPIError(err))
			return
		}
		heads := make([]cloudRunTurnHead, 0, 1)
		if run != nil {
			heads = append(heads, cloudRunHeadForTurn(run))
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]any{"runs": heads, "output_included": false})
		return
	}
	var runs []CloudRun
	if views, ok := store.(cloudRunViewStore); ok {
		runs, err = views.ListCloudRunViews(r.Context(), session.UserID, conversationID, r.URL.Query().Get("active") == "true", requestID)
	} else {
		runs, err = store.ListCloudRuns(r.Context(), session.UserID, conversationID, r.URL.Query().Get("active") == "true")
		if requestID != "" {
			filtered := make([]CloudRun, 0, 1)
			for _, run := range runs {
				if run.ClientRequestID == requestID {
					filtered = append(filtered, run)
				}
			}
			runs = filtered
		}
	}
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	if runs == nil {
		runs = []CloudRun{}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"runs": runs, "output_included": r.URL.Query().Get("active") == "true" || requestID != ""})
}

func (h *HTTPHandler) getCloudRun(w http.ResponseWriter, r *http.Request, session *Session) {
	store, err := h.cloudRunStore()
	if err != nil {
		writeError(w, err)
		return
	}
	run, err := readCloudRunView(r.Context(), store, session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	snapshot, err := h.cloudRunSnapshot(r.Context(), session.UserID, run)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"run": snapshot})
}

func (h *HTTPHandler) cancelCloudRun(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	store, err := h.cloudRunStore()
	if err != nil {
		writeError(w, err)
		return
	}
	run, err := store.CancelCloudRun(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	h.service.signalCloudRun(run.ID)
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"run": run})
}

func (h *HTTPHandler) cloudViewerValid(ctx context.Context, session *Session) bool {
	current, err := h.service.store.GetSession(ctx, session.ID)
	return err == nil && current.UserID == session.UserID && current.SessionExpiresAt.After(h.service.now())
}

func cloudSSEHeaders(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store, no-transform")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("X-Content-Type-Options", "nosniff")
}

func cloudSSEWrite(w http.ResponseWriter, kind, id string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Second))
	if id != "" {
		if _, err = fmt.Fprintf(w, "id: %s\n", id); err != nil {
			return err
		}
	}
	if _, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", kind, data); err != nil {
		return err
	}
	return http.NewResponseController(w).Flush()
}

func (h *HTTPHandler) cloudRunEvents(w http.ResponseWriter, r *http.Request, session *Session) {
	release, viewerErr := h.service.acquireCloudRunViewer(session.UserID)
	if viewerErr != nil {
		writeError(w, viewerErr)
		return
	}
	defer release()
	store, err := h.cloudRunStore()
	if err != nil {
		writeError(w, err)
		return
	}
	run, err := readCloudRunView(r.Context(), store, session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	cursor := strings.TrimSpace(r.URL.Query().Get("after_seq"))
	if cursor == "" {
		cursor = strings.TrimSpace(r.Header.Get("Last-Event-ID"))
	}
	var after int64
	if cursor != "" {
		after, err = strconv.ParseInt(cursor, 10, 64)
		if err != nil || after < 0 || after > run.LastSeq {
			writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
			return
		}
	}
	if !h.cloudViewerValid(r.Context(), session) {
		writeError(w, &APIError{Status: http.StatusUnauthorized, Message: "account session expired"})
		return
	}
	cloudSSEHeaders(w)
	if after == 0 || (run.Terminal() && after == run.LastSeq) {
		snapshot, viewErr := h.cloudRunSnapshot(r.Context(), session.UserID, run)
		if viewErr != nil {
			writeError(w, cloudRunAPIError(viewErr))
			return
		}
		if cloudSSEWrite(w, "snapshot", "", map[string]any{"run": snapshot}) != nil {
			return
		}
		after = run.LastSeq
	} else {
		if _, err = io.WriteString(w, ": connected\n\n"); err != nil {
			return
		}
		if http.NewResponseController(w).Flush() != nil {
			return
		}
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	heartbeat := time.NewTicker(10 * time.Second)
	defer heartbeat.Stop()
	for {
		if !h.cloudViewerValid(r.Context(), session) {
			return
		}
		events, err := store.ListCloudRunEvents(r.Context(), session.UserID, run.ID, after, 100)
		if err != nil {
			return
		}
		for _, event := range events {
			if !h.cloudViewerValid(r.Context(), session) {
				return
			}
			value := map[string]any{"run_id": event.RunID, "conversation_id": event.ConversationID, "seq": strconv.FormatInt(event.Seq, 10), "type": event.Type, "data": event.Payload}
			if cloudSSEWrite(w, "cloud_run", strconv.FormatInt(event.Seq, 10), value) != nil {
				return
			}
			after = event.Seq
		}
		run, err = readCloudRunHead(r.Context(), store, session.UserID, run.ID)
		if err != nil {
			return
		}
		if run.Terminal() && after >= run.LastSeq {
			return
		}
		if len(events) == 100 {
			continue
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		case <-heartbeat.C:
			_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(10 * time.Second))
			if _, err = io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
			if http.NewResponseController(w).Flush() != nil {
				return
			}
		}
	}
}

// The supported legacy endpoint is a wire adapter, not a second executor. Its
// request-bound cancellation is preserved; Run viewers use the explicit cancel API.
func (h *HTTPHandler) streamCloudCompletion(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	release, viewerErr := h.service.acquireCloudRunViewer(session.UserID)
	if viewerErr != nil {
		writeError(w, viewerErr)
		return
	}
	defer release()
	input, ok := decodeCloudRunRequest(w, r)
	if !ok {
		return
	}
	if input.ClientRequestID == "" {
		input.ClientRequestID = strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	}
	if input.ClientRequestID == "" {
		input.ClientRequestID = uuid.NewString()
	}
	run, _, err := h.service.CreateCloudRun(r.Context(), session, input)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	store, _ := h.cloudRunStore()
	defer func() {
		if run.Terminal() {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		if current, err := store.GetCloudRun(ctx, session.UserID, run.ID); err == nil && !current.Terminal() {
			_, _ = store.CancelCloudRun(ctx, session.UserID, run.ID)
			h.service.signalCloudRun(run.ID)
		}
	}()
	cloudSSEHeaders(w)
	after := int64(0)
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if !h.cloudViewerValid(r.Context(), session) {
			return
		}
		events, err := store.ListCloudRunEvents(r.Context(), session.UserID, run.ID, after, 100)
		if err != nil {
			return
		}
		for _, event := range events {
			after = event.Seq
			if event.Type != "message.delta" {
				continue
			}
			var value struct {
				Delta string `json:"delta"`
			}
			if json.Unmarshal(event.Payload, &value) != nil {
				continue
			}
			data := cloudJSON(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": value.Delta}}}})
			if _, err = fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
				return
			}
			if http.NewResponseController(w).Flush() != nil {
				return
			}
		}
		run, err = readCloudRunHead(r.Context(), store, session.UserID, run.ID)
		if err != nil {
			return
		}
		if run.Terminal() && after >= run.LastSeq {
			if len(run.Usage) > 0 {
				_, _ = fmt.Fprintf(w, "data: %s\n\n", cloudJSON(map[string]any{"choices": []any{}, "usage": run.Usage}))
			}
			if run.State != CloudRunCompleted {
				_, _ = fmt.Fprintf(w, "data: %s\n\n", cloudJSON(map[string]any{"error": map[string]any{"code": run.ErrorCode, "message": "cloud task did not complete"}}))
			}
			_, _ = io.WriteString(w, "data: [DONE]\n\n")
			_ = http.NewResponseController(w).Flush()
			return
		}
		select {
		case <-r.Context().Done():
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			_, _ = store.CancelCloudRun(ctx, session.UserID, run.ID)
			cancel()
			h.service.signalCloudRun(run.ID)
			return
		case <-ticker.C:
		}
	}
}
