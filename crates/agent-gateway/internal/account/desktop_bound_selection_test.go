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

func TestDesktopHandoffAcceptsRefreshedTokenForSameAccount(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	service := NewService(store, nil, time.Hour, time.Hour)
	now := time.Now()
	lease := &SelectionLease{ID: "handoff-source", UserID: 7, ControllerID: "desktop:old-token", ExpiresAt: now.Add(time.Hour)}
	if err := store.PutSelectionLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	refreshed := &Session{ID: "desktop:new-token", UserID: 7, AccessToken: "synthetic-refreshed", SessionExpiresAt: now.Add(15 * time.Minute)}
	code, err := service.CreateDesktopHandoff(ctx, refreshed, lease.ID)
	if err != nil {
		t.Fatalf("same-account token refresh invalidated an unexpired selection: %v", err)
	}
	session, _, err := service.ConsumeDesktopHandoff(ctx, code)
	if err != nil || session.AccessToken != refreshed.AccessToken || session.UserID != refreshed.UserID {
		t.Fatalf("handoff did not use the refreshed principal: err=%v", err)
	}
	stored, err := store.GetSelectionLease(ctx, lease.ID)
	if err != nil || !stored.ExpiresAt.Equal(lease.ExpiresAt) {
		t.Fatal("handoff changed the original selection deadline")
	}
	for _, principal := range []*Session{
		nil,
		{ID: "desktop:foreign", UserID: 8, SessionExpiresAt: now.Add(time.Minute)},
		{ID: "browser", UserID: 7, SessionExpiresAt: now.Add(time.Minute)},
		{ID: "desktop:expired", UserID: 7, SessionExpiresAt: now.Add(-time.Minute)},
	} {
		if _, err := service.CreateDesktopHandoff(ctx, principal, lease.ID); err == nil {
			t.Fatal("handoff accepted an unauthenticated, foreign or expired principal")
		}
	}
	lease.ExpiresAt = now.Add(-time.Minute)
	if err := store.PutSelectionLease(ctx, lease); err != nil {
		t.Fatal(err)
	}
	if _, err := service.CreateDesktopHandoff(ctx, refreshed, lease.ID); err == nil {
		t.Fatal("handoff accepted an expired selection")
	}
}
