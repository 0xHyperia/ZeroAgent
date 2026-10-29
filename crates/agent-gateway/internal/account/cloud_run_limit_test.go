package account

import (
	"context"
	"io"
	"net/http"
	"testing"
)

func TestCloudRunHTTPOutputLimitPreservesPartialWithoutClaimingComplete(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		emitCloudDelta(w, "尚未完成的分析")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]\n\n")
	})
	run, _ := f.create(t, "output-limit-request", "分析资料")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunInterrupted || finished.ErrorCode != "model_output_limit" || finished.Output != "尚未完成的分析" {
		t.Fatalf("limit result state=%s code=%s", finished.State, finished.ErrorCode)
	}
	history, err := f.store.ListCloudMessages(context.Background(), 1, f.conversation.ID)
	if err != nil || len(history) != 2 || string(history[1].Content) != `"尚未完成的分析"` {
		t.Fatal("partial output not retained in canonical history")
	}
}
