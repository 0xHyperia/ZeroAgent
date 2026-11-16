package server

import (
	"context"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	v2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

const imageAccountHeader = "X-ZeroAgent-Image-Account"

func deviceImageError(w http.ResponseWriter, status int, code string) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]any{"version": "kbrain.image.v1", "error": map[string]any{
		"code": code, "message": code, "retryable": status == 502 || status == 504, "requestId": uuid.NewString(),
	}})
}

func deviceImageRoute(method, path string) bool {
	suffix, ok := strings.CutPrefix(path, "/api/image/")
	if !ok {
		return false
	}
	parts := strings.Split(suffix, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.ContainsAny(part, "\\%?#\r\n") {
			return false
		}
	}
	if len(parts) == 1 {
		switch parts[0] {
		case "health", "identity", "targets":
			return method == http.MethodGet
		case "assets":
			return method == http.MethodPost
		case "jobs", "projects":
			return method == http.MethodGet || method == http.MethodPost
		}
	}
	if len(parts) == 2 {
		switch parts[0] {
		case "jobs":
			return method == http.MethodGet || method == http.MethodDelete
		case "projects":
			return method == http.MethodGet || method == http.MethodPatch || method == http.MethodDelete
		}
	}
	if len(parts) == 3 {
		return parts[0] == "jobs" && (parts[2] == "events" && method == http.MethodGet ||
			parts[2] == "cancel" && method == http.MethodPost) ||
			parts[0] == "assets" && parts[2] == "content" && (method == http.MethodGet || method == http.MethodHead)
	}
	return false
}

func serveDeviceImage(w http.ResponseWriter, r *http.Request, sm *session.Manager, agentID string, userID int64, expires time.Time, authorized func(context.Context) bool) {
	w.Header().Set("Cache-Control", "no-store")
	if !deviceImageRoute(r.Method, r.URL.Path) || strings.Contains(r.URL.EscapedPath(), "%") {
		deviceImageError(w, http.StatusNotFound, "IMAGE_NOT_FOUND")
		return
	}
	owner := strconv.FormatInt(userID, 10)
	if r.URL.Path == "/api/image/identity" {
		writeJSON(w, http.StatusOK, map[string]any{"mode": "device", "ownerId": owner, "backendId": agentID})
		return
	}
	query := r.URL.Query()
	if ids := query["backendId"]; len(ids) != 1 || ids[0] != agentID {
		deviceImageError(w, http.StatusForbidden, "IMAGE_FORBIDDEN")
		return
	}
	query.Del("backendId")
	path := r.URL.Path
	if encoded := query.Encode(); encoded != "" {
		path += "?" + encoded
	}
	timeout := 120 * time.Second
	if strings.HasSuffix(r.URL.Path, "/events") {
		timeout = 30 * time.Minute
	}
	if cap := time.Now().Add(timeout); cap.Before(expires) {
		expires = cap
	}
	ctx, cancel := context.WithDeadline(r.Context(), expires)
	defer cancel()
	streamID := "image-" + uuid.NewString()
	stream, err := sm.AcquirePrivateLoopback(agentID, streamID)
	if err != nil {
		deviceImageError(w, http.StatusBadGateway, "IMAGE_BACKEND_UNAVAILABLE")
		return
	}
	defer stream.Release()

	limit := int64(4 << 20)
	if r.URL.Path == "/api/image/assets" {
		limit = 21 << 20
	}
	response := http.NewResponseController(w)
	_ = response.SetReadDeadline(expires)
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	_ = response.SetReadDeadline(time.Time{})
	if err != nil {
		var sizeError *http.MaxBytesError
		if errors.As(err, &sizeError) {
			deviceImageError(w, http.StatusRequestEntityTooLarge, "IMAGE_TOO_LARGE")
		} else {
			deviceImageError(w, http.StatusBadRequest, "IMAGE_INVALID_REQUEST")
		}
		return
	}
	if ctx.Err() != nil || !authorized(ctx) {
		deviceImageError(w, http.StatusUnauthorized, "IMAGE_AUTH_REQUIRED")
		return
	}
	headers := []*v2.TunnelHeader{{Name: imageAccountHeader, Value: owner}}
	for _, name := range []string{"Accept", "Content-Type", "Idempotency-Key", "Last-Event-ID"} {
		if value := r.Header.Get(name); value != "" && len(value) <= 4096 {
			headers = append(headers, &v2.TunnelHeader{Name: name, Value: value})
		}
	}
	send := func(ctx context.Context, frame *v2.TunnelFrame) error {
		frame.StreamId = streamID
		return stream.SendPrivateLoopback(ctx, frame)
	}
	if err := send(ctx, &v2.TunnelFrame{
		Kind:   v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_START,
		Method: r.Method, Path: path, Headers: headers,
	}); err != nil {
		deviceImageError(w, http.StatusBadGateway, "IMAGE_BACKEND_UNAVAILABLE")
		return
	}
	completed := false
	defer func() {
		cancel()
		if !completed {
			cleanup, stop := context.WithTimeout(context.Background(), time.Second)
			defer stop()
			_ = send(cleanup, &v2.TunnelFrame{Kind: v2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL})
		}
	}()
	sendDone := make(chan error, 1)
	go func() {
		for len(body) > 0 {
			size := min(len(body), tunnelBodyChunkSize)
			data := body[:size]
			body = body[size:]
			if err := send(ctx, &v2.TunnelFrame{Kind: v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_BODY, Body: data}); err != nil {
				sendDone <- err
				return
			}
		}
		sendDone <- send(ctx, &v2.TunnelFrame{Kind: v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_REQUEST_END})
	}()

	started := false
	fail := func(status int, code string) {
		if started {
			panic(http.ErrAbortHandler)
		}
		deviceImageError(w, status, code)
	}
	check := time.NewTicker(time.Second)
	defer check.Stop()
	for {
		select {
		case <-ctx.Done():
			fail(http.StatusGatewayTimeout, "IMAGE_TIMEOUT")
			return
		case <-stream.Done():
			fail(http.StatusBadGateway, "IMAGE_BACKEND_UNAVAILABLE")
			return
		case <-stream.PrivateAgentDone():
			fail(http.StatusBadGateway, "IMAGE_BACKEND_UNAVAILABLE")
			return
		case err := <-sendDone:
			sendDone = nil
			if err != nil {
				fail(http.StatusBadGateway, "IMAGE_BACKEND_UNAVAILABLE")
				return
			}
		case <-check.C:
			if !authorized(ctx) {
				fail(http.StatusUnauthorized, "IMAGE_AUTH_REQUIRED")
				return
			}
		case frame := <-stream.Frames():
			switch frame.GetKind() {
			case v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_START:
				if !authorized(ctx) {
					fail(http.StatusUnauthorized, "IMAGE_AUTH_REQUIRED")
					return
				}
				status := int(frame.GetStatus())
				if started || status < 200 || status >= 600 || status >= 300 && status < 400 ||
					!deviceImageResponseHeaders(w, frame.GetHeaders(), status) {
					fail(http.StatusBadGateway, "IMAGE_BACKEND_UNAVAILABLE")
					return
				}
				started = true
				w.WriteHeader(status)
				flushTunnelResponse(w)
			case v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_BODY:
				if !started || len(frame.GetBody()) > tunnelBodyChunkSize {
					fail(http.StatusBadGateway, "IMAGE_BACKEND_UNAVAILABLE")
					return
				}
				if _, err := w.Write(frame.GetBody()); err != nil {
					return
				}
				flushTunnelResponse(w)
			case v2.TunnelFrameKind_TUNNEL_FRAME_KIND_HTTP_RESPONSE_END:
				if !started {
					fail(http.StatusBadGateway, "IMAGE_BACKEND_UNAVAILABLE")
				}
				completed = true
				return
			default:
				fail(http.StatusBadGateway, "IMAGE_BACKEND_UNAVAILABLE")
				return
			}
		}
	}
}

func deviceImageResponseHeaders(w http.ResponseWriter, headers []*v2.TunnelHeader, status int) bool {
	for _, header := range headers {
		if !strings.EqualFold(header.GetName(), "Content-Type") {
			continue
		}
		value, _, err := mime.ParseMediaType(header.GetValue())
		if err != nil {
			return false
		}
		switch value {
		case "application/json", "text/event-stream", "image/jpeg", "image/png", "image/webp":
			w.Header().Set("Content-Type", value)
			w.Header().Set("X-Content-Type-Options", "nosniff")
			return true
		default:
			return false
		}
	}
	return status == http.StatusNoContent
}
