package pbws

import (
	"context"
	"testing"
	"time"

	"github.com/liveagent/agent-gateway/internal/account"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func TestDeviceWorkspaceGuard(t *testing.T) {
	conn := &browserConn{
		selectionScope: account.SelectionScopeDevice,
		allowedWorkspaces: []account.Workspace{
			{ID: "project-a", Path: "E:/code/project-a"},
		},
	}
	if err := conn.vetChatWorkdir("e:/code/project-a"); err != nil {
		t.Fatalf("published project rejected: %v", err)
	}
	if err := conn.vetChatWorkdir("E:/code/other"); err == nil {
		t.Fatal("unpublished workdir accepted")
	}
	if err := conn.vetChatWorkdir("E:/code/project-a/../other"); err == nil {
		t.Fatal("traversal workdir accepted")
	}
	if err := conn.vetPlainChat("text", "", nil); err != nil {
		t.Fatalf("plain chat rejected: %v", err)
	}
	if err := conn.vetPlainChat("tools", "", nil); err == nil {
		t.Fatal("plain chat accepted tools execution mode")
	}
	if err := conn.vetPlainChat("text", "", []string{"custom"}); err == nil {
		t.Fatal("plain chat accepted project tools")
	}
}

func TestWorkspaceGuardReadsCurrentDeviceWorkspaces(t *testing.T) {
	const agentID = "agent-123e4567-e89b-42d3-a456-426614174000"
	store := account.NewMemoryStore()
	service := account.NewService(store, nil, time.Hour, time.Hour)
	device := &account.Device{
		ID: agentID, AgentID: agentID, UserID: 7,
		Workspaces: []account.Workspace{{ID: "project-a", Name: "A", Path: "/repo/a"}},
	}
	if err := store.UpsertDevice(context.Background(), device); err != nil {
		t.Fatalf("seed device: %v", err)
	}
	conn := &browserConn{
		srv: &Server{accounts: service}, boundAgentID: agentID,
		selectionScope:    account.SelectionScopeDevice,
		allowedWorkspaces: []account.Workspace{{ID: "stale", Path: "/repo/stale"}},
	}
	if !conn.workspaceAllows("/repo/a") {
		t.Fatal("current published workspace rejected")
	}
	device.Workspaces = []account.Workspace{{ID: "project-b", Name: "B", Path: "/repo/b"}}
	if err := store.UpsertDevice(context.Background(), device); err != nil {
		t.Fatalf("update device: %v", err)
	}
	if conn.workspaceAllows("/repo/a") {
		t.Fatal("removed workspace remained authorized")
	}
	if !conn.workspaceAllows("/repo/b") {
		t.Fatal("new workspace was not authorized")
	}
}

func TestWorkspaceGuardAllowsProjectBrowsingAndCreationForDeviceSelection(t *testing.T) {
	conn := &browserConn{
		selectionScope:    account.SelectionScopeDevice,
		allowedWorkspaces: []account.Workspace{{ID: "project-a", Path: "/repo/a"}},
	}
	env := &gatewayv2.GatewayEnvelope{
		Payload: &gatewayv2.GatewayEnvelope_FsCreateProjectFolder{
			FsCreateProjectFolder: &gatewayv2.FsCreateProjectFolderRequest{
				Parent: "/repo",
				Name:   "new",
			},
		},
	}
	if err := conn.vetWorkspaceAgentRequest(env); err != nil {
		t.Fatalf("remote project creation rejected: %v", err)
	}
}

func TestWorkspaceGuardRejectsProjectBrowsingForWorkspaceSelection(t *testing.T) {
	conn := &browserConn{selectionScope: account.SelectionScopeWorkspace}
	env := &gatewayv2.GatewayEnvelope{
		Payload: &gatewayv2.GatewayEnvelope_FsListDirs{
			FsListDirs: &gatewayv2.FsListDirsRequest{Path: "/repo"},
		},
	}
	if err := conn.vetWorkspaceAgentRequest(env); err == nil {
		t.Fatal("workspace-scoped project browsing accepted")
	}
}
