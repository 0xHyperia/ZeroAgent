package account

import (
	"context"
	"testing"
	"time"
)

func TestBoundDesktopSelectionDeadlineIsNotExtended(t *testing.T) {
	now := time.Now()
	store := NewMemoryStore()
	service := NewService(store, nil, time.Hour, time.Hour)
	service.now = func() time.Time { return now }
	principal := &Session{ID: "desktop:synthetic", UserID: 7, SessionExpiresAt: now.Add(15 * time.Minute)}
	originalDeadline := principal.SessionExpiresAt
	lease := &SelectionLease{ID: "synthetic-lease", UserID: 7, ExpiresAt: now.Add(time.Hour)}
	if err := store.PutSelectionLease(context.Background(), lease); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		now = now.Add(4 * time.Minute)
		if _, _, err := service.ValidateBoundDesktopSelection(context.Background(), principal, lease.ID); err != nil {
			t.Fatal(err)
		}
		if !principal.SessionExpiresAt.Equal(originalDeadline) {
			t.Fatal("deadline was extended")
		}
	}
	now = originalDeadline.Add(time.Second)
	if _, _, err := service.ValidateBoundDesktopSelection(context.Background(), principal, lease.ID); err == nil {
		t.Fatal("expired bound desktop principal accepted")
	}
	wrongAccount := *principal
	wrongAccount.UserID = 8
	wrongAccount.SessionExpiresAt = now.Add(time.Minute)
	if _, _, err := service.ValidateBoundDesktopSelection(context.Background(), &wrongAccount, lease.ID); err == nil {
		t.Fatal("foreign bound desktop principal accepted")
	}
}
