package account

import (
	"context"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

// Call only after every required durable fact has committed. Losing an ACK
// reply is harmless: retirement is idempotent and never permits a fresh effect.
// ACK availability must never change an already persisted execution result.
func acknowledgeCloudSDKReceipt(ctx context.Context, client *cloudexecutor.Client, receipt cloudexecutor.Receipt, scope cloudexecutor.Scope) {
	if client == nil || (receipt.State != cloudexecutor.StateSucceeded && receipt.State != cloudexecutor.StateFailed && receipt.State != cloudexecutor.StateCancelled) {
		return
	}
	ackCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
	defer cancel()
	for range 2 {
		if client.Acknowledge(ackCtx, receipt.OperationID, scope) == nil || ackCtx.Err() != nil {
			return
		}
	}
}
