package account

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCloudPublicGuidancePreservesValidatedDateWithoutTimeZoneOrLocale(t *testing.T) {
	now := time.Date(2026, time.December, 31, 16, 30, 0, 0, time.UTC)
	parameters := CloudRunModelParameters{TimeZone: "Asia/Hong_Kong", Locale: "zh-HK"}
	tools := []map[string]any{cloudToolFunction("web_search", "public research", nil)}
	public := cloudPublicCapabilityGuidance(now, parameters, tools)
	if !strings.Contains(public, "Relative-date baseline (calendar only): 2027-01-01") || !strings.Contains(public, "Server UTC time: 2026-12-31T16:30:00Z") {
		t.Fatal("public guidance used the previous UTC day as the user's calendar date")
	}
	for _, private := range []string{"Asia/Hong_Kong", "zh-HK", "2027-01-01T00:30:00+08:00", "Preferred time zone:", "Locale preference:"} {
		if strings.Contains(public, private) {
			t.Fatalf("public guidance disclosed %s", private)
		}
	}
	if strings.Count(public, "Web search available:") != 1 || !strings.Contains(public, "Web search available: true") {
		t.Fatal("calendar mode duplicated or changed capability declarations")
	}
	private := cloudCapabilityGuidance(now, parameters, tools)
	if !strings.Contains(private, "Preferred time zone: Asia/Hong_Kong; local date: 2027-01-01; local time: 2027-01-01T00:30:00+08:00") || !strings.Contains(private, `Locale preference: "zh-HK"`) {
		t.Fatal("private guidance lost its existing complete calendar convention")
	}
}

func TestCloudRunPublicCalendarBoundaryReachesActualModelRequest(t *testing.T) {
	now := time.Date(2026, time.December, 31, 16, 30, 0, 0, time.UTC)
	const privateCanary = "PRIVATE_CALENDAR_REQUEST_CANARY"
	var rounds atomic.Int32
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		body := string(data)
		if rounds.Add(1) == 1 {
			if !strings.Contains(body, "Relative-date baseline (calendar only): 2027-01-01") || !strings.Contains(body, "Server UTC time: 2026-12-31T16:30:00Z") {
				t.Error("public loop did not call calendar-only guidance with the real server UTC time")
			}
			for _, private := range []string{"Asia/Hong_Kong", "zh-HK", privateCanary} {
				if strings.Contains(body, private) {
					t.Errorf("public request leaked %s", private)
				}
			}
			emitCloudDelta(w, "public calendar draft")
			emitModelFinish(w, "stop", 1)
			return
		}
		for _, value := range []string{"Preferred time zone: Asia/Hong_Kong", "local date: 2027-01-01", "zh-HK", privateCanary} {
			if !strings.Contains(body, value) {
				t.Errorf("private calendar guidance lost %s", value)
			}
		}
		emitCloudDelta(w, "final calendar answer")
		emitModelFinish(w, "stop", 1)
	})
	configureCloudResearchFixture(t, f)
	// Only the test injects a deterministic server clock. The production helper
	// always receives service.now and never accepts a client-supplied 'now'.
	session, err := f.store.GetSession(context.Background(), "synthetic-browser-cookie")
	if err != nil {
		t.Fatal(err)
	}
	f.service.now = func() time.Time { return now }
	f.store.now = func() time.Time { return now }
	session.AccessExpiresAt, session.SessionExpiresAt = now.Add(time.Hour), now.Add(time.Hour)
	if err = f.store.PutSession(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: "public-calendar-boundary", Model: "test-model", ProviderKeyID: 41, Content: cloudJSON(privateCanary), ModelParameters: CloudRunModelParameters{TimeZone: "Asia/Hong_Kong", Locale: "zh-HK"}, PublicResearch: &CloudRunPublicResearch{Topic: "今天的公开信息"}}
	status, data := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var response struct {
		Run *CloudRun `json:"run"`
	}
	if status != http.StatusAccepted || json.Unmarshal([]byte(data), &response) != nil || response.Run == nil {
		t.Fatalf("calendar request was not accepted: %d", status)
	}
	finished := f.wait(t, response.Run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || finished.Output != "final calendar answer" || rounds.Load() != 2 {
		t.Fatalf("calendar phase result state=%s code=%s rounds=%d", finished.State, finished.ErrorCode, rounds.Load())
	}
}
