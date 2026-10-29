package account

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestCloudRunViewerScopesAndRelease(t *testing.T) {
	s := NewService(NewMemoryStore(), nil, time.Hour, time.Minute)
	if err := s.SetCloudRuntimeConfig(CloudRuntimeConfig{MaxEventStreams: 3, MaxEventStreamsPerAccount: 2}); err != nil {
		t.Fatal(err)
	}
	a, err := s.acquireCloudRunViewer(1)
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.acquireCloudRunViewer(1)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.acquireCloudRunViewer(1); err == nil {
		t.Fatal("account can exceed stream quota")
	}
	c, err := s.acquireCloudRunViewer(2)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.acquireCloudRunViewer(3); err == nil {
		t.Fatal("process can exceed stream quota")
	}
	a()
	a()
	d, err := s.acquireCloudRunViewer(3)
	if err != nil {
		t.Fatal("released slot was not reusable")
	}
	b()
	c()
	d()
	if s.cloudViewerCount != 0 || len(s.cloudViewers) != 0 {
		t.Fatal("disconnected account entries were retained")
	}
}

func TestCloudRunHTTPViewerLimitDoesNotCancelTaskAndAllowsReconnect(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		emitCloudDelta(w, "任务进行中")
		<-r.Context().Done()
	})
	if err := f.service.SetCloudRuntimeConfig(CloudRuntimeConfig{MaxEventStreams: 2, MaxEventStreamsPerAccount: 1}); err != nil {
		t.Fatal(err)
	}
	run, _ := f.create(t, "viewer-budget", "持续工作")
	f.wait(t, run.ID, func(run *CloudRun) bool { return run.State == CloudRunRunning })
	attach := func(cookie string) (*http.Response, error) {
		r, err := http.NewRequest(http.MethodGet, f.server.URL+"/api/web-chat/runs/"+run.ID+"/events", nil)
		if err != nil {
			return nil, err
		}
		r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: cookie})
		return f.server.Client().Do(r)
	}
	first, err := attach("synthetic-browser-cookie")
	if err != nil {
		t.Fatal(err)
	}
	defer first.Body.Close()
	if first.StatusCode != 200 {
		t.Fatal("first viewer refused")
	}
	second, err := attach("synthetic-second-viewer")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(second.Body)
	second.Body.Close()
	if second.StatusCode != 429 || !strings.Contains(string(data), "cloud_stream_limit") {
		t.Fatal("second login bypassed account viewer limit")
	}
	first.Body.Close()
	deadline := time.Now().Add(2 * time.Second)
	for {
		next, err := attach("synthetic-second-viewer")
		if err != nil {
			t.Fatal(err)
		}
		if next.StatusCode == 200 {
			next.Body.Close()
			break
		}
		next.Body.Close()
		if time.Now().After(deadline) {
			t.Fatal("disconnect did not release live viewer")
		}
		time.Sleep(10 * time.Millisecond)
	}
	current, err := f.store.GetCloudRun(context.Background(), 1, run.ID)
	if err != nil || current.State != CloudRunRunning || f.calls.Load() != 1 {
		t.Fatal("viewer disconnect changed or repeated the background task")
	}
}
