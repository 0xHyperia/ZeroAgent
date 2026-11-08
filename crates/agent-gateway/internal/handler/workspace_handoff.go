package handler

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

const WorkspaceHandoffPathHeader = "X-ZeroAgent-Workspace-Path"

func writeWorkspaceHandoffDenial(w http.ResponseWriter, status int) {
	if status == http.StatusPreconditionFailed {
		writeError(w, status, "workspace directory changed")
	} else {
		writeError(w, status, "workspace is unavailable or authorization expired")
	}
}

func WorkspaceHandoff(sm *session.Manager, timeout time.Duration, agentID string, authorize func(workspace, expectedPath string) int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != http.MethodGet && r.Method != http.MethodPost {
			w.Header().Set("Allow", "GET, POST")
			writeError(w, http.StatusMethodNotAllowed, "unsupported workspace transfer method")
			return
		}
		query := r.URL.Query()
		workspace := query.Get("workspace_id")
		paths := r.Header.Values(WorkspaceHandoffPathHeader)
		if len(paths) != 1 || len(paths[0]) > base64.RawURLEncoding.EncodedLen(4096) {
			writeError(w, http.StatusBadRequest, "missing or invalid confirmed workspace directory")
			return
		}
		decodedPath, pathErr := base64.RawURLEncoding.Strict().DecodeString(paths[0])
		expectedPath := string(decodedPath)
		if pathErr != nil || expectedPath == "" || !utf8.ValidString(expectedPath) || strings.ContainsFunc(expectedPath, unicode.IsControl) {
			writeError(w, http.StatusBadRequest, "missing or invalid confirmed workspace directory")
			return
		}
		id, err := uuid.Parse(query.Get("operation_id"))
		name := query.Get("name")
		check := r.Method == http.MethodGet
		if err != nil || workspace == "" || (check && (name != "" || r.ContentLength != 0)) ||
			(!check && (name == "" || len(name) > 512 || !utf8.ValidString(name))) {
			writeError(w, http.StatusBadRequest, "invalid workspace transfer")
			return
		}
		if status := authorize(workspace, expectedPath); status != http.StatusOK {
			writeWorkspaceHandoffDenial(w, status)
			return
		}
		var content []byte
		if !check {
			content, err = io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
			if err != nil {
				writeError(w, http.StatusRequestEntityTooLarge, "file is too large or incomplete")
				return
			}
			if status := authorize(workspace, expectedPath); status != http.StatusOK {
				writeWorkspaceHandoffDenial(w, status)
				return
			}
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		requestID := newRequestID()
		ch, done, cleanup, err := sm.RegisterCapabilityStreamAndSendContext(ctx, agentID, requestID, &gatewayv2.GatewayEnvelope{
			RequestId: requestID, Timestamp: time.Now().Unix(),
			Payload: &gatewayv2.GatewayEnvelope_WorkspaceHandoff{WorkspaceHandoff: &gatewayv2.WorkspaceHandoffRequest{
				WorkspaceId: workspace, OperationId: id.String(), FileName: name, Content: content, CheckOnly: check, ExpectedWorkspacePath: expectedPath,
			}},
		}, gatewayv2.WorkspaceHandoffPathV1Capability)
		if err != nil {
			if errors.Is(err, session.ErrAgentCapabilityUnavailable) {
				writeError(w, http.StatusUpgradeRequired, "update the target device to confirm its workspace directory")
				return
			}
			writeError(w, http.StatusServiceUnavailable, "device unavailable")
			return
		}
		defer cleanup()
		env, err := waitForEnvelope(ctx, ch, done)
		if err != nil {
			writeError(w, http.StatusGatewayTimeout, "transfer result is unknown")
			return
		}
		if status := authorize(workspace, expectedPath); status != http.StatusOK {
			if check {
				writeWorkspaceHandoffDenial(w, status)
			} else {
				writeError(w, http.StatusBadGateway, "transfer result is unknown")
			}
			return
		}
		if failure := env.GetError(); failure != nil {
			if failure.GetCode() == http.StatusPreconditionFailed {
				writeWorkspaceHandoffDenial(w, http.StatusPreconditionFailed)
			} else {
				writeError(w, GatewayErrorStatus(failure), failure.GetMessage())
			}
			return
		}
		response := env.GetWorkspaceHandoffResp()
		if check && response != nil && response.GetRelativePath() == "" {
			writeJSON(w, http.StatusOK, map[string]string{"status": "not_found"})
			return
		}
		result := response.GetRelativePath()
		folder, name, valid := strings.Cut(result, "/")
		if !valid || folder != "ZA-"+id.String() || !strings.HasPrefix(name, "ZA-") ||
			len(name) <= len("ZA-") || len(name) > 512 || strings.ContainsAny(name, "/\\:") || strings.ContainsFunc(name, unicode.IsControl) {
			writeError(w, http.StatusBadGateway, "transfer result is unknown")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"relative_path": result})
	}
}
