package pbws

import (
	"context"

	"github.com/liveagent/agent-gateway/internal/account"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

// controllerSelectionCurrent revalidates the original account and selection at dispatch.
// A successfully authenticated socket does not outlive logout, lease expiry, or device removal.
func (s *Server) controllerSelectionCurrent(controllerSessionID string, hello *gatewayv2.ClientHello, session *account.Session, lease *account.SelectionLease) func() bool {
	leaseID := hello.GetSelectionLease()
	desktop := hello.GetToken() != ""
	// Copy only the verified principal and fixed deadline, never retain its bearer.
	principal := &account.Session{ID: session.ID, UserID: session.UserID, SessionExpiresAt: session.SessionExpiresAt}
	userID, agentID, workspaceID, scope := session.UserID, lease.DeviceID, lease.WorkspaceID, lease.EffectiveScope()
	return func() bool {
		ctx, cancel := context.WithTimeout(context.Background(), s.requestTimeout())
		defer cancel()
		var currentSession *account.Session
		var currentLease *account.SelectionLease
		var err error
		if desktop {
			currentSession, currentLease, err = s.accounts.ValidateBoundDesktopSelection(ctx, principal, leaseID)
		} else {
			currentSession, currentLease, err = s.accounts.ValidateSelection(ctx, controllerSessionID, leaseID)
		}
		if err != nil || currentSession.UserID != userID || currentLease.RuntimeKind != account.RuntimeKindDeviceAgent || currentLease.DeviceID != agentID || currentLease.WorkspaceID != workspaceID || currentLease.EffectiveScope() != scope {
			return false
		}
		device, err := s.accounts.Device(ctx, userID, agentID)
		if err != nil {
			return false
		}
		if scope == account.SelectionScopeWorkspace {
			for _, workspace := range device.Workspaces {
				if workspace.ID == workspaceID {
					return true
				}
			}
			return false
		}
		return true
	}
}
