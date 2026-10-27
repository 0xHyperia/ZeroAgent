package account

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestDeviceNameSurvivesRegistrationAndReconnect(t *testing.T) {
	store := NewMemoryStore()
	testDeviceNameSurvivesRegistrationAndReconnect(t, store, func() Store { return store })
}

func testDeviceNameSurvivesRegistrationAndReconnect(t *testing.T, store Store, reopen func() Store) {
	t.Helper()
	ctx := context.Background()
	service := NewService(store, nil, time.Hour, time.Hour)
	installationID := uuid.NewString()
	device, token, err := service.RegisterDevice(ctx, 1, RegisterDeviceInput{
		InstallationID: installationID, Name: "WORKSTATION", Platform: "windows", Version: "1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if device.Name != "WORKSTATION" {
		t.Fatalf("initial name=%q, want hostname", device.Name)
	}
	if _, err := service.RenameDevice(ctx, 1, device.ID, "我的工作电脑"); err != nil {
		t.Fatal(err)
	}

	// Recreate the service/store connection as on restart. Some clients send an
	// empty name, while others resend the original hostname or a fallback.
	for _, startupName := range []string{"", "WORKSTATION", "ZeroAgent device"} {
		service = NewService(reopen(), nil, time.Hour, time.Hour)
		registered, nextToken, err := service.RegisterDevice(ctx, 1, RegisterDeviceInput{
			InstallationID: installationID, Name: startupName, Platform: "windows", Version: "2",
			AgentID: device.ID, AgentToken: token,
		})
		if err != nil {
			t.Fatal(err)
		}
		if registered.ID != device.ID || registered.Name != "我的工作电脑" || nextToken != "" {
			t.Fatalf("restart with name %q changed device identity/name: id=%q name=%q newToken=%v", startupName, registered.ID, registered.Name, nextToken != "")
		}
		if registered.Version != "2" {
			t.Fatalf("restart did not update version: %q", registered.Version)
		}
		if _, _, err := service.AuthenticateAgent(device.ID, token, "", ""); err != nil {
			t.Fatal(err)
		}
		if err := service.UpdateAgentWorkspaces(ctx, device.ID, []Workspace{{ID: "project", Name: "Project", Path: "/project"}}); err != nil {
			t.Fatal(err)
		}
		if err := service.ClaimDeviceSessionPresence(ctx, device.ID, "restarted-session"); err != nil {
			t.Fatal(err)
		}
		for _, desktop := range []bool{false, true} {
			environments, err := service.Environments(ctx, 1, desktop, device.ID)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, environment := range environments {
				if environment.DeviceID != device.ID {
					continue
				}
				found = true
				if environment.DeviceName != "我的工作电脑" || !environment.Online {
					t.Fatalf("desktop=%v lost name/presence: %#v", desktop, environment)
				}
			}
			if !found {
				t.Fatalf("desktop=%v lost registered device", desktop)
			}
		}
	}
	if _, err := service.RenameDevice(ctx, 2, device.ID, "foreign name"); err == nil {
		t.Fatal("another account renamed the device")
	}
	if _, err := service.RenameDevice(ctx, 1, device.ID, "第二次改名"); err != nil {
		t.Fatal(err)
	}
	if err := service.RevokeDevice(ctx, 1, device.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := service.RenameDevice(ctx, 1, device.ID, "revoked name"); err == nil {
		t.Fatal("revoked device was renamed")
	}
}

type pausedWorkspaceReadStore struct {
	Store
	read    chan struct{}
	proceed chan struct{}
}

func (s *pausedWorkspaceReadStore) GetDeviceByID(ctx context.Context, id string) (*Device, error) {
	device, err := s.Store.GetDeviceByID(ctx, id)
	close(s.read)
	select {
	case <-s.proceed:
		return device, err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func TestConcurrentWorkspaceSyncDoesNotUndoDeviceRename(t *testing.T) {
	testConcurrentWorkspaceSyncDoesNotUndoDeviceRename(t, NewMemoryStore())
}

func testConcurrentWorkspaceSyncDoesNotUndoDeviceRename(t *testing.T, store Store) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	service := NewService(store, nil, time.Hour, time.Hour)
	device, _, err := service.RegisterDevice(ctx, 1, RegisterDeviceInput{
		InstallationID: uuid.NewString(), Name: "WORKSTATION",
	})
	if err != nil {
		t.Fatal(err)
	}
	paused := &pausedWorkspaceReadStore{Store: store, read: make(chan struct{}), proceed: make(chan struct{})}
	syncService := NewService(paused, nil, time.Hour, time.Hour)
	result := make(chan error, 1)
	go func() {
		result <- syncService.UpdateAgentWorkspaces(ctx, device.ID, []Workspace{{ID: "project", Name: "Project", Path: "/project"}})
	}()
	select {
	case <-paused.read:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	_, renameErr := service.RenameDevice(ctx, 1, device.ID, "Renamed on another client")
	close(paused.proceed)
	if renameErr != nil {
		t.Fatal(renameErr)
	}
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetDevice(ctx, 1, device.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Name != "Renamed on another client" || len(stored.Workspaces) != 1 {
		t.Fatalf("stale startup sync undid rename or lost workspaces: name=%q workspaces=%#v", stored.Name, stored.Workspaces)
	}
}

func TestDeviceNameWritesAreScoped(t *testing.T) {
	testDeviceNameWritesAreScoped(t, NewMemoryStore())
}

func testDeviceNameWritesAreScoped(t *testing.T, store Store) {
	t.Helper()
	ctx := context.Background()
	service := NewService(store, nil, time.Hour, time.Hour)
	device, _, err := service.RegisterDevice(ctx, 1, RegisterDeviceInput{InstallationID: uuid.NewString(), Name: "PC"})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.SetDeviceName(ctx, 2, device.ID, "foreign"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("foreign rename error=%v, want not found", err)
	}
	if err := store.SetDeviceName(ctx, 1, device.ID, "New name"); err != nil {
		t.Fatal(err)
	}
	stored, err := store.GetDevice(ctx, 1, device.ID)
	if err != nil || stored.Name != "New name" {
		t.Fatalf("owner rename was not saved: device=%#v err=%v", stored, err)
	}
	if err := store.DeleteDevice(ctx, 1, device.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.SetDeviceName(ctx, 1, device.ID, "revoked"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("revoked rename error=%v, want not found", err)
	}
}

// This opt-in test must use disposable PostgreSQL/Redis instances, never user
// account storage. It exercises real SQL conflict handling and connection reopen.
func TestPersistentDeviceNameSurvivesRestart(t *testing.T) {
	databaseURL := os.Getenv("ZEROAGENT_TEST_DATABASE_URL")
	redisURL := os.Getenv("ZEROAGENT_TEST_REDIS_URL")
	if databaseURL == "" || redisURL == "" {
		t.Skip("requires disposable ZEROAGENT_TEST_DATABASE_URL and ZEROAGENT_TEST_REDIS_URL")
	}
	reopen := func(t *testing.T) Store {
		t.Helper()
		store, err := OpenPersistentStore(context.Background(), databaseURL, redisURL)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if err := store.Close(); err != nil {
				t.Error(err)
			}
		})
		return store
	}
	t.Run("registration-restart", func(t *testing.T) {
		testDeviceNameSurvivesRegistrationAndReconnect(t, reopen(t), func() Store { return reopen(t) })
	})
	t.Run("concurrent-startup-sync", func(t *testing.T) {
		testConcurrentWorkspaceSyncDoesNotUndoDeviceRename(t, reopen(t))
	})
	t.Run("scoped-name-writes", func(t *testing.T) {
		testDeviceNameWritesAreScoped(t, reopen(t))
	})
}
