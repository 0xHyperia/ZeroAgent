package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	gateway "github.com/liveagent/agent-gateway"
	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	gatewayv2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

type httpHandler struct {
	http.Handler
	closeOnce sync.Once
	protocol  *pbws.Server
}

func (h *httpHandler) Close() error {
	h.closeOnce.Do(h.protocol.Close)
	return nil
}

// NewHTTPServer 构造 HTTP 路由；生产启动时 tokens 始终是已初始化的 Agent 目录与凭证存储。
func NewHTTPServer(cfg *config.Config, sm *session.Manager, authenticator pbws.AgentAuthenticator) http.Handler {
	return NewHTTPServerWithReadiness(cfg, sm, authenticator, nil)
}

func NewHTTPServerWithReadiness(
	cfg *config.Config,
	sm *session.Manager,
	authenticator pbws.AgentAuthenticator,
	readinessCheck func(context.Context) error,
) http.Handler {
	rootMux := http.NewServeMux()
	rootMux.HandleFunc("GET /healthz", handler.Health())
	rootMux.HandleFunc("GET /readyz", handler.Ready(readinessCheck))
	accounts, _ := authenticator.(*account.Service)
	if accounts != nil {
		accountHTTP := account.NewHTTPHandler(accounts, cfg.CookieSecure, cfg.PublicOrigin)
		accountHTTP.Register(rootMux)
		accountHTTP.RegisterDeviceSchedules(rootMux, handler.DeviceScheduleSummary(sm, cfg.RequestTimeout))
		accounts.SetDeviceRevoker(func(_ int64, agentID string) { sm.DisconnectAgent(agentID) })
		sm.SetHistoryObserver(accounts.RecordAgentHistorySync)
	}

	// v2 统一协议（WebSocket+Protobuf）三链路。
	v2 := pbws.NewServer(cfg, sm, authenticator)
	rootMux.Handle("/ws/v2", v2.BrowserHandler())
	rootMux.Handle("/ws/v2/agent", v2.AgentHandler())
	rootMux.Handle("/ws/v2/terminal", v2.TerminalHandler())

	rootMux.HandleFunc("/t/", publicTunnelProxy(sm))
	rootMux.HandleFunc("GET /image-proxy", handler.ImageProxy(cfg.RequestTimeout))
	rootMux.HandleFunc("GET /api/public/history-shares/{token}", publicHistoryShare(cfg, sm))
	rootMux.Handle("GET /api/public/model-catalog", handler.NewModelCatalogProxy(cfg.ModelCatalogURL, cfg.RequestTimeout))
	// The hosted multi-account image adapter is intentionally unavailable until principal/grant
	// integration is complete. Never serve SPA HTML or infer an owner from a shared bearer.
	unavailableImages := http.Handler(&handler.ImageGateway{})
	if accounts == nil {
		unavailableImages = auth.HTTPMiddleware(cfg.Token, unavailableImages)
	}
	rootMux.Handle("/api/image", unavailableImages)
	rootMux.Handle("/api/image/", unavailableImages)

	if accounts != nil {
		rootMux.Handle("/api/status", protectedAPIHandler(cfg, sm, accounts))
		rootMux.Handle("/api/files/import", protectedAPIHandler(cfg, sm, accounts))
		rootMux.Handle("/api/files/import-directory", protectedAPIHandler(cfg, sm, accounts))
		rootMux.Handle("POST /api/files/confirmed-handoff", protectedAPIHandler(cfg, sm, accounts))
		rootMux.Handle("GET /api/files/confirmed-handoff", protectedAPIHandler(cfg, sm, accounts))
	} else {
		rootMux.HandleFunc("GET /api/status", handler.Status(sm))
		importFiles := handler.ImportReadableFiles(sm, cfg.RequestTimeout, nil)
		directUpload := auth.HTTPMiddleware(cfg.Token, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			uploads := v2.KBrainUploads(strings.TrimSpace(r.URL.Query().Get("agent_id")))
			if uploads == nil {
				http.NotFound(w, r)
				return
			}
			uploads.ImportHandler(w, r)
		}))
		rootMux.HandleFunc("POST /api/files/import", func(w http.ResponseWriter, r *http.Request) {
			if v2.KBrainUploads(strings.TrimSpace(r.URL.Query().Get("agent_id"))) != nil {
				directUpload.ServeHTTP(w, r)
				return
			}
			importFiles(w, r)
		})
		rootMux.HandleFunc("POST /api/files/import-directory", handler.ImportDirectory(sm, cfg.RequestTimeout))
	}
	// Agent 目录与凭证管理，仅管理 token 可访问。

	webFS, err := fs.Sub(gateway.WebUIAssets, "web/dist")
	if err != nil {
		panic(err)
	}
	indexHTML, err := fs.ReadFile(webFS, "index.html")
	if err != nil {
		panic(err)
	}
	fileServer := http.FileServer(http.FS(webFS))
	serveIndex := func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		http.ServeContent(w, r, "index.html", time.Time{}, bytes.NewReader(indexHTML))
	}

	rootMux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		cleanPath := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		// A desktop-owned Gateway does not mount the hosted account API.
		if cleanPath == "api" || strings.HasPrefix(cleanPath, "api/") {
			w.Header().Set("Cache-Control", "no-store")
			writeJSON(w, http.StatusNotFound, map[string]any{"error": "API route unavailable"})
			return
		}
		if cleanPath == "." || cleanPath == "" || cleanPath == "index.html" {
			serveIndex(w, r)
			return
		}

		file, err := webFS.Open(cleanPath)
		if err == nil {
			if stat, statErr := file.Stat(); statErr == nil && !stat.IsDir() {
				_ = file.Close()
				if strings.HasPrefix(cleanPath, "assets/") || strings.HasPrefix(cleanPath, "resource-preview/pdf/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				// The Windows MIME registry can classify .mjs as text/plain,
				// preventing module workers. These are packaged app assets.
				switch path.Ext(cleanPath) {
				case ".mjs", ".js":
					w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
				case ".wasm":
					w.Header().Set("Content-Type", "application/wasm")
				}
				fileServer.ServeHTTP(w, r)
				return
			}
			_ = file.Close()
		}

		if isWebUIStaticAssetPath(cleanPath) {
			http.NotFound(w, r)
			return
		}

		serveIndex(w, r)
	})

	return &httpHandler{Handler: rootMux, protocol: v2}
}

type selectionCredentialPayload struct {
	Lease       string `json:"lease"`
	RuntimeKind string `json:"runtimeKind"`
	DeviceID    string `json:"deviceId"`
	AgentID     string `json:"agentId"`
	WorkspaceID string `json:"workspaceId"`
}

func protectedAPIHandler(cfg *config.Config, sm *session.Manager, accounts *account.Service) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.SplitN(strings.TrimSpace(r.Header.Get("Authorization")), " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
			return
		}
		credential, ok := decodeSelectionCredential(parts[1])
		if !ok || credential.RuntimeKind != account.RuntimeKindDeviceAgent {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid selection credential"})
			return
		}
		cookie, err := r.Cookie(account.SessionCookieName)
		if err != nil {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "account login required"})
			return
		}
		accountSession, lease, err := accounts.ValidateSelection(r.Context(), cookie.Value, credential.Lease)
		agentID := firstNonEmpty(credential.AgentID, credential.DeviceID)
		if err != nil || lease.AgentID != agentID || lease.WorkspaceID != credential.WorkspaceID {
			writeJSON(w, http.StatusUnauthorized, map[string]any{"error": "selection lease is invalid or expired"})
			return
		}
		device, err := accounts.Device(r.Context(), accountSession.UserID, agentID)
		if err != nil {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "selected device is unavailable"})
			return
		}
		switch r.URL.Path {
		case "/api/status":
			writeJSON(w, http.StatusOK, map[string]any{"agents": []session.Status{sm.Status(agentID)}})
		case "/api/files/import":
			query := r.URL.Query()
			query.Set("agent_id", agentID)
			r.URL.RawQuery = query.Encode()
			handler.ImportReadableFiles(sm, cfg.RequestTimeout, func(workdir string) bool {
				return pbws.SelectionAllowsWorkdir(lease, device.Workspaces, workdir)
			}).ServeHTTP(w, r)
		case "/api/files/import-directory":
			if lease.EffectiveScope() != account.SelectionScopeDevice {
				writeJSON(w, http.StatusForbidden, map[string]any{"error": "project creation requires a device selection"})
				return
			}
			query := r.URL.Query()
			query.Set("agent_id", agentID)
			r.URL.RawQuery = query.Encode()
			handler.ImportDirectory(sm, cfg.RequestTimeout).ServeHTTP(w, r)
		case "/api/files/confirmed-handoff":
			handler.WorkspaceHandoff(sm, cfg.RequestTimeout, agentID, func(workspace, expectedPath string) int {
				owner, current, err := accounts.ValidateSelection(r.Context(), cookie.Value, credential.Lease)
				if err != nil || owner.UserID != accountSession.UserID || current.AgentID != agentID ||
					current.DeviceID != lease.DeviceID ||
					(credential.DeviceID != "" && credential.DeviceID != current.DeviceID) ||
					current.EffectiveScope() != account.SelectionScopeWorkspace || current.WorkspaceID != workspace {
					return http.StatusForbidden
				}
				device, err := accounts.Device(r.Context(), owner.UserID, agentID)
				if err != nil || device.RevokedAt != nil {
					return http.StatusForbidden
				}
				for _, published := range device.Workspaces {
					if published.ID == workspace && published.Path != "" {
						if published.Path != expectedPath {
							return http.StatusPreconditionFailed
						}
						return http.StatusOK
					}
				}
				return http.StatusForbidden
			}).ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

func decodeSelectionCredential(value string) (selectionCredentialPayload, bool) {
	const prefix = "selection."
	if !strings.HasPrefix(value, prefix) {
		return selectionCredentialPayload{}, false
	}
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimPrefix(value, prefix))
	if err != nil {
		return selectionCredentialPayload{}, false
	}
	var payload selectionCredentialPayload
	if json.Unmarshal(data, &payload) != nil || strings.TrimSpace(payload.Lease) == "" {
		return selectionCredentialPayload{}, false
	}
	return payload, true
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}

func isWebUIStaticAssetPath(cleanPath string) bool {
	cleanPath = strings.TrimSpace(cleanPath)
	if cleanPath == "" || cleanPath == "." || cleanPath == "index.html" {
		return false
	}
	return strings.HasPrefix(cleanPath, "assets/") || path.Ext(cleanPath) != ""
}

func publicHistoryShare(cfg *config.Config, sm *session.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		token := strings.TrimSpace(r.PathValue("token"))
		if token == "" {
			writePublicHistoryShareError(w, http.StatusNotFound, "share not found")
			return
		}

		timeout := cfg.RequestTimeout
		if timeout <= 0 {
			timeout = 2 * time.Minute
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()

		requestID := "public-history-share-" + uuid.NewString()
		response, err := resolveHistoryShareAcrossAgents(ctx, sm, requestID, token)
		if err != nil {
			switch {
			case errors.Is(err, session.ErrAgentOffline):
				writePublicHistoryShareError(w, http.StatusServiceUnavailable, "agent offline")
			case errors.Is(err, context.DeadlineExceeded):
				writePublicHistoryShareError(w, http.StatusGatewayTimeout, "request timed out")
			default:
				writePublicHistoryShareError(w, http.StatusInternalServerError, "share request failed")
			}
			return
		}
		if errResp := response.GetError(); errResp != nil {
			writePublicHistoryShareError(w, handler.GatewayErrorStatus(errResp), errResp.GetMessage())
			return
		}

		share := response.GetHistoryShareResolveResp()
		if share == nil {
			writePublicHistoryShareError(w, http.StatusBadGateway, "unexpected agent response")
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"conversation_id":     share.GetConversationId(),
			"messages_json":       share.GetMessagesJson(),
			"total_message_count": share.GetTotalMessageCount(),
			"conversation":        conversationSummaryPayload(share.GetConversation()),
			"redact_tool_content": share.GetRedactToolContent(),
		})
	}
}

func writePublicHistoryShareError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"error": strings.TrimSpace(message),
	})
}

// resolveHistoryShareAcrossAgents 依次向各在线 Agent 解析公开分享 token（分享属于
// 某一台桌面端，URL 不携带 agent 信息）：首个成功命中者胜；全部未命中返回最后一个
// 分享层错误（error=99 臂）以保留 not-found 语义。≤10 Agent 且是公开低频端点，
// 串行短超时探询已足够。
func resolveHistoryShareAcrossAgents(
	ctx context.Context,
	sm *session.Manager,
	requestID string,
	token string,
) (*gatewayv2.AgentEnvelope, error) {
	agentIDs := sm.ConnectedAgentIDs()
	if len(agentIDs) == 0 {
		return nil, session.ErrAgentOffline
	}
	var lastResponse *gatewayv2.AgentEnvelope
	var lastErr error
	for index, agentID := range agentIDs {
		probeCtx := ctx
		var cancel context.CancelFunc
		if len(agentIDs) > 1 {
			// 均分剩余时限，避免第一个无响应的 Agent 吃满整个窗口。
			probeCtx, cancel = context.WithTimeout(ctx, perAgentShareTimeout(ctx, len(agentIDs)-index))
		}
		response, err := sm.AwaitUnaryResponse(probeCtx, agentID, requestID+"-"+agentID, &gatewayv2.GatewayEnvelope{
			RequestId: requestID + "-" + agentID,
			Timestamp: time.Now().Unix(),
			Payload: &gatewayv2.GatewayEnvelope_HistoryShareResolve{
				HistoryShareResolve: &gatewayv2.HistoryShareResolveRequest{
					Token: token,
				},
			},
		})
		if cancel != nil {
			cancel()
		}
		if err != nil {
			lastErr = err
			continue
		}
		if response.GetError() == nil && response.GetHistoryShareResolveResp() != nil {
			return response, nil
		}
		lastResponse = response
	}
	if lastResponse != nil {
		return lastResponse, nil
	}
	return nil, lastErr
}

func perAgentShareTimeout(ctx context.Context, remaining int) time.Duration {
	deadline, ok := ctx.Deadline()
	if !ok || remaining <= 0 {
		return 5 * time.Second
	}
	share := time.Until(deadline) / time.Duration(remaining)
	if share < time.Second {
		return time.Second
	}
	return share
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
