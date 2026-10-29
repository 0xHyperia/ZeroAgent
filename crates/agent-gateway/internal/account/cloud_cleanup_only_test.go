package account

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

func TestCloudRunUnknownAllocationCleanupRequiresExplicitObservationAuthority(t *testing.T) {
	for _, mode := range []string{"unsafe-owned", "missing-authority", "wrong-create", "retry-safe"} {
		t.Run(mode, func(t *testing.T) {
			ctx := context.Background()
			fixture := memoryCloudToolFixture(t)
			run := toolRunningRun(t, fixture, 7, "")
			binding, _, err := fixture.tools.ReserveCloudWorkspace(ctx, 7, run.ID, run.LeaseOwner, run.Attempt, 60, 180)
			if err != nil {
				t.Fatal(err)
			}
			pending, err := fixture.tools.RequestCloudWorkspaceCleanup(ctx, 7, binding.ID)
			if err != nil || len(pending) != 1 {
				t.Fatal("missing original allocation cleanup fact")
			}
			var kills, creates atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if request.Method == http.MethodGet {
					w.WriteHeader(404)
					_, _ = w.Write([]byte(`{"error":{"code":"operation_not_found"}}`))
					return
				}
				if strings.HasSuffix(request.URL.Path, "/acknowledge") {
					id := strings.TrimSuffix(strings.TrimPrefix(request.URL.Path, "/v1/operations/"), "/acknowledge")
					_ = json.NewEncoder(w).Encode(map[string]any{"operation_id": id, "acknowledged": true})
					return
				}
				var operation cloudexecutor.Operation
				if json.NewDecoder(request.Body).Decode(&operation) != nil {
					t.Error("invalid internal operation")
					w.WriteHeader(400)
					return
				}
				receipt := cloudexecutor.Receipt{OperationID: operation.OperationID, Action: operation.Action, State: cloudexecutor.StateSucceeded, CreatedAt: time.Now(), UpdatedAt: time.Now()}
				switch operation.Action {
				case "sandbox.reconcile":
					result := map[string]any{"create_operation_id": binding.CreateOperationID, "cleanup_only": true, "automatic_retry_safe": false,
						"candidates": []any{map[string]any{"sandbox_id": "unsafe-owned-vm", "network": map[string]any{"outbound": "unconfirmed", "public_access": true}, "auto_resume": true}}}
					if mode == "missing-authority" {
						delete(result, "cleanup_only")
					}
					if mode == "wrong-create" {
						result["create_operation_id"] = "other-create"
					}
					if mode == "retry-safe" {
						result["automatic_retry_safe"] = true
					}
					receipt.Result = cloudJSON(result)
				case "sandbox.kill":
					kills.Add(1)
					if operation.SandboxID != "unsafe-owned-vm" || operation.OwnerScope != binding.OwnerScope || operation.WorkspaceRef != binding.WorkspaceRef {
						t.Error("cleanup escaped original allocation scope")
					}
					receipt.Result = cloudJSON(map[string]any{"sandbox_id": operation.SandboxID, "sandbox_terminated": true})
				default:
					creates.Add(1)
					t.Error("cleanup attempted execution or allocation")
				}
				_ = json.NewEncoder(w).Encode(receipt)
			}))
			t.Cleanup(server.Close)
			client, err := cloudexecutor.New(cloudexecutor.Config{BaseURL: server.URL, Token: strings.Repeat("c", 48)})
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(client.CloseIdleConnections)
			(&cloudRunRuntime{}).cleanupWorkspace(ctx, client, fixture.tools, pending[0])
			current, err := fixture.tools.GetCloudWorkspace(ctx, 7, run.ConversationID)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "unsafe-owned" {
				if kills.Load() != 1 || current.State != CloudWorkspaceClosed {
					t.Fatal("unsafe owned allocation was hidden from confirmed cleanup")
				}
			} else if kills.Load() != 0 || current.State == CloudWorkspaceClosed {
				t.Fatal("unverified observation authorized cleanup or claimed closure")
			}
			if creates.Load() != 0 {
				t.Fatal("cleanup allocated or resumed work")
			}
		})
	}
}
