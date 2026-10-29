package cloudexecutor

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
)

func TestAcknowledgeUsesStableOwnerScopeAndAcceptsDuplicate(t *testing.T) {
	var acknowledgements atomic.Int32
	client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v1/operations/stable-op/acknowledge" || r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("acknowledgement escaped authenticated operation path")
		}
		var fields map[string]string
		_ = json.NewDecoder(r.Body).Decode(&fields)
		if len(fields) != 2 || fields["owner_scope"] != "account-one" || fields["workspace_ref"] != "workspace-one" {
			t.Error("acknowledgement body was not exactly the trusted scope")
		}
		acknowledgements.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"operation_id":"stable-op","acknowledged":true}`)
	})
	for range 2 {
		if err := client.Acknowledge(context.Background(), "stable-op", testOperation().Scope()); err != nil {
			t.Fatal(err)
		}
	}
	if acknowledgements.Load() != 2 {
		t.Fatal("duplicate acknowledgement changed identity")
	}
	for _, id := range []string{"", "../other", "with?query"} {
		if err := client.Acknowledge(context.Background(), id, testOperation().Scope()); err == nil {
			t.Fatal("invalid acknowledgement identifier accepted")
		}
	}
	if acknowledgements.Load() != 2 {
		t.Fatal("invalid identifier made a request")
	}
}

func TestAcknowledgeRejectsUnconfirmedOrMismatchedReply(t *testing.T) {
	for _, body := range []string{`{"operation_id":"other-op","acknowledged":true}`, `{"operation_id":"stable-op","acknowledged":false}`, `{}`} {
		client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, body)
		})
		var api *APIError
		err := client.Acknowledge(context.Background(), "stable-op", testOperation().Scope())
		if !errors.As(err, &api) || api.Code != "invalid_receipt" || !api.MayHaveExecuted {
			t.Fatal("unconfirmed retirement reported success")
		}
	}
}

func TestRetiredResultRemainsExecutedAndCannotBecomeFreshRetry(t *testing.T) {
	var submits, cancels atomic.Int32
	client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == "POST" && r.URL.Path == "/v1/operations" {
			submits.Add(1)
		}
		if strings.HasSuffix(r.URL.Path, "/cancel") {
			cancels.Add(1)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusGone)
		_, _ = io.WriteString(w, `{"error":{"code":"operation_result_retired","message":"private result was intentionally removed"}}`)
	})
	_, err := client.Get(context.Background(), "stable-op", testOperation().Scope())
	var api *APIError
	if !errors.As(err, &api) || api.Status != 410 || api.Code != "operation_result_retired" || !api.MayHaveExecuted {
		t.Fatal("retired result was mistaken for an unexecuted operation")
	}
	_, err = client.Execute(context.Background(), testOperation())
	var unknown *UnknownOutcomeError
	if !errors.As(err, &unknown) || submits.Load() != 1 || cancels.Load() != 1 || strings.Contains(err.Error(), "private result") {
		t.Fatal("retirement generated a new submission or exposed private error details")
	}
}

func TestAcknowledgeDefinitiveForeignOrActiveRejection(t *testing.T) {
	for _, status := range []int{404, 409} {
		var requests atomic.Int32
		client := clientFor(t, func(w http.ResponseWriter, r *http.Request) {
			requests.Add(1)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = io.WriteString(w, `{"error":{"code":"operation_not_terminal"}}`)
		})
		var api *APIError
		err := client.Acknowledge(context.Background(), "stable-op", testOperation().Scope())
		if !errors.As(err, &api) || api.Status != status || requests.Load() != 1 {
			t.Fatal("active/foreign operation acknowledgement was accepted or retried implicitly")
		}
	}
}
