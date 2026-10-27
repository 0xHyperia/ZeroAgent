package account

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

type Service struct {
	store             Store
	usa               *USAClient
	sessionTTL        time.Duration
	selectionLeaseTTL time.Duration
	now               func() time.Time
	deviceRevoker     func(userID int64, deviceID string)
	webKeyMu          sync.Mutex
	webKeys           map[int64]string
	credentialMu      sync.RWMutex
	credentialEpochs  map[string]uint64
}

func (s *Service) SetDeviceRevoker(revoker func(userID int64, deviceID string)) {
	s.deviceRevoker = revoker
}

func NewService(store Store, usa *USAClient, sessionTTL, selectionLeaseTTL time.Duration) *Service {
	if sessionTTL <= 0 {
		sessionTTL = 30 * 24 * time.Hour
	}
	if selectionLeaseTTL <= 0 {
		selectionLeaseTTL = 8 * time.Hour
	}
	return &Service{store: store, usa: usa, sessionTTL: sessionTTL, selectionLeaseTTL: selectionLeaseTTL, now: time.Now, webKeys: make(map[int64]string), credentialEpochs: make(map[string]uint64)}
}

func (s *Service) Login(ctx context.Context, email, password string) (*LoginResult, *Session, error) {
	result, err := s.usa.Login(ctx, strings.TrimSpace(email), password)
	if err != nil || result.Requires2FA {
		return result, nil, err
	}
	session, err := s.createSession(ctx, result)
	return result, session, err
}

func (s *Service) Login2FA(ctx context.Context, tempToken, code string) (*LoginResult, *Session, error) {
	result, err := s.usa.Login2FA(ctx, strings.TrimSpace(tempToken), strings.TrimSpace(code))
	if err != nil {
		return nil, nil, err
	}
	session, err := s.createSession(ctx, result)
	return result, session, err
}

func (s *Service) PublicSettings(ctx context.Context) (json.RawMessage, error) {
	return s.usa.PublicSettings(ctx)
}

func (s *Service) SendVerifyCode(ctx context.Context, email string) (json.RawMessage, error) {
	return s.usa.SendVerifyCode(ctx, email)
}

func (s *Service) Register(ctx context.Context, email, password, verifyCode, invitationCode string) (*LoginResult, *Session, error) {
	result, err := s.usa.Register(ctx, email, password, verifyCode, invitationCode)
	if err != nil {
		return nil, nil, err
	}
	session, err := s.createSession(ctx, result)
	return result, session, err
}

func (s *Service) Session(ctx context.Context, id string) (*Session, error) {
	session, err := s.store.GetSession(ctx, strings.TrimSpace(id))
	if err != nil {
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "account session is missing or expired"}
	}
	if session.AccessExpiresAt.After(s.now().Add(30 * time.Second)) {
		return session, nil
	}
	if session.RefreshToken == "" {
		_ = s.store.DeleteSession(ctx, session.ID)
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "account session expired"}
	}
	if session.IsOAuth() {
		refreshed, err := s.usa.RefreshApp(ctx, session.OAuthClientID, session.RefreshToken)
		if err != nil {
			_ = s.store.DeleteSession(ctx, session.ID)
			return nil, err
		}
		session.AccessToken = refreshed.AccessToken
		session.RefreshToken = firstNonEmpty(refreshed.RefreshToken, session.RefreshToken)
		session.AccessExpiresAt = s.accessExpiry(refreshed.ExpiresIn)
		if err := s.store.PutSession(ctx, session); err != nil {
			return nil, err
		}
		return session, nil
	}
	refreshed, err := s.usa.Refresh(ctx, session.RefreshToken)
	if err != nil {
		_ = s.store.DeleteSession(ctx, session.ID)
		return nil, err
	}
	session.AccessToken = refreshed.AccessToken
	session.RefreshToken = firstNonEmpty(refreshed.RefreshToken, session.RefreshToken)
	session.AccessExpiresAt = s.accessExpiry(refreshed.ExpiresIn)
	if len(refreshed.User) > 0 {
		session.User = refreshed.User
	}
	if err := s.store.PutSession(ctx, session); err != nil {
		return nil, err
	}
	return session, nil
}

func (s *Service) Refresh(ctx context.Context, id string) (*Session, error) {
	session, err := s.store.GetSession(ctx, id)
	if err != nil || session.RefreshToken == "" {
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "account session cannot be refreshed"}
	}
	if session.IsOAuth() {
		refreshed, err := s.usa.RefreshApp(ctx, session.OAuthClientID, session.RefreshToken)
		if err != nil {
			return nil, err
		}
		session.AccessToken = refreshed.AccessToken
		session.RefreshToken = firstNonEmpty(refreshed.RefreshToken, session.RefreshToken)
		session.AccessExpiresAt = s.accessExpiry(refreshed.ExpiresIn)
		return session, s.store.PutSession(ctx, session)
	}
	refreshed, err := s.usa.Refresh(ctx, session.RefreshToken)
	if err != nil {
		return nil, err
	}
	session.AccessToken = refreshed.AccessToken
	session.RefreshToken = firstNonEmpty(refreshed.RefreshToken, session.RefreshToken)
	session.AccessExpiresAt = s.accessExpiry(refreshed.ExpiresIn)
	if len(refreshed.User) > 0 {
		session.User = refreshed.User
	}
	return session, s.store.PutSession(ctx, session)
}

func (s *Service) Logout(ctx context.Context, id string) error {
	session, err := s.store.GetSession(ctx, id)
	if err == nil && session.RefreshToken != "" {
		if session.IsOAuth() {
			_ = s.usa.RevokeApp(ctx, session.RefreshToken, "refresh_token")
		} else {
			_ = s.usa.Logout(ctx, session.RefreshToken)
		}
	}
	return s.store.DeleteSession(ctx, id)
}

func (s *Service) RefreshUser(ctx context.Context, session *Session) (json.RawMessage, error) {
	var user json.RawMessage
	var err error
	if session.IsOAuth() {
		user, err = s.usa.AppMe(ctx, session.AccessToken)
		user = markOAuthUser(user)
	} else {
		user, err = s.usa.Me(ctx, session.AccessToken)
	}
	if err != nil {
		return nil, err
	}
	session.User = user
	if err := s.store.PutSession(ctx, session); err != nil {
		return nil, err
	}
	return user, nil
}

type RegisterDeviceInput struct {
	InstallationID   string `json:"installation_id"`
	Name             string `json:"name"`
	Platform         string `json:"platform"`
	Version          string `json:"version"`
	DeviceID         string `json:"device_id,omitempty"`
	DeviceCredential string `json:"device_credential,omitempty"`
	AgentID          string `json:"agent_id,omitempty"`
	AgentToken       string `json:"agent_token,omitempty"`
}

func (s *Service) RegisterDevice(ctx context.Context, userID int64, input RegisterDeviceInput) (*Device, string, error) {
	input.InstallationID = strings.TrimSpace(input.InstallationID)
	if input.InstallationID == "" || len(input.InstallationID) > 200 {
		return nil, "", &APIError{Status: http.StatusBadRequest, Message: "installation_id is required"}
	}
	now := s.now().UTC()
	existing, lookupErr := s.store.GetDeviceByInstallation(ctx, userID, input.InstallationID)
	if lookupErr == nil {
		providedID := firstNonEmpty(input.AgentID, input.DeviceID)
		providedToken := firstNonEmpty(input.AgentToken, input.DeviceCredential)
		if canonicalAgentID(providedID) != existing.ID || !VerifyDeviceCredential(existing, providedToken) {
			return nil, "", &APIError{Status: http.StatusUnauthorized, Message: "existing device credential is required"}
		}
		// Startup metadata must not undo a name changed on another client.
		// The registration name is only used when creating a new device.
		existing.Platform = strings.TrimSpace(input.Platform)
		existing.Version = strings.TrimSpace(input.Version)
		existing.LastSeenAt = now
		if err := s.store.UpsertDevice(ctx, existing); err != nil {
			return nil, "", err
		}
		current, err := s.store.GetDevice(ctx, userID, existing.ID)
		return current, "", err
	}
	if !errors.Is(lookupErr, ErrNotFound) {
		return nil, "", lookupErr
	}
	credential, err := randomToken(32)
	if err != nil {
		return nil, "", err
	}
	agentID := canonicalAgentID(firstNonEmpty(input.AgentID, input.DeviceID))
	if firstNonEmpty(input.AgentID, input.DeviceID) != "" && agentID == "" {
		return nil, "", &APIError{Status: http.StatusBadRequest, Message: "agent_id must be agent-UUIDv4"}
	}
	if agentID == "" {
		agentID = "agent-" + uuid.NewString()
	}
	credential = "agt_" + credential
	device := &Device{
		ID: agentID, AgentID: agentID, UserID: userID, InstallationID: input.InstallationID,
		Name: normalizeDeviceName(input.Name, "ZeroAgent device"), Platform: strings.TrimSpace(input.Platform),
		Version: strings.TrimSpace(input.Version), CredentialHash: hashToken(credential),
		CreatedAt: now, TokenIssuedAt: now, LastSeenAt: now, Online: false,
	}
	if err := s.store.UpsertDevice(ctx, device); err != nil {
		return nil, "", err
	}
	return device, credential, nil
}

func (s *Service) RenameDevice(ctx context.Context, userID int64, deviceID, name string) (*Device, error) {
	device, err := s.store.GetDevice(ctx, userID, deviceID)
	if err != nil {
		return nil, &APIError{Status: http.StatusNotFound, Message: "device not found"}
	}
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 100 {
		return nil, &APIError{Status: http.StatusBadRequest, Message: "device name must be 1-100 characters"}
	}
	if err := s.store.SetDeviceName(ctx, userID, device.ID, name); err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, &APIError{Status: http.StatusNotFound, Message: "device not found"}
		}
		return nil, err
	}
	device.Name = name
	return device, nil
}

func (s *Service) RevokeDevice(ctx context.Context, userID int64, deviceID string) error {
	if err := s.store.DeleteDevice(ctx, userID, deviceID); err != nil {
		return &APIError{Status: http.StatusNotFound, Message: "device not found"}
	}
	if s.deviceRevoker != nil {
		s.deviceRevoker(userID, deviceID)
	}
	s.bumpCredentialEpoch(canonicalAgentID(deviceID))
	return nil
}

var ErrUnauthorizedAgent = errors.New("unauthorized agent credential")

func (s *Service) AuthenticateAgent(agentID, token, legacyDeviceID, legacyCredential string) (string, uint64, error) {
	canonical := canonicalAgentID(firstNonEmpty(agentID, legacyDeviceID))
	credential := firstNonEmpty(token, legacyCredential)
	device, err := s.store.GetDeviceByID(context.Background(), canonical)
	if err != nil || !VerifyDeviceCredential(device, credential) {
		return "", 0, ErrUnauthorizedAgent
	}
	s.credentialMu.RLock()
	epoch := s.credentialEpochs[device.ID]
	s.credentialMu.RUnlock()
	return device.ID, epoch, nil
}

// UpdateAgentWorkspaces replaces the device workspace directory with the
// authenticated Agent's complete ClientHello snapshot.
func (s *Service) UpdateAgentWorkspaces(ctx context.Context, agentID string, input []Workspace) error {
	workspaces, err := normalizeWorkspaces(input)
	if err != nil {
		return err
	}
	device, err := s.store.GetDeviceByID(ctx, canonicalAgentID(agentID))
	if err != nil {
		return err
	}
	device.Workspaces = workspaces
	device.LastSeenAt = s.now().UTC()
	return s.store.UpsertDevice(ctx, device)
}

func (s *Service) AgentWorkspaces(ctx context.Context, agentID string) ([]Workspace, error) {
	device, err := s.store.GetDeviceByID(ctx, canonicalAgentID(agentID))
	if err != nil {
		return nil, err
	}
	return append([]Workspace(nil), device.Workspaces...), nil
}

func (s *Service) AuthenticationCurrent(agentID string, epoch uint64) bool {
	s.credentialMu.RLock()
	defer s.credentialMu.RUnlock()
	return s.credentialEpochs[canonicalAgentID(agentID)] == epoch
}

func (s *Service) RotateDeviceToken(ctx context.Context, userID int64, deviceID string) (*Device, string, error) {
	device, err := s.store.GetDevice(ctx, userID, canonicalAgentID(deviceID))
	if err != nil {
		return nil, "", &APIError{Status: http.StatusNotFound, Message: "device not found"}
	}
	token, err := randomToken(32)
	if err != nil {
		return nil, "", err
	}
	token = "agt_" + token
	device.CredentialHash = hashToken(token)
	device.TokenIssuedAt = s.now().UTC()
	if err := s.store.UpsertDevice(ctx, device); err != nil {
		return nil, "", err
	}
	s.bumpCredentialEpoch(device.ID)
	if s.deviceRevoker != nil {
		s.deviceRevoker(userID, device.ID)
	}
	return device, token, nil
}

func (s *Service) bumpCredentialEpoch(agentID string) {
	s.credentialMu.Lock()
	s.credentialEpochs[agentID]++
	s.credentialMu.Unlock()
}

func (s *Service) AuthenticateDevice(ctx context.Context, deviceID, credential string) (*Device, error) {
	device, err := s.store.GetDeviceByID(ctx, canonicalAgentID(deviceID))
	if err != nil || !VerifyDeviceCredential(device, credential) {
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "invalid device credential"}
	}
	if err := s.store.SetDevicePresence(ctx, device.ID, true, s.now().UTC()); err != nil {
		return nil, err
	}
	device.Online = true
	device.LastSeenAt = s.now().UTC()
	return device, nil
}

func canonicalAgentID(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "agent-") {
		if parsed, err := uuid.Parse(strings.TrimPrefix(value, "agent-")); err == nil && parsed.Version() == 4 {
			return "agent-" + parsed.String()
		}
		return ""
	}
	if parsed, err := uuid.Parse(value); err == nil && parsed.Version() == 4 {
		return "agent-" + parsed.String()
	}
	return ""
}

func (s *Service) TouchDevice(ctx context.Context, deviceID string) error {
	return s.store.SetDevicePresence(ctx, deviceID, true, s.now().UTC())
}

func (s *Service) MarkDeviceOffline(ctx context.Context, deviceID string) error {
	return s.store.SetDevicePresence(ctx, deviceID, false, s.now().UTC())
}

func (s *Service) ClaimDeviceSessionPresence(
	ctx context.Context,
	deviceID string,
	sessionID string,
) error {
	return s.store.ClaimDeviceSessionPresence(ctx, deviceID, sessionID, s.now().UTC())
}

func (s *Service) RenewDeviceSessionPresence(
	ctx context.Context,
	deviceID string,
	sessionID string,
) (bool, error) {
	return s.store.RenewDeviceSessionPresence(ctx, deviceID, sessionID, s.now().UTC())
}

func (s *Service) ReleaseDeviceSessionPresence(
	ctx context.Context,
	deviceID string,
	sessionID string,
) (bool, error) {
	return s.store.ReleaseDeviceSessionPresence(ctx, deviceID, sessionID, s.now().UTC())
}

func (s *Service) ValidateSelection(ctx context.Context, controllerSessionID, leaseID string) (*Session, *SelectionLease, error) {
	session, err := s.Session(ctx, controllerSessionID)
	if err != nil {
		return nil, nil, err
	}
	lease, err := s.store.GetSelectionLease(ctx, strings.TrimSpace(leaseID))
	if err != nil || lease.UserID != session.UserID || lease.ControllerID != session.ID {
		return nil, nil, &APIError{Status: http.StatusUnauthorized, Message: "selection lease is invalid or expired"}
	}
	if lease.AgentID == "" {
		lease.AgentID = canonicalAgentID(lease.DeviceID)
		lease.DeviceID = lease.AgentID
	}
	return session, lease, nil
}

func (s *Service) DesktopSession(ctx context.Context, accessToken string) (*Session, error) {
	accessToken = strings.TrimSpace(accessToken)
	if accessToken == "" {
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "USA-Zero access token is required"}
	}
	user, err := s.usa.Me(ctx, accessToken)
	authKind := AuthKindPassword
	clientID := ""
	if err != nil {
		user, err = s.usa.AppMe(ctx, accessToken)
		authKind = AuthKindOAuth
		clientID = "zeroagent-desktop"
	}
	if err != nil {
		return nil, err
	}
	var identity struct {
		ID int64 `json:"id"`
	}
	if json.Unmarshal(user, &identity) != nil || identity.ID <= 0 {
		return nil, &APIError{Status: http.StatusUnauthorized, Message: "USA-Zero identity is invalid"}
	}
	return &Session{
		ID: "desktop:" + hashToken(accessToken), UserID: identity.ID, User: user,
		AccessToken: accessToken, AccessExpiresAt: s.now().Add(15 * time.Minute),
		SessionExpiresAt: s.now().Add(15 * time.Minute), AuthKind: authKind, OAuthClientID: clientID,
	}, nil
}

func (s *Service) ValidateDesktopSelection(ctx context.Context, accessToken, leaseID string) (*Session, *SelectionLease, error) {
	session, err := s.DesktopSession(ctx, accessToken)
	if err != nil {
		return nil, nil, err
	}
	return s.ValidateBoundDesktopSelection(ctx, session, leaseID)
}

// ValidateBoundDesktopSelection checks a principal authenticated at this socket hello.
// Its original deadline is fixed; dispatch does not extend it or call USA-Zero per frame.
func (s *Service) ValidateBoundDesktopSelection(ctx context.Context, session *Session, leaseID string) (*Session, *SelectionLease, error) {
	if session == nil || session.UserID <= 0 || !strings.HasPrefix(session.ID, "desktop:") || !session.SessionExpiresAt.After(s.now()) {
		return nil, nil, &APIError{Status: http.StatusUnauthorized, Message: "desktop session is missing or expired"}
	}
	lease, err := s.store.GetSelectionLease(ctx, strings.TrimSpace(leaseID))
	// DesktopSession IDs intentionally include the access-token hash, so they
	// change when USA-Zero rotates an access token. A desktop selection remains
	// valid for its TTL as long as the replacement token still authenticates the
	// same account; requiring ControllerID here incorrectly invalidates it.
	if err != nil || lease.UserID != session.UserID {
		return nil, nil, &APIError{Status: http.StatusUnauthorized, Message: "selection lease is invalid or expired"}
	}
	return session, lease, nil
}

func (s *Service) CreateDesktopHandoff(ctx context.Context, desktop *Session, selectionLeaseID string) (string, error) {
	// Access-token refresh changes the desktop controller ID. Match the same
	// verified account and fixed deadlines, as the WebSocket selection does.
	_, lease, err := s.ValidateBoundDesktopSelection(ctx, desktop, selectionLeaseID)
	if err != nil {
		return "", err
	}
	code, err := randomToken(32)
	if err != nil {
		return "", err
	}
	handoff := &DesktopHandoff{
		UserID: desktop.UserID, User: desktop.User, AccessToken: desktop.AccessToken,
		SourceSelection: *lease, ExpiresAt: s.now().UTC().Add(60 * time.Second),
	}
	if err := s.store.PutDesktopHandoff(ctx, hashToken(code), handoff); err != nil {
		return "", err
	}
	return code, nil
}

func (s *Service) ConsumeDesktopHandoff(ctx context.Context, code string) (*Session, *SelectionLease, error) {
	handoff, err := s.store.ConsumeDesktopHandoff(ctx, hashToken(strings.TrimSpace(code)))
	if err != nil || !handoff.ExpiresAt.After(s.now()) {
		return nil, nil, &APIError{Status: http.StatusUnauthorized, Message: "desktop handoff is invalid or expired"}
	}
	now := s.now().UTC()
	session := &Session{
		ID: uuid.NewString(), UserID: handoff.UserID, User: handoff.User, AccessToken: handoff.AccessToken,
		AccessExpiresAt: now.Add(12 * time.Hour), SessionExpiresAt: now.Add(12 * time.Hour),
	}
	if err := s.store.PutSession(ctx, session); err != nil {
		return nil, nil, err
	}
	lease := handoff.SourceSelection
	lease.ID = uuid.NewString()
	lease.ControllerID = session.ID
	lease.ExpiresAt = now.Add(s.selectionLeaseTTL)
	if err := s.store.PutSelectionLease(ctx, &lease); err != nil {
		_ = s.store.DeleteSession(ctx, session.ID)
		return nil, nil, err
	}
	return session, &lease, nil
}

func (s *Service) Environments(ctx context.Context, userID int64, desktop bool, localDeviceID string) ([]Environment, error) {
	localDeviceID = canonicalAgentID(localDeviceID)
	devices, err := s.store.ListDevices(ctx, userID)
	if err != nil {
		return nil, err
	}
	environments := make([]Environment, 0, len(devices)+1)
	if !desktop {
		environments = append(environments, Environment{
			RuntimeKind: RuntimeKindWebChat, Name: "网页对话", Online: true,
			Workspaces:        []Workspace{{ID: CloudWorkspaceID, Name: "云端对话"}},
			TargetFingerprint: TargetFingerprint(RuntimeKindWebChat, "", CloudWorkspaceID),
			Capabilities:      []string{"chat", "reasoning", "attachments", "model_native"},
		})
	}
	for _, device := range devices {
		name := device.Name
		if desktop && device.ID == localDeviceID {
			name = "此电脑"
		}
		lastSeen := device.LastSeenAt
		environments = append(environments, Environment{
			RuntimeKind: RuntimeKindDeviceAgent, DeviceID: device.ID, AgentID: device.ID, DeviceName: device.Name, Name: name, Online: device.Online,
			Platform: device.Platform, Version: device.Version, LastSeenAt: &lastSeen, Workspaces: device.Workspaces,
			Capabilities: []string{"agent", "files", "terminal", "git", "mcp", "hooks", "cron"},
		})
	}
	return environments, nil
}

type SelectTargetInput struct {
	RuntimeKind string `json:"runtime_kind"`
	DeviceID    string `json:"device_id,omitempty"`
	WorkspaceID string `json:"workspace_id"`
	Scope       string `json:"scope,omitempty"`
	Target      string `json:"target_fingerprint"`
}

func (s *Service) Device(ctx context.Context, userID int64, deviceID string) (*Device, error) {
	device, err := s.store.GetDevice(ctx, userID, strings.TrimSpace(deviceID))
	if err != nil {
		return nil, &APIError{Status: http.StatusNotFound, Message: "device not found"}
	}
	return device, nil
}

func (s *Service) SelectTarget(ctx context.Context, session *Session, input SelectTargetInput) (*SelectionLease, error) {
	input.RuntimeKind = strings.TrimSpace(input.RuntimeKind)
	input.DeviceID = strings.TrimSpace(input.DeviceID)
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.Scope = strings.TrimSpace(input.Scope)
	if input.Scope == "" {
		input.Scope = SelectionScopeWorkspace
	}
	expectedTarget := TargetFingerprint(input.RuntimeKind, input.DeviceID, input.WorkspaceID)
	if input.Target != expectedTarget {
		return nil, &APIError{Status: http.StatusBadRequest, Message: "target fingerprint does not match the requested environment"}
	}
	switch input.RuntimeKind {
	case RuntimeKindWebChat:
		if input.DeviceID != "" || input.WorkspaceID != CloudWorkspaceID || input.Scope != SelectionScopeWorkspace {
			return nil, &APIError{Status: http.StatusBadRequest, Message: "invalid web chat workspace"}
		}
	case RuntimeKindDeviceAgent:
		device, err := s.store.GetDevice(ctx, session.UserID, input.DeviceID)
		if err != nil {
			return nil, &APIError{Status: http.StatusNotFound, Message: "device not found"}
		}
		if !device.Online {
			return nil, &APIError{Status: http.StatusConflict, Message: "device is offline"}
		}
		switch input.Scope {
		case SelectionScopeDevice:
			if input.WorkspaceID != "" {
				return nil, &APIError{Status: http.StatusBadRequest, Message: "device-scoped selection cannot include workspace_id"}
			}
		case SelectionScopeWorkspace:
			if !hasWorkspace(device.Workspaces, input.WorkspaceID) {
				return nil, &APIError{Status: http.StatusForbidden, Message: "workspace is not published by this device"}
			}
		default:
			return nil, &APIError{Status: http.StatusBadRequest, Message: "unsupported selection scope"}
		}
	default:
		return nil, &APIError{Status: http.StatusBadRequest, Message: "unsupported runtime_kind"}
	}
	now := s.now().UTC()
	input.DeviceID = canonicalAgentID(input.DeviceID)
	lease := &SelectionLease{
		ID: uuid.NewString(), UserID: session.UserID, ControllerID: session.ID,
		RuntimeKind: input.RuntimeKind, DeviceID: input.DeviceID, AgentID: input.DeviceID, WorkspaceID: input.WorkspaceID,
		Scope: input.Scope, Target: expectedTarget, ConversationID: uuid.NewString(), ExpiresAt: now.Add(s.selectionLeaseTTL),
	}
	if err := s.store.PutSelectionLease(ctx, lease); err != nil {
		return nil, err
	}
	return lease, nil
}

func (s *Service) createSession(ctx context.Context, result *LoginResult) (*Session, error) {
	now := s.now().UTC()
	session := &Session{
		ID: uuid.NewString(), UserID: result.UserID, User: result.User,
		AccessToken: result.AccessToken, RefreshToken: result.RefreshToken,
		AccessExpiresAt: s.accessExpiry(result.ExpiresIn), SessionExpiresAt: now.Add(s.sessionTTL),
	}
	if err := s.store.PutSession(ctx, session); err != nil {
		return nil, err
	}
	return session, nil
}

func (s *Service) StartOAuth(ctx context.Context, surface, redirectURI, returnPath, installationID string) (string, error) {
	clientID := "zeroagent-web"
	platform := "web"
	if surface == "android" {
		clientID, platform = "zeroagent-android", "android"
	} else if surface != "web" {
		return "", &APIError{Status: http.StatusBadRequest, Message: "surface must be web or android"}
	} else if !s.usa.WebOAuthConfigured() {
		return "", &APIError{Status: http.StatusServiceUnavailable, Message: "ZeroAgent Web OAuth is not configured"}
	}
	state, err := randomToken(32)
	if err != nil {
		return "", err
	}
	verifier, err := randomToken(48)
	if err != nil {
		return "", err
	}
	challengeSum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(challengeSum[:])
	requestID, err := s.usa.CreateAppAuthorizationRequest(ctx, map[string]any{
		"response_type": "code", "client_id": clientID, "redirect_uri": redirectURI,
		"scope":          "profile:read profile:write usage:read groups:read keys:read keys:write subscriptions:read execution:authorize offline_access",
		"code_challenge": challenge, "code_challenge_method": "S256", "state": state,
		"device_name": "ZeroAgent", "platform": platform,
		"installation_id": strings.TrimSpace(installationID),
	})
	if err != nil {
		return "", err
	}
	transaction := &OAuthTransaction{
		State: state, Verifier: verifier, ClientID: clientID, RedirectURI: redirectURI,
		ReturnPath: sanitizeReturnPath(returnPath), Surface: surface, ExpiresAt: s.now().UTC().Add(5 * time.Minute),
	}
	if err := s.store.PutOAuthTransaction(ctx, hashToken(state), transaction); err != nil {
		return "", err
	}
	return s.usa.AuthorizationOrigin() + "/oauth/authorize?request_id=" + url.QueryEscape(requestID), nil
}

func (s *Service) CompleteOAuth(ctx context.Context, state, code, expectedSurface string) (*Session, string, error) {
	transaction, err := s.store.ConsumeOAuthTransaction(ctx, hashToken(strings.TrimSpace(state)))
	if err != nil || transaction.State != state || transaction.Surface != expectedSurface {
		return nil, "", &APIError{Status: http.StatusBadRequest, Message: "authorization state is invalid, expired, or already used"}
	}
	if strings.TrimSpace(code) == "" {
		return nil, transaction.ReturnPath, &APIError{Status: http.StatusBadRequest, Message: "authorization code is required"}
	}
	tokens, err := s.usa.ExchangeAppCode(ctx, transaction.ClientID, code, transaction.RedirectURI, transaction.Verifier)
	if err != nil {
		return nil, transaction.ReturnPath, err
	}
	user, err := s.usa.AppMe(ctx, tokens.AccessToken)
	if err != nil {
		return nil, transaction.ReturnPath, err
	}
	user = markOAuthUser(user)
	var identity struct {
		ID int64 `json:"id"`
	}
	if json.Unmarshal(user, &identity) != nil || identity.ID <= 0 {
		return nil, transaction.ReturnPath, &APIError{Status: http.StatusBadGateway, Message: "USA-Zero OAuth identity is invalid"}
	}
	now := s.now().UTC()
	session := &Session{
		ID: uuid.NewString(), UserID: identity.ID, User: user, AccessToken: tokens.AccessToken,
		RefreshToken: tokens.RefreshToken, AccessExpiresAt: s.accessExpiry(tokens.ExpiresIn),
		SessionExpiresAt: now.Add(s.sessionTTL), AuthKind: AuthKindOAuth, OAuthClientID: transaction.ClientID,
	}
	if err := s.store.PutSession(ctx, session); err != nil {
		return nil, transaction.ReturnPath, err
	}
	return session, transaction.ReturnPath, nil
}

func sanitizeReturnPath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") {
		return "/"
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.IsAbs() || parsed.Host != "" {
		return "/"
	}
	return parsed.RequestURI()
}

func markOAuthUser(user json.RawMessage) json.RawMessage {
	var value map[string]any
	if json.Unmarshal(user, &value) != nil {
		return user
	}
	value["auth_kind"] = AuthKindOAuth
	encoded, err := json.Marshal(value)
	if err != nil {
		return user
	}
	return encoded
}

func (s *Service) accessExpiry(expiresIn int) time.Time {
	if expiresIn <= 0 {
		expiresIn = 15 * 60
	}
	return s.now().UTC().Add(time.Duration(expiresIn) * time.Second)
}

func TargetFingerprint(runtimeKind, deviceID, workspaceID string) string {
	return strings.Join([]string{strings.TrimSpace(runtimeKind), strings.TrimSpace(deviceID), strings.TrimSpace(workspaceID)}, ":")
}

func (s *Service) CreateCloudConversation(ctx context.Context, userID int64, model string) (*CloudConversation, error) {
	now := s.now().UTC()
	conversation := &CloudConversation{
		ID: uuid.NewString(), UserID: userID, Title: "新对话", Model: strings.TrimSpace(model),
		CreatedAt: now, UpdatedAt: now,
	}
	if err := s.store.PutCloudConversation(ctx, conversation); err != nil {
		return nil, err
	}
	return conversation, nil
}

func (s *Service) ListCloudConversations(ctx context.Context, userID int64) ([]CloudConversation, error) {
	return s.store.ListCloudConversations(ctx, userID)
}

func (s *Service) RenameCloudConversation(
	ctx context.Context,
	userID int64,
	conversationID string,
	title string,
) (*CloudConversation, error) {
	conversation, err := s.store.GetCloudConversation(ctx, userID, strings.TrimSpace(conversationID))
	if err != nil {
		return nil, ErrNotFound
	}
	title = strings.TrimSpace(title)
	if title == "" {
		return nil, &APIError{Status: http.StatusBadRequest, Message: "conversation title is required"}
	}
	if len([]rune(title)) > 120 {
		return nil, &APIError{Status: http.StatusBadRequest, Message: "conversation title is too long"}
	}
	conversation.Title = title
	conversation.UpdatedAt = time.Now().UTC()
	if err := s.store.PutCloudConversation(ctx, conversation); err != nil {
		return nil, err
	}
	return conversation, nil
}

func (s *Service) CloudMessages(ctx context.Context, userID int64, conversationID string) ([]CloudMessage, error) {
	return s.store.ListCloudMessages(ctx, userID, conversationID)
}

func (s *Service) DeleteCloudConversation(ctx context.Context, userID int64, conversationID string) error {
	if err := s.store.DeleteCloudConversation(ctx, userID, conversationID); err != nil {
		if errors.Is(err, ErrNotFound) {
			return &APIError{Status: http.StatusNotFound, Message: "conversation not found"}
		}
		return err
	}
	return nil
}

func (s *Service) WebAPIKey(ctx context.Context, session *Session) (string, error) {
	s.webKeyMu.Lock()
	defer s.webKeyMu.Unlock()
	if key := s.webKeys[session.UserID]; key != "" {
		return key, nil
	}
	var key string
	var err error
	if session.IsOAuth() {
		key, err = s.usa.EnsureAppWebAPIKey(ctx, session.AccessToken)
	} else {
		key, err = s.usa.EnsureWebAPIKey(ctx, session.AccessToken)
	}
	if err != nil {
		return "", err
	}
	s.webKeys[session.UserID] = key
	return key, nil
}

func (s *Service) WebProviderModels(ctx context.Context, session *Session, keyID int64) (json.RawMessage, error) {
	if session.IsOAuth() {
		return s.usa.AppModelsForAPIKey(ctx, session.AccessToken, keyID)
	}
	return s.usa.ModelsForAPIKey(ctx, session.AccessToken, keyID)
}

func (s *Service) WebAPIKeyForID(ctx context.Context, session *Session, keyID int64) (string, error) {
	if session.IsOAuth() {
		return s.usa.AppOwnedAPIKey(ctx, session.AccessToken, keyID)
	}
	return s.usa.OwnedAPIKey(ctx, session.AccessToken, keyID)
}

func (s *Service) ProxyUSA(ctx context.Context, session *Session, method, apiPath string, body []byte) (json.RawMessage, error) {
	if session.IsOAuth() {
		return s.usa.ProxyApp(ctx, method, apiPath, session.AccessToken, body)
	}
	return s.usa.Proxy(ctx, method, apiPath, session.AccessToken, body)
}

func (s *Service) AddCloudMessage(ctx context.Context, message *CloudMessage) error {
	return s.store.AddCloudMessage(ctx, message)
}

func (s *Service) UpdateCloudConversation(ctx context.Context, conversation *CloudConversation) error {
	return s.store.PutCloudConversation(ctx, conversation)
}

func (s *Service) WebSettings(ctx context.Context, userID int64) (*WebSettings, error) {
	settings, err := s.store.GetWebSettings(ctx, userID)
	if errors.Is(err, ErrNotFound) {
		return &WebSettings{Model: "gpt-5.1", ReasoningEffort: "medium"}, nil
	}
	return settings, err
}

func (s *Service) UpdateWebSettings(ctx context.Context, userID int64, input WebSettings) (*WebSettings, error) {
	input.Model = strings.TrimSpace(input.Model)
	input.ReasoningEffort = strings.TrimSpace(input.ReasoningEffort)
	if input.Model == "" || len(input.Model) > 200 {
		return nil, &APIError{Status: http.StatusBadRequest, Message: "model must be 1-200 characters"}
	}
	switch input.ReasoningEffort {
	case "low", "medium", "high":
	default:
		return nil, &APIError{Status: http.StatusBadRequest, Message: "reasoning_effort must be low, medium or high"}
	}
	if err := s.store.PutWebSettings(ctx, userID, input); err != nil {
		return nil, err
	}
	return &input, nil
}

func (s *Service) RecordDeviceHistorySync(userID int64, deviceID string, event *gatewayv2.HistorySyncEvent) {
	if userID <= 0 || strings.TrimSpace(deviceID) == "" || event == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conversationID := strings.TrimSpace(event.GetConversationId())
	if conversationID == "" && event.GetConversation() != nil {
		conversationID = strings.TrimSpace(event.GetConversation().GetId())
	}
	if _, err := uuid.Parse(conversationID); err != nil {
		return
	}
	if strings.EqualFold(strings.TrimSpace(event.GetKind()), "delete") {
		_ = s.store.DeleteConversationRoute(ctx, userID, conversationID)
		return
	}
	conversation := event.GetConversation()
	if conversation == nil {
		return
	}
	device, err := s.store.GetDevice(ctx, userID, deviceID)
	if err != nil {
		return
	}
	workspaceID := "unknown"
	for _, workspace := range device.Workspaces {
		if equalWorkspacePath(workspace.Path, conversation.GetCwd()) {
			workspaceID = workspace.ID
			break
		}
	}
	createdAt := historyEpochTime(conversation.GetCreatedAt())
	updatedAt := historyEpochTime(conversation.GetUpdatedAt())
	if createdAt.IsZero() {
		createdAt = s.now().UTC()
	}
	if updatedAt.IsZero() {
		updatedAt = createdAt
	}
	title := strings.TrimSpace(conversation.GetTitle())
	if title == "" {
		title = "新对话"
	}
	summaryParts := make([]string, 0, 2)
	if conversation.GetMessageCount() > 0 {
		summaryParts = append(summaryParts, fmt.Sprintf("%d 条消息", conversation.GetMessageCount()))
	}
	if model := strings.TrimSpace(conversation.GetModel()); model != "" {
		summaryParts = append(summaryParts, model)
	}
	_ = s.store.PutConversationRoute(ctx, &ConversationRoute{
		ConversationID: conversationID, UserID: userID, RuntimeKind: RuntimeKindDeviceAgent,
		DeviceID: deviceID, AgentID: canonicalAgentID(deviceID), WorkspaceID: workspaceID, Title: title,
		Summary: strings.Join(summaryParts, " · "), CreatedAt: createdAt, UpdatedAt: updatedAt,
	})
}

func (s *Service) RecordAgentHistorySync(agentID string, event *gatewayv2.HistorySyncEvent) {
	device, err := s.store.GetDeviceByID(context.Background(), agentID)
	if err != nil {
		return
	}
	s.RecordDeviceHistorySync(device.UserID, device.ID, event)
}

func (s *Service) ConversationRoutes(ctx context.Context, userID int64) ([]ConversationRoute, error) {
	return s.ConversationRoutesForDevice(ctx, userID, "")
}

func (s *Service) ConversationRoutesForDevice(ctx context.Context, userID int64, deviceID string) ([]ConversationRoute, error) {
	routes, err := s.store.ListConversationRoutes(ctx, userID)
	if err != nil {
		return nil, err
	}
	devices, err := s.store.ListDevices(ctx, userID)
	if err != nil {
		return nil, err
	}
	byID := make(map[string]Device, len(devices))
	for _, device := range devices {
		byID[device.ID] = device
	}
	filtered := make([]ConversationRoute, 0, len(routes))
	deviceID = strings.TrimSpace(deviceID)
	for index := range routes {
		if deviceID != "" && routes[index].DeviceID != deviceID {
			continue
		}
		if device, ok := byID[routes[index].DeviceID]; ok {
			routes[index].DeviceName = device.Name
			routes[index].DeviceOnline = device.Online
		} else {
			routes[index].DeviceName = "已撤销设备"
		}
		filtered = append(filtered, routes[index])
	}
	return filtered, nil
}

func equalWorkspacePath(left, right string) bool {
	normalize := func(value string) string {
		return strings.ToLower(strings.TrimRight(strings.ReplaceAll(strings.TrimSpace(value), `\`, "/"), "/"))
	}
	return normalize(left) != "" && normalize(left) == normalize(right)
}

func historyEpochTime(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	if value > 10_000_000_000 {
		return time.UnixMilli(value).UTC()
	}
	return time.Unix(value, 0).UTC()
}

func normalizeWorkspaces(input []Workspace) ([]Workspace, error) {
	seen := make(map[string]struct{}, len(input))
	result := make([]Workspace, 0, len(input))
	for _, workspace := range input {
		workspace.ID = strings.TrimSpace(workspace.ID)
		workspace.Name = strings.TrimSpace(workspace.Name)
		workspace.Path = strings.TrimSpace(workspace.Path)
		if workspace.ID == "" || workspace.Name == "" || workspace.Path == "" || len(workspace.Path) > 4096 {
			return nil, &APIError{Status: http.StatusBadRequest, Message: "each workspace requires id, name and path"}
		}
		if _, ok := seen[workspace.ID]; ok {
			return nil, &APIError{Status: http.StatusBadRequest, Message: "workspace ids must be unique"}
		}
		seen[workspace.ID] = struct{}{}
		result = append(result, workspace)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}

func hasWorkspace(workspaces []Workspace, id string) bool {
	for _, workspace := range workspaces {
		if workspace.ID == id {
			return true
		}
	}
	return false
}

func normalizeDeviceName(value, fallback string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return fallback
	}
	if len(value) > 100 {
		return value[:100]
	}
	return value
}

func randomToken(size int) (string, error) {
	raw := make([]byte, size)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate secure token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func hashToken(token string) string {
	hash := sha256.Sum256([]byte(token))
	return hex.EncodeToString(hash[:])
}
