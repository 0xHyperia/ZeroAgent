package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func setCloudRunTestAdmission(t *testing.T, f cloudRunTestFixture, executing, queued int) {
	t.Helper()
	if err := f.runs.(CloudRunAdmissionStore).ConfigureCloudRunAdmission(context.Background(), CloudRunAdmissionLimits{MaxExecutingPerAccount: executing, MaxQueuedPerAccount: queued}); err != nil {
		t.Fatal(err)
	}
}

func createCloudAdmissionTestRun(t *testing.T, f cloudRunTestFixture, userID int64) *CloudRun {
	t.Helper()
	run, created, err := f.runs.CreateCloudRun(context.Background(), cloudRunTestInput(t, f, userID, "", uuid.NewString(), "queued work"))
	if err != nil || !created {
		t.Fatalf("create: %v", err)
	}
	return run
}

func finishCloudAdmissionTestRun(t *testing.T, f cloudRunTestFixture, run *CloudRun, state string) {
	t.Helper()
	if _, err := f.runs.CommitCloudRun(context.Background(), run.UserID, run.ID, run.LeaseOwner, run.Attempt, CloudRunCommit{OperationID: uuid.NewString(), State: state}); err != nil {
		t.Fatal(err)
	}
}

func runCloudRunAdmissionContract(t *testing.T, factory func(*testing.T) cloudRunTestFixture) {
	t.Run("queue bound and replay before quota", func(t *testing.T) {
		f := factory(t)
		setCloudRunTestAdmission(t, f, 1, 2)
		first := cloudRunTestInput(t, f, 61, "", uuid.NewString(), "first")
		accepted, _, err := f.runs.CreateCloudRun(context.Background(), first)
		if err != nil {
			t.Fatal(err)
		}
		createCloudAdmissionTestRun(t, f, 61)
		third := cloudRunTestInput(t, f, 61, "", uuid.NewString(), "rejected")
		if _, _, err = f.runs.CreateCloudRun(context.Background(), third); !errors.Is(err, ErrCloudRunQueueFull) {
			t.Fatalf("queue cap bypassed: %v", err)
		}
		if history, _ := f.store.ListCloudMessages(context.Background(), 61, third.ConversationID); len(history) != 0 {
			t.Fatal("rejected admission wrote user history")
		}
		for range 3 {
			again, created, err := f.runs.CreateCloudRun(context.Background(), first)
			if err != nil || created || again.ID != accepted.ID {
				t.Fatal("full queue rejected an accepted request replay")
			}
		}
		changed := cloudRunTestInput(t, f, 61, first.ConversationID, first.ClientRequestID, "changed")
		if _, _, err = f.runs.CreateCloudRun(context.Background(), changed); !errors.Is(err, ErrCloudRunConflict) {
			t.Fatal("idempotency conflict lost precedence")
		}
		createCloudAdmissionTestRun(t, f, 62)
		if _, err = f.runs.CancelCloudRun(context.Background(), 61, accepted.ID); err != nil {
			t.Fatal(err)
		}
		if _, created, err := f.runs.CreateCloudRun(context.Background(), third); err != nil || !created {
			t.Fatal("queued cancel failed to free account quota")
		}
	})
	t.Run("concurrent admission cannot overfill", func(t *testing.T) {
		f := factory(t)
		setCloudRunTestAdmission(t, f, 1, 3)
		inputs := make([]*CloudRun, 24)
		for index := range inputs {
			inputs[index] = cloudRunTestInput(t, f, 63, "", uuid.NewString(), "concurrent")
		}
		var accepted, rejected atomic.Int32
		var group sync.WaitGroup
		for _, input := range inputs {
			group.Add(1)
			go func(input *CloudRun) {
				defer group.Done()
				_, created, err := f.runs.CreateCloudRun(context.Background(), input)
				if err == nil && created {
					accepted.Add(1)
				} else if errors.Is(err, ErrCloudRunQueueFull) {
					rejected.Add(1)
				} else {
					t.Errorf("concurrent admission: %v", err)
				}
			}(input)
		}
		group.Wait()
		if accepted.Load() != 3 || rejected.Load() != 21 {
			t.Fatalf("accepted=%d rejected=%d", accepted.Load(), rejected.Load())
		}
	})
	t.Run("cross worker claims limited per account", func(t *testing.T) {
		f := factory(t)
		for range 4 {
			createCloudAdmissionTestRun(t, f, 64)
			createCloudAdmissionTestRun(t, f, 65)
		}
		var group sync.WaitGroup
		var mu sync.Mutex
		owners := map[int64]int{}
		for worker := range 16 {
			group.Add(1)
			go func(worker int) {
				defer group.Done()
				run, err := f.runs.ClaimCloudRun(context.Background(), fmt.Sprintf("claim-worker-%d", worker), time.Minute)
				if errors.Is(err, ErrNotFound) {
					return
				}
				if err != nil {
					t.Errorf("claim: %v", err)
					return
				}
				mu.Lock()
				owners[run.UserID]++
				mu.Unlock()
			}(worker)
		}
		group.Wait()
		if len(owners) != 2 || owners[64] != 1 || owners[65] != 1 {
			t.Fatalf("per account claim semaphore bypassed: %v", owners)
		}
	})
	t.Run("least recently served accounts ahead of old backlog", func(t *testing.T) {
		f := factory(t)
		if memory, ok := f.store.(*MemoryStore); ok {
			memory.now = time.Now
		}
		for range 5 {
			createCloudAdmissionTestRun(t, f, 66)
		}
		first, err := f.runs.ClaimCloudRun(context.Background(), "fair-first", time.Minute)
		if err != nil || first.UserID != 66 {
			t.Fatal("first account not selected")
		}
		finishCloudAdmissionTestRun(t, f, first, CloudRunCompleted)
		for range 2 {
			createCloudAdmissionTestRun(t, f, 67)
		}
		// A fresh process uses database facts, not its own scheduling history.
		if persistent, ok := f.store.(*PersistentStore); ok {
			f.runs = &PersistentStore{db: persistent.db}
		}
		for index, want := range []int64{67, 66, 67, 66} {
			run, err := f.runs.ClaimCloudRun(context.Background(), fmt.Sprintf("fair-%d", index), time.Minute)
			if err != nil || run.UserID != want {
				t.Fatalf("turn %d: run=%+v err=%v want account %d", index, run, err, want)
			}
			finishCloudAdmissionTestRun(t, f, run, CloudRunCompleted)
		}
	})
	t.Run("cancelling lease still occupies execution slot", func(t *testing.T) {
		f := factory(t)
		createCloudAdmissionTestRun(t, f, 68)
		createCloudAdmissionTestRun(t, f, 68)
		run, err := f.runs.ClaimCloudRun(context.Background(), "cancel-owner", time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.CancelCloudRun(context.Background(), 68, run.ID); err != nil {
			t.Fatal(err)
		}
		if _, err = f.runs.ClaimCloudRun(context.Background(), "blocked-owner", time.Minute); !errors.Is(err, ErrNotFound) {
			t.Fatal("cancelling task freed execution early")
		}
		finishCloudAdmissionTestRun(t, f, run, CloudRunCancelled)
		if next, err := f.runs.ClaimCloudRun(context.Background(), "next-owner", time.Minute); err != nil || next.UserID != 68 {
			t.Fatal("terminal cancellation did not free execution slot")
		}
	})
	t.Run("crash lease requires durable interruption before new claim", func(t *testing.T) {
		f := factory(t)
		createCloudAdmissionTestRun(t, f, 69)
		createCloudAdmissionTestRun(t, f, 69)
		run, err := f.runs.ClaimCloudRun(context.Background(), "dead-owner", time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		f.expire(run.ID)
		if _, err = f.runs.ClaimCloudRun(context.Background(), "too-early", time.Minute); !errors.Is(err, ErrNotFound) {
			t.Fatal("expired process considered safely gone before durable interruption")
		}
		if count, err := f.runs.InterruptExpiredCloudRuns(context.Background()); err != nil || count != 1 {
			t.Fatalf("recover: %d %v", count, err)
		}
		next, err := f.runs.ClaimCloudRun(context.Background(), "recovery-owner", time.Minute)
		if err != nil || next.ID == run.ID || next.UserID != 69 {
			t.Fatal("recovery retried old effect or failed to release slot")
		}
	})
	t.Run("configured shared limits and conservative decreases", func(t *testing.T) {
		f := factory(t)
		setCloudRunTestAdmission(t, f, 2, 5)
		for range 3 {
			createCloudAdmissionTestRun(t, f, 70)
		}
		first, err := f.runs.ClaimCloudRun(context.Background(), "config-one", time.Minute)
		if err != nil {
			t.Fatal(err)
		}
		second, err := f.runs.ClaimCloudRun(context.Background(), "config-two", time.Minute)
		if err != nil || second.UserID != first.UserID {
			t.Fatal("configured concurrency not applied")
		}
		setCloudRunTestAdmission(t, f, 1, 5)
		if _, err = f.runs.ClaimCloudRun(context.Background(), "config-three", time.Minute); !errors.Is(err, ErrNotFound) {
			t.Fatal("policy decrease ignored existing execution")
		}
		finishCloudAdmissionTestRun(t, f, first, CloudRunCompleted)
		if _, err = f.runs.ClaimCloudRun(context.Background(), "still-full", time.Minute); !errors.Is(err, ErrNotFound) {
			t.Fatal("remaining execution not counted")
		}
		finishCloudAdmissionTestRun(t, f, second, CloudRunCompleted)
		if _, err = f.runs.ClaimCloudRun(context.Background(), "now-free", time.Minute); err != nil {
			t.Fatal(err)
		}
	})
}

func TestCloudRunAdmissionMemoryContract(t *testing.T) {
	runCloudRunAdmissionContract(t, cloudRunMemoryFixture)
}
func TestCloudRunAdmissionPostgresContract(t *testing.T) {
	runCloudRunAdmissionContract(t, cloudRunPostgresFixture)
}

func TestCloudRunAdmissionHTTPQueueFullIsDefiniteUnacceptedAndRetryable(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		emitCloudDelta(w, "accepted")
		emitModelFinish(w, "stop", 1)
	})
	fixture := cloudRunTestFixture{store: f.store, runs: f.store}
	setCloudRunTestAdmission(t, fixture, 1, 1)
	occupied := createCloudAdmissionTestRun(t, fixture, 1)
	input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: "explicit-admission-retry", Model: "test-model", ProviderKeyID: 41, Content: cloudJSON("queued request")}
	status, body := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var failure struct {
		Reason  string `json:"reason"`
		Message string `json:"error"`
	}
	if status != 429 || json.Unmarshal([]byte(body), &failure) != nil || failure.Reason != "account_queue_full" || failure.Message == "" {
		t.Fatalf("queue response status=%d body=%s", status, body)
	}
	if messages, _ := f.store.ListCloudMessages(context.Background(), 1, input.ConversationID); len(messages) != 0 || f.calls.Load() != 0 {
		t.Fatal("rejected request executed or wrote input history")
	}
	if _, err := f.store.CancelCloudRun(context.Background(), 1, occupied.ID); err != nil {
		t.Fatal(err)
	}
	status, body = f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var accepted struct {
		Run *CloudRun `json:"run"`
	}
	if status != 202 || json.Unmarshal([]byte(body), &accepted) != nil || accepted.Run == nil || accepted.Run.ClientRequestID != input.ClientRequestID {
		t.Fatalf("explicit unchanged retry rejected: %d %s", status, body)
	}
	if run := f.wait(t, accepted.Run.ID, func(run *CloudRun) bool { return run.Terminal() }); run.State != CloudRunCompleted {
		t.Fatal("accepted retry did not complete")
	}
}
