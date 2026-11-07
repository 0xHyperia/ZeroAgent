package handler

import (
	"context"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

func WorkspaceHandoff(sm *session.Manager, timeout time.Duration, agentID string, authorize func(string) bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		query := r.URL.Query()
		workspace := query.Get("workspace_id")
		id, err := uuid.Parse(query.Get("operation_id"))
		name := query.Get("name")
		if err != nil || workspace == "" || name == "" || len(name) > 512 || !utf8.ValidString(name) {
			writeError(w, http.StatusBadRequest, "invalid workspace transfer")
			return
		}
		if !authorize(workspace) {
			writeError(w, http.StatusForbidden, "workspace is unavailable or authorization expired")
			return
		}
		content, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 32<<20))
		if err != nil {
			writeError(w, http.StatusRequestEntityTooLarge, "file is too large or incomplete")
			return
		}
		if !authorize(workspace) {
			writeError(w, http.StatusForbidden, "workspace is unavailable or authorization expired")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		requestID := newRequestID()
		ch, done, cleanup, err := sm.RegisterStreamAndSendContext(ctx, agentID, requestID, &gatewayv2.GatewayEnvelope{
			RequestId: requestID, Timestamp: time.Now().Unix(),
			Payload: &gatewayv2.GatewayEnvelope_WorkspaceHandoff{WorkspaceHandoff: &gatewayv2.WorkspaceHandoffRequest{
				WorkspaceId: workspace, OperationId: id.String(), FileName: name, Content: content,
			}},
		})
		if err != nil {
			writeError(w, http.StatusServiceUnavailable, "device unavailable")
			return
		}
		defer cleanup()
		env, err := waitForEnvelope(ctx, ch, done)
		if err != nil {
			writeError(w, http.StatusGatewayTimeout, "transfer result is unknown")
			return
		}
		if failure := env.GetError(); failure != nil {
			writeError(w, GatewayErrorStatus(failure), failure.GetMessage())
			return
		}
		result := env.GetWorkspaceHandoffResp().GetRelativePath()
		folder, name, valid := strings.Cut(result, "/")
		if !valid || folder != "ZA-"+id.String() || !strings.HasPrefix(name, "ZA-") || strings.ContainsAny(name, "/\\:") {
			writeError(w, http.StatusBadGateway, "transfer result is unknown")
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"relative_path": result})
	}
}
