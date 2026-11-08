package account

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
)

func (h *HTTPHandler) registerCloudSchedules(mux *http.ServeMux) {
	for pattern, handler := range map[string]func(http.ResponseWriter, *http.Request, *Session, *PersistentStore){
		"GET /api/web-chat/schedules":                           h.listCloudSchedules,
		"POST /api/web-chat/schedules":                          h.saveCloudSchedule,
		"POST /api/web-chat/schedules/preview":                  h.previewCloudSchedule,
		"PUT /api/web-chat/schedules/{id}":                      h.saveCloudSchedule,
		"DELETE /api/web-chat/schedules/{id}":                   h.deleteCloudSchedule,
		"GET /api/web-chat/schedules/{id}/runs":                 h.listCloudScheduleRuns,
		"GET /api/web-chat/schedules/{id}/runs/{run}":           h.getCloudScheduleRun,
		"GET /api/web-chat/schedules/{id}/run-now":              h.getCloudScheduleRunReceipt,
		"POST /api/web-chat/schedules/{id}/run-now":             h.runCloudScheduleNow,
		"POST /api/web-chat/schedules/{id}/runs/{run}/cancel":   h.cancelPendingCloudSchedule,
		"GET /api/web-chat/schedules/{id}/runs/{run}/approval":  h.getCloudScheduleApproval,
		"POST /api/web-chat/schedules/{id}/runs/{run}/approval": h.decideCloudScheduleApproval,
	} {
		mux.HandleFunc(pattern, h.withSession(func(w http.ResponseWriter, r *http.Request, session *Session) {
			store, ok := h.service.store.(*PersistentStore)
			if !ok {
				writeError(w, &APIError{Status: http.StatusServiceUnavailable, Message: "cloud schedule storage unavailable"})
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			if r.Method != http.MethodGet {
				if !h.cloudWriteAllowed(w, r) {
					return
				}
				if !h.service.cloudSchedulesEnabled && r.Method != http.MethodDelete {
					writeError(w, &APIError{Status: http.StatusServiceUnavailable, Reason: "cloud_schedules_disabled", Message: "cloud scheduling is unavailable"})
					return
				}
			}
			if id := r.PathValue("id"); id != "" {
				if _, err := uuid.Parse(id); err != nil {
					writeScheduleError(w, errCloudScheduleInvalid)
					return
				}
			}
			handler(w, r, session, store)
		}))
	}
}

func (h *HTTPHandler) previewCloudSchedule(w http.ResponseWriter, r *http.Request, _ *Session, _ *PersistentStore) {
	var request struct {
		Rule     CloudScheduleRule `json:"rule"`
		Admitted int               `json:"admitted"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	if request.Admitted < 0 || request.Rule.validate() != nil {
		writeScheduleError(w, errCloudScheduleInvalid)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"next_at": request.Rule.next(h.service.now(), request.Admitted)})
}

func writeScheduleError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows), errors.Is(err, ErrNotFound):
		writeError(w, &APIError{Status: http.StatusNotFound, Message: "scheduled task not found"})
	case errors.Is(err, errCloudScheduleInvalid):
		writeError(w, &APIError{Status: http.StatusBadRequest, Message: "invalid scheduled task"})
	case errors.Is(err, errCloudScheduleApprovalConflict):
		writeError(w, &APIError{Status: http.StatusConflict, Reason: "schedule_approval_conflict", Message: errCloudScheduleApprovalConflict.Error()})
	default:
		writeError(w, cloudRunAPIError(err))
	}
}

func (h *HTTPHandler) listCloudSchedules(w http.ResponseWriter, r *http.Request, session *Session, store *PersistentStore) {
	items, err := store.listCloudSchedules(r.Context(), session.UserID)
	if err != nil {
		writeScheduleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"tasks": items, "enabled": h.service.cloudSchedulesEnabled})
}

func (h *HTTPHandler) saveCloudSchedule(w http.ResponseWriter, r *http.Request, session *Session, store *PersistentStore) {
	var request struct {
		Revision  int64              `json:"revision"`
		Enabled   bool               `json:"enabled"`
		Task      CloudScheduleInput `json:"task"`
		RequestID string             `json:"request_id,omitempty"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	input, err := normalizeCloudSchedule(request.Task)
	if err != nil {
		writeScheduleError(w, err)
		return
	}
	ctx := r.Context()
	id := r.PathValue("id")
	var previous CloudSchedule
	if id != "" {
		err = scanCloudSchedule(store.db.QueryRowContext(ctx, `SELECT `+cloudScheduleFields+` FROM zeroagent_cloud_schedules WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, id, session.UserID), &previous)
		if err != nil {
			writeScheduleError(w, err)
			return
		}
	}
	// Pausing an existing plan must remain available if its project was removed.
	if input.ProjectID != "" && (request.Enabled || input.ProjectID != previous.ProjectID) {
		if _, err = store.GetCloudProject(ctx, session.UserID, input.ProjectID); err != nil {
			if errors.Is(err, ErrNotFound) {
				writeError(w, &APIError{Status: http.StatusConflict, Reason: "schedule_project_unavailable", Message: "scheduled task project is unavailable"})
			} else {
				writeScheduleError(w, err)
			}
			return
		}
	}
	if request.Enabled {
		if err = h.service.ensureCloudExecutionAccount(ctx, store, session); err != nil {
			writeScheduleError(w, err)
			return
		}
		if _, err = h.service.canonicalCloudFileReferences(ctx, session.UserID, input.Run.Content); err != nil {
			writeScheduleError(w, err)
			return
		}
	}
	spec, err := encodeCloudSchedule(input)
	if err != nil {
		writeScheduleError(w, err)
		return
	}
	if len(spec) > 512<<10 {
		writeScheduleError(w, ErrCloudRunLimit)
		return
	}
	now := h.service.now().UTC()
	var item CloudSchedule
	if id == "" {
		requestID, parseErr := uuid.Parse(request.RequestID)
		if parseErr != nil {
			writeScheduleError(w, errCloudScheduleInvalid)
			return
		}
		id = cloudScheduleID(requestID.String(), "owner:"+strconv.FormatInt(session.UserID, 10))
		err = scanCloudSchedule(store.db.QueryRowContext(ctx, `INSERT INTO zeroagent_cloud_schedules(id,user_id,enabled,next_at,spec) VALUES ($1,$2,$3,$4,$5)
 ON CONFLICT(id) DO UPDATE SET id=EXCLUDED.id WHERE zeroagent_cloud_schedules.user_id=EXCLUDED.user_id AND zeroagent_cloud_schedules.spec=EXCLUDED.spec AND zeroagent_cloud_schedules.deleted_at IS NULL
 RETURNING `+cloudScheduleFields, id, session.UserID, request.Enabled, nextEnabledSchedule(input.Rule, request.Enabled, now, 0), string(spec)), &item)
	} else {
		next := nextEnabledSchedule(input.Rule, request.Enabled, now, previous.Admitted)
		err = scanCloudSchedule(store.db.QueryRowContext(ctx, `UPDATE zeroagent_cloud_schedules SET spec=$4,enabled=$5,next_at=$6,blocked='',revision=revision+1
 WHERE id=$1 AND user_id=$2 AND revision=$3 AND admitted=$7 AND deleted_at IS NULL RETURNING `+cloudScheduleFields, id, session.UserID, request.Revision, string(spec), request.Enabled, next, previous.Admitted), &item)
		if errors.Is(err, sql.ErrNoRows) {
			err = ErrCloudRunConflict
		}
	}
	if err != nil {
		writeScheduleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (h *HTTPHandler) deleteCloudSchedule(w http.ResponseWriter, r *http.Request, session *Session, store *PersistentStore) {
	if err := store.deleteCloudSchedule(r.Context(), session.UserID, r.PathValue("id"), h.service.now().UTC()); err != nil {
		writeScheduleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func nextEnabledSchedule(rule CloudScheduleRule, enabled bool, now time.Time, admitted int) *time.Time {
	if !enabled {
		return nil
	}
	return rule.next(now, admitted)
}

func (h *HTTPHandler) listCloudScheduleRuns(w http.ResponseWriter, r *http.Request, session *Session, store *PersistentStore) {
	items, err := store.cloudScheduleRuns(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeScheduleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"runs": items})
}

func (h *HTTPHandler) getCloudScheduleRun(w http.ResponseWriter, r *http.Request, session *Session, store *PersistentStore) {
	occurrence, err := uuid.Parse(r.PathValue("run"))
	if err != nil {
		writeScheduleError(w, errCloudScheduleInvalid)
		return
	}
	item, err := store.cloudScheduleRun(r.Context(), session.UserID, r.PathValue("id"), occurrence.String())
	if err != nil {
		writeScheduleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"run": item})
}

func (h *HTTPHandler) getCloudScheduleRunReceipt(w http.ResponseWriter, r *http.Request, session *Session, store *PersistentStore) {
	requestID, err := uuid.Parse(r.URL.Query().Get("request_id"))
	if err != nil {
		writeScheduleError(w, errCloudScheduleInvalid)
		return
	}
	taskID := uuid.MustParse(r.PathValue("id")).String()
	receipt := cloudScheduleID(taskID, "manual:"+requestID.String())
	var admitted bool
	err = store.db.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_schedule_occurrences o
 WHERE o.id=$3 AND o.task_id=s.id AND o.user_id=s.user_id AND o.manual)
 FROM zeroagent_cloud_schedules s WHERE s.id=$1 AND s.user_id=$2 AND s.deleted_at IS NULL`,
		taskID, session.UserID, receipt).Scan(&admitted)
	if err != nil {
		writeScheduleError(w, err)
		return
	}
	if admitted {
		writeJSON(w, http.StatusOK, map[string]string{"status": "admitted", "id": receipt})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "missing"})
}

func (h *HTTPHandler) runCloudScheduleNow(w http.ResponseWriter, r *http.Request, session *Session, store *PersistentStore) {
	var request struct {
		RequestID string `json:"request_id"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	id, err := uuid.Parse(request.RequestID)
	if err != nil {
		writeScheduleError(w, errCloudScheduleInvalid)
		return
	}
	taskID := uuid.MustParse(r.PathValue("id")).String()
	requestID := id.String()
	receipt := cloudScheduleID(taskID, "manual:"+requestID)
	var exists bool
	if err := store.db.QueryRowContext(r.Context(), `SELECT EXISTS(SELECT 1 FROM zeroagent_cloud_schedule_occurrences
 WHERE id=$1 AND task_id=$2 AND user_id=$3)`, receipt, taskID, session.UserID).Scan(&exists); err != nil {
		writeScheduleError(w, err)
		return
	}
	if exists {
		writeJSON(w, http.StatusAccepted, map[string]string{"id": receipt})
		return
	}
	if err := h.service.ensureCloudExecutionAccount(r.Context(), store, session); err != nil {
		writeScheduleError(w, err)
		return
	}
	occurrence, err := store.queueCloudSchedule(r.Context(), session.UserID, taskID, requestID, h.service.now().UTC())
	if err != nil {
		writeScheduleError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{"id": occurrence})
}

func (h *HTTPHandler) cancelPendingCloudSchedule(w http.ResponseWriter, r *http.Request, session *Session, store *PersistentStore) {
	runID, err := uuid.Parse(r.PathValue("run"))
	if err != nil {
		writeScheduleError(w, errCloudScheduleInvalid)
		return
	}
	taskID := r.PathValue("id")
	err = store.cancelPendingCloudSchedule(r.Context(), session.UserID, taskID, runID.String())
	if err != nil {
		writeScheduleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) getCloudScheduleApproval(w http.ResponseWriter, r *http.Request, session *Session, store *PersistentStore) {
	runID, err := uuid.Parse(r.PathValue("run"))
	if err != nil {
		writeScheduleError(w, errCloudScheduleInvalid)
		return
	}
	decision, err := store.cloudScheduleApprovalDecision(r.Context(), session.UserID, r.PathValue("id"), runID.String())
	if err != nil {
		writeScheduleError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"decision": decision})
}

func (h *HTTPHandler) decideCloudScheduleApproval(w http.ResponseWriter, r *http.Request, session *Session, store *PersistentStore) {
	var input struct {
		Decision string `json:"decision"`
	}
	if !decodeRequest(w, r, &input) {
		return
	}
	runID, err := uuid.Parse(r.PathValue("run"))
	if err != nil || (input.Decision != "approve" && input.Decision != "reject") {
		writeScheduleError(w, errCloudScheduleInvalid)
		return
	}
	ctx, taskID := r.Context(), r.PathValue("id")
	decision, err := store.cloudScheduleApprovalDecision(ctx, session.UserID, taskID, runID.String())
	if err != nil {
		writeScheduleError(w, err)
		return
	}
	// A retry of a recorded decision only acknowledges the original operation.
	// The execution account may have changed since it was recorded.
	if decision == input.Decision {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if decision != "pending" {
		writeScheduleError(w, errCloudScheduleApprovalConflict)
		return
	}
	if input.Decision == "approve" {
		if err = h.service.ensureCloudExecutionAccount(ctx, store, session); err != nil {
			writeScheduleError(w, err)
			return
		}
	}
	if err = store.decideCloudScheduleApproval(ctx, session.UserID, taskID, runID.String(), input.Decision, h.service.now().UTC()); err != nil {
		writeScheduleError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
