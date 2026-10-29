package cloudexecutor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testToken = "test-only-random-internal-token-0123456789abcdef"

func testOperation() Operation {
	return Operation{OperationID: "stable-op", OwnerScope: "account-one", WorkspaceRef: "workspace-one", Action: "command.run", SandboxID: "sandbox-one", Input: map[string]any{"command": "true"}}
}

func testReceipt(state string) Receipt {
	return Receipt{OperationID: "stable-op", Action: "command.run", State: state, CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC()}
}

func respond(t *testing.T, w http.ResponseWriter, state string) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if state == StateExecuting {
		w.WriteHeader(http.StatusAccepted)
	}
	if err := json.NewEncoder(w).Encode(testReceipt(state)); err != nil {
		t.Error(err)
	}
}

func clientFor(t *testing.T, handler http.HandlerFunc, configure ...func(*Config)) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	config := Config{BaseURL: server.URL, Token: testToken, PollInterval: time.Millisecond, RequestTimeout: 200 * time.Millisecond, CancelTimeout: 200 * time.Millisecond, MaxWait: time.Second}
	for _, change := range configure {
		change(&config)
	}
	client, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseIdleConnections)
	return client
}

func TestNewRequiresExplicitLoopbackAndStrongToken(t *testing.T) {
	for _, origin := range []string{"https://example.com:443", "http://localhost:17843", "http://0.0.0.0:17843", "http://192.168.1.1:17843", "http://127.0.0.1", "http://user:secret@127.0.0.1:17843", "http://127.0.0.1:17843/path", "http://127.0.0.1:17843?token=secret", "http://127.0.0.1:17843#fragment", "file:///tmp/service"} {
		if _, err := New(Config{BaseURL: origin, Token: testToken}); err == nil {
			t.Errorf("accepted unsafe origin")
		}
	}
	if _, err := New(Config{BaseURL: "http://127.0.0.1:17843", Token: "short"}); err == nil {
		t.Fatal("accepted weak token")
	}
	for _, origin := range []string{"http://127.0.0.1:17843", "http://[::1]:17843"} {
		client, err := New(Config{BaseURL: origin, Token: testToken})
		if err != nil {
			t.Fatal(err)
		}
		client.CloseIdleConnections()
	}
	if _, err := New(Config{BaseURL: "http://127.0.0.1:17843", Token: testToken, MaxResponseBytes: 3_000_000}); err == nil {
		t.Fatal("unbounded response limit")
	}
}

func TestHealthAuthorizationAndNoEnvironmentProxy(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("internal authentication missing")
		}
		if r.Header.Get("Origin") != "" || r.URL.Path != "/v1/health" {
			t.Error("unexpected request")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"service":"zeroagent-cloud-executor","protocol":1,"enabled":false,"disabled_reason":"ZEROAGENT_E2B_API_KEY_missing"}`)
	})
	if client.http.Transport.(*http.Transport).Proxy != nil {
		t.Fatal("environment proxy enabled")
	}
	health, err := client.Health(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if health.Enabled || health.DisabledReason == "" {
		t.Fatal("disabled state missing")
	}
}

func TestExecuteSubmitsOnceThenPollsStableOwnerOperation(t *testing.T) {
	var submits, polls atomic.Int32
	client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("wrong token")
		}
		if r.Method == http.MethodPost {
			submits.Add(1)
			var operation Operation
			if err := json.NewDecoder(r.Body).Decode(&operation); err != nil {
				t.Error(err)
			}
			if operation.OperationID != "stable-op" || operation.OwnerScope != "account-one" || operation.WorkspaceRef != "workspace-one" {
				t.Error("scope lost")
			}
			respond(t, w, StateExecuting)
			return
		}
		if r.URL.Path != "/v1/operations/stable-op" || r.URL.Query().Get("owner_scope") != "account-one" || r.URL.Query().Get("workspace_ref") != "workspace-one" {
			t.Error("poll ownership lost")
		}
		if polls.Add(1) < 3 {
			respond(t, w, StateExecuting)
		} else {
			respond(t, w, StateSucceeded)
		}
	})
	receipt, err := client.Execute(context.Background(), testOperation())
	if err != nil || receipt.State != StateSucceeded {
		t.Fatalf("receipt=%s err=%v", receipt.State, err)
	}
	if submits.Load() != 1 || polls.Load() != 3 {
		t.Fatal("operation was resubmitted or polling diverged")
	}
}

func TestCallerCancelUsesIndependentContextForRemoteCancelAndPoll(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var submits, cancels, polls atomic.Int32
	client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/operations" {
			submits.Add(1)
			respond(t, w, StateExecuting)
			cancel()
			return
		}
		if strings.HasSuffix(r.URL.Path, "/cancel") {
			cancels.Add(1)
			var scope Scope
			_ = json.NewDecoder(r.Body).Decode(&scope)
			if scope != testOperation().Scope() || r.Context().Err() != nil {
				t.Error("cancel scope/context invalid")
			}
			respond(t, w, StateExecuting)
			return
		}
		if polls.Add(1) < 2 {
			respond(t, w, StateExecuting)
		} else {
			respond(t, w, StateCancelled)
		}
	})
	receipt, err := client.Execute(ctx, testOperation())
	if err != nil || receipt.State != StateCancelled {
		t.Fatalf("receipt=%s err=%v", receipt.State, err)
	}
	if submits.Load() != 1 || cancels.Load() != 1 || polls.Load() < 2 {
		t.Fatal("remote cancellation/poll did not happen")
	}
}

func TestLostSubmissionResponseCancelsOriginalWithoutResubmitting(t *testing.T) {
	var submits, cancels atomic.Int32
	client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/operations" {
			submits.Add(1)
			connection, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = connection.Close()
			return
		}
		if strings.HasSuffix(r.URL.Path, "/cancel") {
			cancels.Add(1)
			respond(t, w, StateCancelled)
			return
		}
		t.Error("unexpected request")
	})
	receipt, err := client.Execute(context.Background(), testOperation())
	if err != nil || receipt.State != StateCancelled || submits.Load() != 1 || cancels.Load() != 1 {
		t.Fatalf("receipt=%s submit=%d cancel=%d err=%v", receipt.State, submits.Load(), cancels.Load(), err)
	}
}

func TestFailedCancellationAndProviderUnknownRemainUnknown(t *testing.T) {
	for _, scenario := range []string{"cancel-failure", "provider-unknown", "cleanup-timeout"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			var submits, cancels atomic.Int32
			client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/v1/operations" {
					submits.Add(1)
					if scenario == "provider-unknown" {
						respond(t, w, StateUnknown)
						return
					}
					respond(t, w, StateExecuting)
					cancel()
					return
				}
				if strings.HasSuffix(r.URL.Path, "/cancel") {
					cancels.Add(1)
				}
				if scenario == "cancel-failure" {
					w.WriteHeader(503)
					_, _ = io.WriteString(w, `{"error":{"code":"provider_error","message":"never reflect this"}}`)
					return
				}
				respond(t, w, StateExecuting)
			}, func(config *Config) { config.CancelTimeout = 20 * time.Millisecond })
			receipt, err := client.Execute(ctx, testOperation())
			var unknown *UnknownOutcomeError
			if !errors.As(err, &unknown) || receipt.State != StateUnknown || unknown.Receipt.OperationID != "stable-op" || submits.Load() != 1 {
				t.Fatalf("receipt=%s err=%v", receipt.State, err)
			}
			if strings.Contains(err.Error(), testToken) {
				t.Fatal("token reflected")
			}
			if scenario == "provider-unknown" && cancels.Load() != 0 {
				t.Fatal("unknown operation was automatically retried/cancelled")
			}
		})
	}
}

func TestDefinitiveRejectionsDoNotCancelOrRetry(t *testing.T) {
	for _, status := range []int{400, 401, 404, 409, 413, 429} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			var requests atomic.Int32
			client := clientFor(t, func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				w.WriteHeader(status)
				_, _ = io.WriteString(w, `{"error":{"code":"operation_conflict","message":"secret-provider-url"}}`)
			})
			_, err := client.Execute(context.Background(), testOperation())
			var apiError *APIError
			if !errors.As(err, &apiError) || apiError.Status != status || requests.Load() != 1 || strings.Contains(err.Error(), "secret-provider") {
				t.Fatalf("err=%v requests=%d", err, requests.Load())
			}
		})
	}
}

func TestRedirectIsNeverFollowedAndTokenCannotLeaveLoopbackService(t *testing.T) {
	var destination atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { destination.Add(1); respond(t, w, StateSucceeded) }))
	defer target.Close()
	client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	})
	_, err := client.Submit(context.Background(), testOperation())
	var apiError *APIError
	if !errors.As(err, &apiError) || apiError.Status != 307 || destination.Load() != 0 {
		t.Fatalf("err=%v destination=%d", err, destination.Load())
	}
}

func TestBoundsMismatchedReceiptsAndSecretRedaction(t *testing.T) {
	t.Run("request", func(t *testing.T) {
		var calls atomic.Int32
		client := clientFor(t, func(http.ResponseWriter, *http.Request) { calls.Add(1) }, func(config *Config) { config.MaxRequestBytes = 64 })
		_, err := client.Execute(context.Background(), testOperation())
		var apiError *APIError
		if !errors.As(err, &apiError) || apiError.Code != "body_limit" || calls.Load() != 0 {
			t.Fatalf("err=%v calls=%d", err, calls.Load())
		}
	})
	t.Run("response", func(t *testing.T) {
		client := clientFor(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, strings.Repeat("x", 129))
		}, func(config *Config) { config.MaxResponseBytes = 128 })
		_, err := client.Submit(context.Background(), testOperation())
		var apiError *APIError
		if !errors.As(err, &apiError) || apiError.Code != "response_limit" || !apiError.MayHaveExecuted {
			t.Fatal(err)
		}
	})
	t.Run("wrong-operation", func(t *testing.T) {
		client := clientFor(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			receipt := testReceipt(StateSucceeded)
			receipt.OperationID = "other"
			_ = json.NewEncoder(w).Encode(receipt)
		})
		_, err := client.Submit(context.Background(), testOperation())
		var apiError *APIError
		if !errors.As(err, &apiError) || apiError.Code != "invalid_receipt" || !apiError.MayHaveExecuted {
			t.Fatal(err)
		}
	})
	t.Run("redact", func(t *testing.T) {
		client := clientFor(t, func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			receipt := testReceipt(StateFailed)
			receipt.Result = json.RawMessage(`{"stdout":"` + testToken + `"}`)
			receipt.Error = &ReceiptError{Code: "provider_error", Message: "URL?secret=" + testToken}
			_ = json.NewEncoder(w).Encode(receipt)
		})
		receipt, err := client.Submit(context.Background(), testOperation())
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(receipt)
		if strings.Contains(string(encoded), testToken) || receipt.Error.Message != "provider_error" || !strings.Contains(string(receipt.Result), "[redacted]") {
			t.Fatal("secret reflected")
		}
	})
}

func TestCallerAlreadyCancelledDoesNotSubmit(t *testing.T) {
	var calls atomic.Int32
	client := clientFor(t, func(http.ResponseWriter, *http.Request) { calls.Add(1) })
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := client.Execute(ctx, testOperation()); !errors.Is(err, context.Canceled) || calls.Load() != 0 {
		t.Fatalf("err=%v calls=%d", err, calls.Load())
	}
}
