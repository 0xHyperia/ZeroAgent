package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestCloudScheduleWallTimeAndLimits(t *testing.T) {
	utc := func(value string) time.Time {
		t.Helper()
		at, err := time.Parse(time.RFC3339, value)
		if err != nil {
			t.Fatal(err)
		}
		return at
	}
	for _, tc := range []struct {
		name        string
		rule        CloudScheduleRule
		after, want string
	}{
		{"skip DST gap", CloudScheduleRule{Frequency: "daily", Start: "2026-03-07T02:30", TimeZone: "America/New_York"}, "2026-03-07T09:00:00Z", "2026-03-09T06:30:00Z"},
		{"first fold instant", CloudScheduleRule{Frequency: "daily", Start: "2026-10-31T01:30", TimeZone: "America/New_York"}, "2026-11-01T04:00:00Z", "2026-11-01T05:30:00Z"},
		{"skip second fold instant", CloudScheduleRule{Frequency: "daily", Start: "2026-10-31T01:30", TimeZone: "America/New_York"}, "2026-11-01T05:30:00Z", "2026-11-02T06:30:00Z"},
		{"skip short month", CloudScheduleRule{Frequency: "monthly", Start: "2026-01-31T10:00", TimeZone: "UTC"}, "2026-01-31T10:00:00Z", "2026-03-31T10:00:00Z"},
		{"interval anchored to start", CloudScheduleRule{Frequency: "interval", Start: "2026-01-01T10:00", IntervalMinutes: 30, TimeZone: "UTC"}, "2026-01-03T10:11:00Z", "2026-01-03T10:30:00Z"},
		{"workdays skip weekends", CloudScheduleRule{Frequency: "weekly", Start: "2026-11-06T09:00", Weekdays: []time.Weekday{time.Monday, time.Tuesday, time.Wednesday, time.Thursday, time.Friday}, TimeZone: "UTC"}, "2026-11-06T09:00:00Z", "2026-11-09T09:00:00Z"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.rule.validate(); err != nil {
				t.Fatal(err)
			}
			next := tc.rule.next(utc(tc.after), 0)
			if next == nil || !next.Equal(utc(tc.want)) {
				t.Fatalf("next = %v, want %s", next, tc.want)
			}
			tc.rule.Count = 1
			if tc.rule.next(utc(tc.after), 1) != nil {
				t.Fatal("exhausted task has another occurrence")
			}
		})
	}
}

func TestCloudScheduleDispatchUsesDetachedCloudRun(t *testing.T) {
	redis := redisSessionRefreshFixture(t)
	fixture := cloudRunPostgresFixture(t)
	store := fixture.store.(*PersistentStore)
	store.rdb = redis.store.(*PersistentStore).rdb
	ctx := context.Background()
	if _, err := store.db.ExecContext(ctx, CloudMemorySchema+CloudProjectSchema+CloudToolSchema+CloudResearchSourceSchema+CloudBranchSchema); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/app/me":
			_, _ = io.WriteString(w, `{"success":true,"data":{"id":9401}}`)
		case "/api/v1/app/keys":
			_, _ = io.WriteString(w, `{"success":true,"data":{"items":[{"id":41,"key":"synthetic-model-key","status":"active"}]}}`)
		case "/v1/chat/completions":
			calls.Add(1)
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"scheduled result\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(platform.Close)
	service := NewService(store, NewUSAClientWithHTTPClient(platform.URL, platform.Client()), time.Hour, time.Hour)
	t.Cleanup(service.CloseCloudRuns)
	now := time.Now().UTC().Truncate(time.Minute)
	requestTime := now.Add(-time.Minute)
	service.now = func() time.Time { return requestTime }
	session := &Session{ID: uuid.NewString(), UserID: 9401, AccessToken: "synthetic-web-login", AuthKind: AuthKindOAuth, OAuthClientID: "zeroagent-web", AccessExpiresAt: time.Now().Add(time.Hour), SessionExpiresAt: time.Now().Add(time.Hour)}
	redis.remember(session.ID)
	t.Cleanup(func() { _ = store.rdb.Del(ctx, cloudSessionReferenceKey(cloudSessionReference(session.ID))).Err() })
	if err := store.PutSession(ctx, session); err != nil {
		t.Fatal(err)
	}
	legacy := *session
	legacy.ID = uuid.NewString()
	legacy.Purpose = "cloud_schedule"
	redis.remember(legacy.ID)
	if err := store.PutSession(ctx, &legacy); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO zeroagent_cloud_schedule_authority(user_id,session_id) VALUES($1,$2)`, legacy.UserID, legacy.ID); err != nil {
		t.Fatal(err)
	}
	if active, err := service.scheduledCloudExecutionSession(ctx, store, legacy.UserID); err != nil || active.ID != legacy.ID {
		t.Fatalf("an existing plan lost access before its account session was bound: %v", err)
	}
	if err := service.ensureCloudExecutionAccount(ctx, store, session); err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateCloudProject(ctx, &CloudProject{UserID: session.UserID, Name: "Scheduled project", Instructions: "Synthetic project instructions"})
	if err != nil {
		t.Fatal(err)
	}
	input := CloudScheduleInput{
		Name: "Synthetic background task", Rule: CloudScheduleRule{Frequency: "once", Start: now.Format(cloudScheduleWall), TimeZone: "UTC"},
		Run:       CreateCloudRunInput{Model: "test-model", ProviderKeyID: 41, Content: json.RawMessage(`"hello"`)},
		ProjectID: project.ID, NewConversation: true, ArchiveSuccess: true,
	}
	// Create from desktop using the existing Web account session. There is no
	// exchange endpoint or special schedule authorization in this fixture.
	handler := &HTTPHandler{service: service}
	desktop := &Session{UserID: session.UserID, Purpose: desktopCloudAccessPurpose}
	save := httptest.NewRecorder()
	handler.saveCloudSchedule(save, httptest.NewRequest(http.MethodPost, "/api/web-chat/schedules", strings.NewReader(string(cloudJSON(map[string]any{
		"request_id": uuid.NewString(), "enabled": true, "task": input,
	})))), desktop, store)
	var task CloudSchedule
	if save.Code != http.StatusOK || json.Unmarshal(save.Body.Bytes(), &task) != nil || task.ID == "" {
		t.Fatalf("desktop could not create the shared cloud plan: %d %s", save.Code, save.Body.String())
	}
	id := task.ID
	list := httptest.NewRecorder()
	handler.listCloudSchedules(list, httptest.NewRequest(http.MethodGet, "/api/web-chat/schedules", nil), session, store)
	if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), id) || strings.Contains(list.Body.String(), "authorized") {
		t.Fatalf("Web did not see the same plan without separate authorization: %d %s", list.Code, list.Body.String())
	}
	requestTime = now
	if _, _, err := service.CreateCloudRun(ctx, session, CreateCloudRunInput{ClientRequestID: "schedule:" + id}); !errors.Is(err, ErrCloudRunInvalid) {
		t.Fatalf("interactive requests must not mint schedule IDs: %v", err)
	}
	if err = service.StartCloudRuns(ctx); err != nil {
		t.Fatal(err)
	}
	if err = service.cloudRuntime.dispatchSchedule(ctx, store); err != nil {
		t.Fatal(err)
	}
	if err = service.cloudRuntime.dispatchSchedule(ctx, store); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		runs, err := store.cloudScheduleRuns(ctx, session.UserID, id)
		if err != nil {
			t.Fatal(err)
		}
		if len(runs) == 1 && runs[0].State == CloudRunCompleted {
			if runs[0].Output != "scheduled result" || !runs[0].Archived || calls.Load() != 1 {
				t.Fatalf("incorrect result or duplicate call: %v, %d", runs, calls.Load())
			}
			tasks, err := store.listCloudSchedules(ctx, session.UserID)
			if err != nil || len(tasks) != 1 || tasks[0].LatestState != CloudRunCompleted {
				t.Fatalf("incorrect task result summary: %v, %v", tasks, err)
			}
			if err := store.deleteCloudSchedule(ctx, session.UserID, id, now); err != nil {
				t.Fatal(err)
			}
			chat, err := store.GetCloudConversation(ctx, session.UserID, runs[0].ConversationID)
			if err != nil || !chat.Archived || chat.ManagementVersion != 1 {
				t.Fatalf("successful result was not archived with its history preserved: %+v, %v", chat, err)
			}
			binding, err := store.GetCloudConversationProject(ctx, session.UserID, runs[0].ConversationID)
			if err != nil || binding.ProjectID != project.ID {
				t.Fatalf("scheduled result is not associated with its project: %+v, %v", binding, err)
			}
			if err := store.DeleteSession(ctx, session.ID); err != nil {
				t.Fatal(err)
			}
			if _, err := service.scheduledCloudExecutionSession(ctx, store, session.UserID); !cloudExecutionSessionUnavailable(err) {
				t.Fatalf("the removed account session remained usable: %v", err)
			}
			return
		}
		if len(runs) == 1 && runs[0].State == CloudRunFailed {
			t.Fatalf("synthetic scheduled run failed: %s", runs[0].ErrorCode)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("scheduled run did not complete")
}

func TestCloudScheduleDesktopSessionRefreshesWithClientClosed(t *testing.T) {
	redis := redisSessionRefreshFixture(t)
	store := cloudRunPostgresFixture(t).store.(*PersistentStore)
	store.rdb = redis.store.(*PersistentStore).rdb
	ctx := context.Background()
	var exchanges, refreshes atomic.Int32
	const confidentialSecret = "synthetic-web-client-secret-for-test"
	platform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/app-auth/token":
			client, secret, ok := r.BasicAuth()
			if !ok || client != "zeroagent-web" || secret != confidentialSecret {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			switch r.FormValue("grant_type") {
			case "urn:zeroagent:grant:desktop-cloud":
				if r.FormValue("subject_token") != "desktop-login-access" {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				exchanges.Add(1)
				_, _ = io.WriteString(w, `{"access_token":"cloud-access","refresh_token":"cloud-refresh","expires_in":600}`)
			case "refresh_token":
				if r.FormValue("refresh_token") != "cloud-refresh" {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				refreshes.Add(1)
				_, _ = io.WriteString(w, `{"access_token":"renewed-cloud-access","refresh_token":"next-refresh","expires_in":600}`)
			default:
				w.WriteHeader(http.StatusBadRequest)
			}
		case "/api/v1/app/me":
			_, _ = io.WriteString(w, `{"success":true,"data":{"id":9402}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(platform.Close)
	service := NewService(store, NewUSAClientWithHTTPClient(platform.URL, platform.Client(), confidentialSecret), time.Hour, time.Hour)
	actor := &Session{UserID: 9402, AccessToken: "desktop-login-access", Purpose: desktopCloudAccessPurpose}
	if err := service.ensureCloudExecutionAccount(ctx, store, actor); err != nil {
		t.Fatal(err)
	}
	cloud, err := service.scheduledCloudExecutionSession(ctx, store, actor.UserID)
	if err != nil {
		t.Fatal(err)
	}
	redis.remember(cloud.ID)
	ref := cloudSessionReference(cloud.ID)
	t.Cleanup(func() { _ = store.rdb.Del(ctx, cloudSessionReferenceKey(ref)).Err() })
	if err := service.ensureCloudExecutionAccount(ctx, store, actor); err != nil || exchanges.Load() != 1 {
		t.Fatalf("the same account opened another cloud session: %v, exchanges %d", err, exchanges.Load())
	}
	if _, err = store.db.Exec(`INSERT INTO zeroagent_cloud_schedules(id,user_id,next_at,spec) VALUES($1,$2,now()+interval '7 days','{}')`, uuid.NewString(), actor.UserID); err != nil {
		t.Fatal(err)
	}
	if _, err = store.db.Exec(`UPDATE zeroagent_cloud_execution_accounts SET refresh_at=now()-interval '1 minute' WHERE user_id=$1`, actor.UserID); err != nil {
		t.Fatal(err)
	}
	if err = service.refreshCloudExecutionAccount(ctx, store); err != nil || refreshes.Load() != 1 {
		t.Fatalf("did not refresh ahead of an idle plan: %v, refreshes %d", err, refreshes.Load())
	}
	cloud, err = service.scheduledCloudExecutionSession(ctx, store, actor.UserID)
	if err != nil || cloud.AccessToken != "renewed-cloud-access" {
		t.Fatalf("could not execute after desktop login was no longer present: %v", err)
	}
	if _, err = store.db.Exec(`INSERT INTO zeroagent_cloud_execution_accounts(user_id,source,session_ref) VALUES ($1,'web',$2)`, actor.UserID+1, ref); err != nil {
		t.Fatal(err)
	}
	if _, err := service.scheduledCloudExecutionSession(ctx, store, actor.UserID+1); !cloudExecutionSessionUnavailable(err) {
		t.Fatalf("another account could use the desktop cloud session: %v", err)
	}
}

func TestCloudScheduleProjectBindingCannotCrossAccountsOrOverrideManualMove(t *testing.T) {
	store := cloudRunPostgresFixture(t).store.(*PersistentStore)
	ctx := context.Background()
	if _, err := store.db.ExecContext(ctx, CloudProjectSchema); err != nil {
		t.Fatal(err)
	}
	project, err := store.CreateCloudProject(ctx, &CloudProject{UserID: 1, Name: "Scheduled project"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	item := &cloudScheduleDispatch{
		id: uuid.NewString(), task: uuid.NewString(), uid: 2,
		input: CloudScheduleInput{Name: "Synthetic plan", ProjectID: project.ID},
	}
	id := item.input.resultConversation(item.task, item.id)
	if err = store.prepareCloudScheduleConversation(ctx, item, id, now); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign project was available: %v", err)
	}
	if _, err = store.GetCloudConversation(ctx, 2, id); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign attempt created a conversation: %v", err)
	}
	item.uid = 1
	for range 2 {
		if err = store.prepareCloudScheduleConversation(ctx, item, id, now); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = store.SetCloudConversationProject(ctx, 1, id, "", 1); err != nil {
		t.Fatal(err)
	}
	if err = store.prepareCloudScheduleConversation(ctx, item, id, now); !errors.Is(err, ErrCloudProjectConflict) {
		t.Fatalf("a later run overrode the explicit move: %v", err)
	}
}

func TestCloudScheduleArchiveUsesOccurrenceOptionsAndOnlySuccess(t *testing.T) {
	fixture := cloudRunPostgresFixture(t)
	store := fixture.store.(*PersistentStore)
	ctx := context.Background()
	for _, state := range []string{CloudRunFailed, CloudRunCompleted} {
		t.Run(state, func(t *testing.T) {
			task, occurrence := uuid.NewString(), uuid.NewString()
			frozen := CloudScheduleInput{NewConversation: true, ArchiveSuccess: true}
			id := frozen.resultConversation(task, occurrence)
			if _, err := store.db.Exec(`INSERT INTO zeroagent_cloud_schedules(id,user_id,enabled,spec) VALUES ($1,1,false,'{}')`, task); err != nil {
				t.Fatal(err)
			}
			if _, err := store.db.Exec(`INSERT INTO zeroagent_cloud_schedule_occurrences(id,task_id,user_id,trigger_at,manual,spec) VALUES ($1,$2,1,now(),true,$3)`, occurrence, task, string(cloudJSON(frozen))); err != nil {
				t.Fatal(err)
			}
			if err := store.PutCloudConversation(ctx, &CloudConversation{ID: id, UserID: 1, Title: "Scheduled result"}); err != nil {
				t.Fatal(err)
			}
			input := cloudRunTestInput(t, fixture, 1, id, "schedule:"+occurrence, "scheduled run")
			if _, _, err := store.CreateCloudRun(ctx, input); err != nil {
				t.Fatal(err)
			}
			run, err := store.ClaimCloudRun(ctx, "schedule-test", time.Minute)
			if err != nil || run == nil || run.ConversationID != id {
				t.Fatalf("could not claim occurrence run: %v, %v", run, err)
			}
			if _, err = store.CommitCloudRun(ctx, 1, run.ID, "schedule-test", run.Attempt, CloudRunCommit{OperationID: uuid.NewString(), State: state}); err != nil {
				t.Fatal(err)
			}
			chat, err := store.GetCloudConversation(ctx, 1, id)
			if err != nil || chat.Archived != (state == CloudRunCompleted) {
				t.Fatalf("unexpected archive state: %+v, %v", chat, err)
			}
		})
	}
}

func TestCloudScheduleCanPauseWhenItsProjectIsUnavailable(t *testing.T) {
	store := cloudRunPostgresFixture(t).store.(*PersistentStore)
	if _, err := store.db.Exec(CloudProjectSchema); err != nil {
		t.Fatal(err)
	}
	id := uuid.NewString()
	input := CloudScheduleInput{Name: "Scheduled task", ProjectID: uuid.NewString(),
		Rule: CloudScheduleRule{Frequency: "daily", Start: "2026-11-05T10:00", TimeZone: "UTC"},
		Run:  CreateCloudRunInput{Model: "fixture", Content: cloudJSON("synthetic instructions")},
	}
	if _, err := store.db.Exec(`INSERT INTO zeroagent_cloud_schedules(id,user_id,spec) VALUES($1,1,$2)`, id, string(cloudJSON(input))); err != nil {
		t.Fatal(err)
	}
	service := NewService(store, nil, time.Hour, time.Hour)
	handler := &HTTPHandler{service: service}
	update := func(revision int, task CloudScheduleInput) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPut, "/api/web-chat/schedules/"+id, strings.NewReader(string(cloudJSON(map[string]any{"revision": revision, "enabled": false, "task": task}))))
		req.SetPathValue("id", id)
		res := httptest.NewRecorder()
		handler.saveCloudSchedule(res, req, &Session{UserID: 1}, store)
		return res
	}
	if res := update(1, input); res.Code != http.StatusOK {
		t.Fatalf("could not pause plan: %d %s", res.Code, res.Body)
	}
	input.ProjectID = uuid.NewString()
	if res := update(2, input); res.Code != http.StatusConflict {
		t.Fatalf("saved unowned project: %d %s", res.Code, res.Body)
	}
}

func TestCloudSchedulePostgresClaimAndAdmission(t *testing.T) {
	f := cloudRunPostgresFixture(t)
	store := f.store.(*PersistentStore)
	ctx := context.Background()
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.UTC)
	id := uuid.NewString()
	rule := CloudScheduleRule{Frequency: "daily", Start: "2026-11-05T10:00", TimeZone: "UTC", Count: 1}
	spec, err := json.Marshal(CloudScheduleInput{Name: "synthetic", Rule: rule, Run: CreateCloudRunInput{Model: "fixture", Content: json.RawMessage(`"hello"`)}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.db.Exec(`INSERT INTO zeroagent_cloud_schedules(id,user_id,next_at,spec) VALUES($1,1,$2,$3)`, id, now.Add(-24*time.Hour), string(spec)); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := store.enqueueDueCloudSchedule(ctx, now); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	item, err := store.claimCloudSchedule(ctx, now)
	if err != nil || item == nil || !item.trigger.Equal(now) {
		t.Fatalf("incorrect catch-up: %v, %v", item, err)
	}
	if second, err := store.claimCloudSchedule(ctx, now); err != nil || second != nil {
		t.Fatalf("duplicate claim: %v, %v", second, err)
	}
	claimed, err := store.claimCloudSchedule(ctx, now.Add(time.Minute))
	if err != nil || claimed == nil || claimed.id != item.id || claimed.owner == item.owner {
		t.Fatalf("claim was not recovered: %v, %v", claimed, err)
	}
	if err = store.finishCloudSchedule(ctx, item, uuid.NewString(), "submitted", ""); err == nil {
		t.Fatal("stale worker committed")
	}
	if err = store.finishCloudSchedule(ctx, claimed, uuid.NewString(), "submitted", ""); err != nil {
		t.Fatal(err)
	}
	items, err := store.listCloudSchedules(ctx, 1)
	if err != nil || len(items) != 1 || items[0].Admitted != 1 || items[0].NextAt != nil {
		t.Fatalf("incorrect admission accounting: %v, %v", items, err)
	}
	if _, err = store.cloudScheduleRuns(ctx, 2, id); err != ErrNotFound {
		t.Fatalf("foreign account could read schedule: %v", err)
	}
	request := uuid.NewString()
	manual, err := store.queueCloudSchedule(ctx, 1, id, request, now)
	if err != nil {
		t.Fatal(err)
	}
	if err = store.cancelPendingCloudSchedule(ctx, 2, id, manual); err == nil {
		t.Fatal("foreign account cancelled a waiting run")
	}
	if err = store.cancelPendingCloudSchedule(ctx, 1, id, manual); err != nil {
		t.Fatal(err)
	}
	if replayed, err := store.queueCloudSchedule(ctx, 1, id, request, now); err != nil || replayed != manual {
		t.Fatalf("lost manual receipt: %v, %v", replayed, err)
	}
	if waiting, err := store.claimCloudSchedule(ctx, now.Add(time.Second)); err != nil || waiting != nil {
		t.Fatalf("cancelled run was claimed: %v, %v", waiting, err)
	}
	if _, err = store.queueCloudSchedule(ctx, 1, id, uuid.NewString(), now); err != nil {
		t.Fatal(err)
	}
	if err = store.deleteCloudSchedule(ctx, 2, id, now); err != sql.ErrNoRows {
		t.Fatalf("foreign account could delete schedule: %v", err)
	}
	for range 2 {
		if err = store.deleteCloudSchedule(ctx, 1, id, now); err != nil {
			t.Fatal(err)
		}
	}
	if items, err := store.listCloudSchedules(ctx, 1); err != nil || len(items) != 0 {
		t.Fatalf("deleted task is visible: %v, %v", items, err)
	}
	if waiting, err := store.claimCloudSchedule(ctx, now.Add(time.Second)); err != nil || waiting != nil {
		t.Fatalf("deleted task started unclaimed work: %v, %v", waiting, err)
	}
	if _, err := store.queueCloudSchedule(ctx, 1, id, uuid.NewString(), now); err != sql.ErrNoRows {
		t.Fatalf("deleted task was manually queued: %v", err)
	}
}

func TestCloudScheduleApprovalFencesDispatch(t *testing.T) {
	fixture := cloudRunPostgresFixture(t)
	store := fixture.store.(*PersistentStore)
	ctx := context.Background()
	now := time.Date(2026, 11, 6, 10, 0, 0, 0, time.UTC)
	task := uuid.NewString()
	spec, err := json.Marshal(CloudScheduleInput{
		Name: "Approval test", RequireApproval: true,
		Rule: CloudScheduleRule{Frequency: "once", Start: now.Format(cloudScheduleWall), TimeZone: "UTC"},
		Run:  CreateCloudRunInput{Model: "fixture", Content: json.RawMessage(`"frozen prompt"`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`INSERT INTO zeroagent_cloud_schedules(id,user_id,next_at,spec) VALUES($1,1,$2,$3)`, task, now, spec); err != nil {
		t.Fatal(err)
	}
	if err := store.enqueueDueCloudSchedule(ctx, now); err != nil {
		t.Fatal(err)
	}
	if item, err := store.claimCloudSchedule(ctx, now); err != nil || item != nil {
		t.Fatalf("approval did not fence dispatch: %v, %v", item, err)
	}
	runs, err := store.cloudScheduleRuns(ctx, 1, task)
	if err != nil || len(runs) != 1 || runs[0].State != "awaiting_approval" || runs[0].Approval == nil ||
		string(runs[0].Approval.Run.Content) != `"frozen prompt"` {
		t.Fatalf("missing frozen approval: %v, %v", runs, err)
	}
	run := runs[0].ID
	if err := store.decideCloudScheduleApproval(ctx, 2, task, run, "approve", now); err == nil {
		t.Fatal("a different account approved the run")
	}
	approvedAt := now.Add(time.Hour)
	for range 2 {
		if err := store.decideCloudScheduleApproval(ctx, 1, task, run, "approve", approvedAt); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.decideCloudScheduleApproval(ctx, 1, task, run, "reject", approvedAt); err == nil {
		t.Fatal("a second decision superseded the approval")
	}
	if item, err := store.claimCloudSchedule(ctx, approvedAt); err != nil || item == nil || item.id != run || !item.trigger.Equal(now) || !item.readyAt.Equal(approvedAt) {
		t.Fatalf("missing approved original occurrence: %v, %v", item, err)
	}
	if item, err := store.claimCloudSchedule(ctx, approvedAt); err != nil || item != nil {
		t.Fatalf("duplicate claim: %v, %v", item, err)
	}
}
