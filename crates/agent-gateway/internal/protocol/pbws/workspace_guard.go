package pbws

import (
	"context"
	"errors"
	"strings"

	"github.com/liveagent/agent-gateway/internal/account"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
)

func normalizeRemoteWorkspacePath(value string) (string, bool) {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\\", "/"))
	if value == "" {
		return "", true
	}
	parts := strings.Split(value, "/")
	clean := make([]string, 0, len(parts))
	for _, part := range parts {
		switch part {
		case "", ".":
			continue
		case "..":
			return "", false
		default:
			clean = append(clean, part)
		}
	}
	prefix := ""
	if strings.HasPrefix(value, "/") {
		prefix = "/"
	}
	return strings.ToLower(strings.TrimRight(prefix+strings.Join(clean, "/"), "/")), true
}

func (c *browserConn) workspaceAllows(workdir string) bool {
	normalized, ok := normalizeRemoteWorkspacePath(workdir)
	if !ok || normalized == "" {
		return false
	}
	workspaces := c.allowedWorkspaces
	if c.srv != nil && c.srv.accounts != nil && strings.TrimSpace(c.boundAgentID) != "" {
		current, err := c.srv.accounts.AgentWorkspaces(context.Background(), c.boundAgentID)
		if err != nil {
			return false
		}
		workspaces = current
	}
	for _, workspace := range workspaces {
		if c.selectionScope == account.SelectionScopeWorkspace && workspace.ID != c.workspaceID {
			continue
		}
		candidate, candidateOK := normalizeRemoteWorkspacePath(workspace.Path)
		if candidateOK && candidate == normalized {
			return true
		}
	}
	return false
}

func (c *browserConn) vetChatWorkdir(workdir string) error {
	if c.selectionScope == "" || strings.TrimSpace(workdir) == "" {
		return nil
	}
	if !c.workspaceAllows(workdir) {
		return errors.New("workdir is not a published project on the selected device")
	}
	return nil
}

func (c *browserConn) vetPlainChat(executionMode, workdir string, selectedTools []string) error {
	if c.selectionScope != account.SelectionScopeDevice || strings.TrimSpace(workdir) != "" {
		return nil
	}
	if strings.TrimSpace(executionMode) != "text" || len(selectedTools) > 0 {
		return errors.New("plain chat requires text mode and cannot use project tools")
	}
	return nil
}

func (c *browserConn) requireWorkspace(workdir string) error {
	if c.selectionScope == "" {
		return nil
	}
	if !c.workspaceAllows(workdir) {
		return errors.New("operation is outside the selected device projects")
	}
	return nil
}

func (c *browserConn) vetWorkspaceAgentRequest(env *gatewayv2.GatewayEnvelope) error {
	if c.selectionScope == "" || env == nil {
		return nil
	}
	switch payload := env.GetPayload().(type) {
	case *gatewayv2.GatewayEnvelope_HistoryList:
		if strings.TrimSpace(payload.HistoryList.GetCwd()) != "" {
			return c.requireWorkspace(payload.HistoryList.GetCwd())
		}
	case *gatewayv2.GatewayEnvelope_FileMentionList:
		return c.requireWorkspace(payload.FileMentionList.GetWorkdir())
	case *gatewayv2.GatewayEnvelope_FsList:
		return c.requireWorkspace(payload.FsList.GetWorkdir())
	case *gatewayv2.GatewayEnvelope_FsReadEditableText:
		return c.requireWorkspace(payload.FsReadEditableText.GetWorkdir())
	case *gatewayv2.GatewayEnvelope_FsReadWorkspaceImage:
		return c.requireWorkspace(payload.FsReadWorkspaceImage.GetWorkdir())
	case *gatewayv2.GatewayEnvelope_FsWriteText:
		return c.requireWorkspace(payload.FsWriteText.GetWorkdir())
	case *gatewayv2.GatewayEnvelope_FsCreateDir:
		return c.requireWorkspace(payload.FsCreateDir.GetWorkdir())
	case *gatewayv2.GatewayEnvelope_FsRename:
		return c.requireWorkspace(payload.FsRename.GetWorkdir())
	case *gatewayv2.GatewayEnvelope_FsDelete:
		return c.requireWorkspace(payload.FsDelete.GetWorkdir())
	case *gatewayv2.GatewayEnvelope_GitRequest:
		return c.requireWorkspace(payload.GitRequest.GetWorkdir())
	case *gatewayv2.GatewayEnvelope_TerminalRequest:
		if strings.TrimSpace(payload.TerminalRequest.GetCwd()) != "" {
			return c.requireWorkspace(payload.TerminalRequest.GetCwd())
		}
	case *gatewayv2.GatewayEnvelope_FsRoots,
		*gatewayv2.GatewayEnvelope_FsListDirs,
		*gatewayv2.GatewayEnvelope_FsCreateProjectFolder:
		if c.selectionScope != account.SelectionScopeDevice {
			return errors.New("project browsing and creation require a device selection")
		}
	}
	return nil
}
