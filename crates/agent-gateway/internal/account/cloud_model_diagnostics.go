package account

import (
	"context"
	"fmt"
	"log/slog"
	"time"
)

// Diagnostics contain only locally selected enums and the response status.
// Failure to save them must never replay a model request or change its outcome.
func (r *cloudRunRuntime) recordCloudModelFailure(ctx context.Context, run *CloudRun, owner string, round, status int, public bool, kind string) {
	if status < 100 || status > 599 || round < 0 || round >= 32 || (kind != "http_status" && kind != "stream_error") {
		return
	}
	phase := "private_synthesis"
	if public {
		phase = "public_research"
	}
	writeCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer cancel()
	_, err := r.store.CommitCloudRun(writeCtx, run.UserID, run.ID, owner, run.Attempt, CloudRunCommit{
		OperationID: fmt.Sprintf("model-failure:%s:%d:%d", run.ID, run.Attempt, round),
		EventType:   "model.request_failed",
		Payload:     cloudJSON(map[string]any{"http_status": status, "round": round, "phase": phase, "failure_kind": kind}),
	})
	if err != nil {
		// Store/driver errors can contain configuration or submitted data. The
		// fixed warning is sufficient to distinguish missing persisted evidence.
		slog.Warn("cloud model failure metadata was not persisted", "run_id", run.ID, "round", round, "phase", phase, "http_status", status, "failure_kind", kind)
	}
}
