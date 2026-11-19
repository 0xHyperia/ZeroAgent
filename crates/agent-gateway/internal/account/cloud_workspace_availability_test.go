package account

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestClosedCloudWorkspacePreservesDeviceControl(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(store, nil, time.Hour, time.Hour)
	mux := http.NewServeMux()
	NewHTTPHandler(service, false).Register(mux)

	now := time.Now()
	controller := &Session{
		ID: "device-controller", UserID: 42, AccessToken: "test-access",
		AccessExpiresAt: now.Add(time.Hour), SessionExpiresAt: now.Add(time.Hour),
	}
	if err := store.PutSession(ctx, controller); err != nil {
		t.Fatal(err)
	}
	device, _, err := service.RegisterDevice(ctx, controller.UserID, RegisterDeviceInput{
		InstallationID: "test-installation", Name: "Office PC", Platform: "windows",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetDevicePresence(ctx, device.ID, true, now); err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.AddCookie(&http.Cookie{Name: SessionCookieName, Value: controller.ID})
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}

	availability := call("GET", "/api/workbench/availability", "")
	if availability.Code != http.StatusOK || availability.Header().Get("Cache-Control") != "no-store" ||
		!strings.Contains(availability.Body.String(), `"cloud_workspace_available":false`) {
		t.Fatalf("closed availability: %d %s", availability.Code, availability.Body)
	}
	var metadata struct {
		BuiltIn struct {
			Packages []cloudExtensionCard `json:"packages"`
		} `json:"built_in_extensions"`
	}
	if err := json.Unmarshal(availability.Body.Bytes(), &metadata); err != nil {
		t.Fatal(err)
	}
	for _, id := range cloudFileSkillIDs {
		if !slices.ContainsFunc(metadata.BuiltIn.Packages, func(card cloudExtensionCard) bool {
			return card.ID == id && card.Builtin
		}) {
			t.Fatalf("missing built-in card %s from closed catalog", id)
		}
	}
	for _, route := range []struct{ method, path, body string }{
		{"GET", "/api/web-chat/conversations", ""},
		{"GET", "/api/web-chat/files", ""},
		{"GET", "/api/web-chat/extensions/documents", ""},
		{"GET", "/api/web-settings", ""},
		{"POST", "/api/web-chat/extensions/device-snapshot", "{}"},
		{"POST", "/api/web-chat/schedules", "{}"},
		{"POST", "/api/web-chat/completions", "{}"},
		{"POST", "/api/execution-target/select", `{"runtime_kind":"web_chat","workspace_id":"cloud","target_fingerprint":"web_chat::cloud"}`},
	} {
		rec := call(route.method, route.path, route.body)
		if rec.Code != http.StatusForbidden || !strings.Contains(rec.Body.String(), "CLOUD_WORKSPACE_UNAVAILABLE") {
			t.Fatalf("%s %s: %d %s", route.method, route.path, rec.Code, rec.Body)
		}
	}
	oldCloudLease := &SelectionLease{
		ID: "old-cloud-lease", UserID: controller.UserID, ControllerID: controller.ID,
		RuntimeKind: RuntimeKindWebChat, WorkspaceID: CloudWorkspaceID, ExpiresAt: now.Add(time.Hour),
	}
	if err := store.PutSelectionLease(ctx, oldCloudLease); err != nil {
		t.Fatal(err)
	}
	var apiError *APIError
	if _, _, err := service.ValidateSelection(ctx, controller.ID, oldCloudLease.ID); !errors.As(err, &apiError) ||
		apiError.Reason != "CLOUD_WORKSPACE_UNAVAILABLE" {
		t.Fatalf("previous cloud lease: %v", err)
	}

	directory := call("GET", "/api/environments", "")
	if directory.Code != http.StatusOK || !strings.Contains(directory.Body.String(), device.ID) {
		t.Fatalf("device directory: %d %s", directory.Code, directory.Body)
	}
	deviceInput, err := json.Marshal(SelectTargetInput{
		RuntimeKind: RuntimeKindDeviceAgent, DeviceID: device.ID, Scope: SelectionScopeDevice,
		Target: TargetFingerprint(RuntimeKindDeviceAgent, device.ID, ""),
	})
	if err != nil {
		t.Fatal(err)
	}
	selected := call("POST", "/api/execution-target/select", string(deviceInput))
	var lease struct {
		ID string `json:"selection_lease"`
	}
	if selected.Code != http.StatusOK || json.Unmarshal(selected.Body.Bytes(), &lease) != nil || lease.ID == "" {
		t.Fatalf("device selection: %d %s", selected.Code, selected.Body)
	}
	if _, selectedLease, err := service.ValidateSelection(ctx, controller.ID, lease.ID); err != nil || selectedLease.DeviceID != device.ID {
		t.Fatalf("validate device selection: %v", err)
	}
}
