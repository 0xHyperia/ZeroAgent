package account

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

func (r *cloudRunRuntime) scheduleWorker(store *PersistentStore) {
	defer r.wg.Done()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(r.ctx, 20*time.Second)
			err := r.dispatchSchedule(ctx, store)
			cancel()
			if err != nil && r.ctx.Err() == nil {
				slog.Warn("scheduled Cloud Run dispatch incomplete")
			}
		}
	}
}

func (r *cloudRunRuntime) cloudExecutionRefreshWorker(store *PersistentStore) {
	defer r.wg.Done()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(r.ctx, 10*time.Second)
			err := r.service.refreshCloudExecutionAccount(ctx, store)
			cancel()
			if err != nil && r.ctx.Err() == nil {
				slog.Warn("cloud execution session refresh incomplete")
			}
		}
	}
}

func (r *cloudRunRuntime) dispatchSchedule(ctx context.Context, store *PersistentStore) error {
	now := r.service.now().UTC()
	if err := store.enqueueDueCloudSchedule(ctx, now); err != nil {
		return err
	}
	item, err := store.claimCloudSchedule(ctx, now)
	if err != nil || item == nil {
		return err
	}
	requestID := "schedule:" + item.id
	previous, err := store.GetCloudRunByClientRequest(ctx, item.uid, requestID)
	if err == nil {
		return store.finishCloudSchedule(ctx, item, previous.ID, "submitted", "")
	}
	if !errors.Is(err, ErrNotFound) {
		return err
	}
	if item.readyAt.Before(now.Add(-cloudScheduleGrace)) {
		return store.finishCloudSchedule(ctx, item, "", "skipped", "missed")
	}
	session, err := r.service.cloudExecutionSession(ctx, store, item.uid)
	if err != nil {
		var api *APIError
		if errors.As(err, &api) && (api.Status == http.StatusUnauthorized || api.Status == http.StatusForbidden) {
			return store.finishCloudSchedule(ctx, item, "", "needs_attention", "authorization_required")
		}
		return err
	}
	input := item.input.Run
	input.ConversationID = item.input.resultConversation(item.task, item.id)
	input.ClientRequestID = requestID
	if err = store.prepareCloudScheduleConversation(ctx, item, input.ConversationID, now); errors.Is(err, ErrNotFound) || errors.Is(err, ErrCloudProjectConflict) {
		return store.finishCloudSchedule(ctx, item, "", "needs_attention", "schedule_project_unavailable")
	} else if err != nil {
		return err
	}
	run, _, err := r.service.createCloudRun(ctx, session, input, true)
	if run != nil {
		return store.finishCloudSchedule(ctx, item, run.ID, "submitted", "")
	}
	if err == nil {
		return ErrCloudRunInvalid
	}
	var api *APIError
	if !errors.As(cloudRunAPIError(err), &api) {
		return err
	}
	switch api.Status {
	case http.StatusTooManyRequests, http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusInternalServerError:
		return err
	case http.StatusUnauthorized, http.StatusForbidden:
		return store.finishCloudSchedule(ctx, item, "", "needs_attention", "authorization_required")
	default:
		return store.finishCloudSchedule(ctx, item, "", "failed", api.Reason)
	}
}
