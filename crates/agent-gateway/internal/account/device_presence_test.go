package account

import (
	"context"
	"testing"
	"time"
)

func TestDeviceSessionPresenceFollowsCurrentAgentSession(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(store, nil, time.Hour, time.Hour)
	now := time.Date(2026, time.July, 30, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }

	device, token, err := service.RegisterDevice(ctx, 1, RegisterDeviceInput{
		InstallationID: "presence-device",
		Name:           "Desktop",
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := service.AuthenticateAgent(device.ID, token, "", ""); err != nil {
		t.Fatal(err)
	}
	assertDeviceOnline(t, service, false)

	if err := service.ClaimDeviceSessionPresence(ctx, device.ID, "session-1"); err != nil {
		t.Fatal(err)
	}
	assertDeviceOnline(t, service, true)

	now = now.Add(30 * time.Second)
	if renewed, err := service.RenewDeviceSessionPresence(ctx, device.ID, "session-1"); err != nil || !renewed {
		t.Fatalf("renew current session: renewed=%v err=%v", renewed, err)
	}

	if err := service.ClaimDeviceSessionPresence(ctx, device.ID, "session-2"); err != nil {
		t.Fatal(err)
	}
	if renewed, err := service.RenewDeviceSessionPresence(ctx, device.ID, "session-1"); err != nil || renewed {
		t.Fatalf("stale session renewed presence: renewed=%v err=%v", renewed, err)
	}
	if released, err := service.ReleaseDeviceSessionPresence(ctx, device.ID, "session-1"); err != nil || released {
		t.Fatalf("stale session released presence: released=%v err=%v", released, err)
	}
	assertDeviceOnline(t, service, true)

	if released, err := service.ReleaseDeviceSessionPresence(ctx, device.ID, "session-2"); err != nil || !released {
		t.Fatalf("current session release: released=%v err=%v", released, err)
	}
	assertDeviceOnline(t, service, false)
}

func assertDeviceOnline(t *testing.T, service *Service, want bool) {
	t.Helper()
	environments, err := service.Environments(context.Background(), 1, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(environments) != 2 {
		t.Fatalf("environment count=%d, want cloud plus device", len(environments))
	}
	if got := environments[1].Online; got != want {
		t.Fatalf("device online=%v, want %v", got, want)
	}
}
