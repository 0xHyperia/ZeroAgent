package account

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func runCloudModelLimitsContract(t *testing.T, fixture cloudRunTestFixture) {
	t.Helper()
	ctx := context.Background()
	store := fixture.store.(cloudModelLimitsStore)
	if _, err := store.GetCloudModelLimits(ctx, 91, 41, "test/model"); !errors.Is(err, ErrNotFound) {
		t.Fatal("missing preference must preserve the caller's existing choice")
	}
	custom := CloudModelLimitsUpdate{Mode: "custom", ContextWindow: 32000, MaxOutputTokens: 8000}
	var winners atomic.Int64
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := store.SetCloudModelLimits(ctx, 91, 41, "test/model", custom)
			if err == nil {
				winners.Add(1)
			} else if !errors.Is(err, errCloudModelLimitsConflict) {
				t.Errorf("unexpected concurrent save error: %v", err)
			}
		}()
	}
	wg.Wait()
	if winners.Load() != 1 {
		t.Fatal("concurrent first saves must have exactly one winner")
	}
	item, err := store.GetCloudModelLimits(ctx, 91, 41, "test/model")
	if err != nil || item.Mode != "custom" || item.ContextWindow != 32000 || item.Version != 1 {
		t.Fatal("cross-session preference read lost custom limits")
	}
	platform := CloudModelLimitsUpdate{ExpectedVersion: item.Version, Mode: "platform", ContextWindow: item.ContextWindow, MaxOutputTokens: item.MaxOutputTokens}
	item, err = store.SetCloudModelLimits(ctx, 91, 41, "test/model", platform)
	if err != nil || item.Version != 2 || item.Mode != "platform" || item.ContextWindow != 32000 {
		t.Fatal("platform mode must retain explicit values for switching back")
	}
	if _, err := store.SetCloudModelLimits(ctx, 91, 41, "test/model", platform); !errors.Is(err, errCloudModelLimitsConflict) {
		t.Fatal("stale other-device save overwrote the winner")
	}
	for _, key := range []cloudModelLimitKey{{92, 41, "test/model"}, {91, 42, "test/model"}, {91, 41, "other/model"}} {
		if _, err := store.GetCloudModelLimits(ctx, key.UserID, key.ProviderKeyID, key.Model); !errors.Is(err, ErrNotFound) {
			t.Fatal("preference crossed account, platform key, or model scope")
		}
	}
	// General reasoning/model selection writes cannot reset this independent row.
	if err := fixture.store.PutWebSettings(ctx, 91, WebSettings{Model: "test/model", ReasoningEffort: "high", ProviderKeyID: 41}); err != nil {
		t.Fatal(err)
	}
	item, err = store.GetCloudModelLimits(ctx, 91, 41, "test/model")
	if err != nil || item.Version != 2 || item.Mode != "platform" {
		t.Fatal("reasoning settings update replaced model limits")
	}
	for _, bad := range []CloudModelLimitsUpdate{
		{Mode: "custom"}, {Mode: "custom", ContextWindow: 1024, MaxOutputTokens: 1024},
		{Mode: "platform", ContextWindow: 32000}, {Mode: "custom", ContextWindow: 32000, MaxOutputTokens: -1},
		{Mode: "other"}, {Mode: "platform", ExpectedVersion: -1}, {Mode: "platform", ExpectedVersion: 1 << 53},
	} {
		if _, err := store.SetCloudModelLimits(ctx, 91, 41, "test/model", bad); err == nil {
			t.Fatal("invalid preference was accepted")
		}
	}
	// The account bound covers distinct model IDs and cannot be bypassed by
	// independent first saves. Existing entries remain editable at the bound.
	for i := 1; i < cloudModelLimitsMaxSettings; i++ {
		if _, err := store.SetCloudModelLimits(ctx, 91, 41, fmt.Sprintf("bounded-%d", i), CloudModelLimitsUpdate{Mode: "platform"}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.SetCloudModelLimits(ctx, 91, 41, "overflow", CloudModelLimitsUpdate{Mode: "platform"}); !errors.Is(err, ErrCloudProjectQuota) {
		t.Fatal("unbounded model preferences")
	}
	if _, err := store.SetCloudModelLimits(ctx, 91, 41, "test/model", CloudModelLimitsUpdate{ExpectedVersion: 2, Mode: "custom", ContextWindow: 64000, MaxOutputTokens: 16000}); err != nil {
		t.Fatal("account bound prevented an existing preference update")
	}
}

func TestCloudModelLimitsMemoryContract(t *testing.T) {
	runCloudModelLimitsContract(t, cloudRunMemoryFixture(t))
}
func TestCloudModelLimitsPostgresContract(t *testing.T) {
	f := cloudRunPostgresFixture(t)
	if _, err := f.store.(*PersistentStore).db.Exec(CloudModelLimitsSchema + `CREATE TABLE zerobox_web_settings(user_id BIGINT PRIMARY KEY, settings JSONB NOT NULL,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`); err != nil {
		t.Fatal(err)
	}
	runCloudModelLimitsContract(t, f)
}

func TestCloudModelLimitsHTTP(t *testing.T) {
	f := newCloudHTTPFixture(t, func(http.ResponseWriter, *http.Request) { t.Error("preference must not invoke a model") })
	path := "/api/web-chat/model-limits?provider_key_id=41&model=test%2Fmodel"
	status, data := f.request(t, http.MethodGet, path, "synthetic-browser-cookie", "")
	if status != 200 || !strings.Contains(data, `"setting":null`) {
		t.Fatalf("missing setting status=%d body=%s", status, data)
	}
	status, data = f.request(t, http.MethodPut, path, "synthetic-browser-cookie", `{"expected_version":0,"mode":"custom","context_window":32000,"max_output_tokens":8000}`)
	if status != 200 {
		t.Fatalf("save status=%d body=%s", status, data)
	}
	var result struct {
		Setting *CloudModelLimits `json:"setting"`
	}
	status, data = f.request(t, http.MethodGet, path, "synthetic-second-viewer", "")
	if status != 200 || json.Unmarshal([]byte(data), &result) != nil || result.Setting == nil || result.Setting.Version != 1 || result.Setting.ContextWindow != 32000 {
		t.Fatal("another browser could not read saved preference")
	}
	if strings.Contains(data, "synthetic-model-key") || strings.Contains(data, "synthetic-access-token") {
		t.Fatal("preference exposed a credential")
	}
	if status, _ := f.request(t, http.MethodPut, path, "synthetic-browser-cookie", `{"expected_version":0,"mode":"platform","context_window":0,"max_output_tokens":0}`); status != 409 {
		t.Fatal("stale first-save version accepted")
	}
	if status, _ := f.request(t, http.MethodGet, strings.Replace(path, "=41", "=999", 1), "synthetic-browser-cookie", ""); status == 200 {
		t.Fatal("foreign platform key was accepted")
	}
	for _, body := range []string{
		`{"mode":"custom","context_window":32000,"max_output_tokens":0}`,
		`{"mode":"platform","url":"https://untrusted.invalid"}`,
	} {
		if status, _ := f.request(t, http.MethodPut, path, "synthetic-browser-cookie", body); status != 400 {
			t.Fatal("unsupported setting payload accepted")
		}
	}
	if status, _ := f.request(t, http.MethodGet, path, "", ""); status != 401 {
		t.Fatal("unauthenticated preference read accepted")
	}
	if f.calls.Load() != 0 {
		t.Fatal("model preference executed a model")
	}
}
