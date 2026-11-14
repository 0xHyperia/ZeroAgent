package server

import (
	"context"
	"net/http"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	v2 "github.com/liveagent/agent-gateway/internal/proto/v2"
	"github.com/liveagent/agent-gateway/internal/session"
)

const privateLoopbackChunk = 64 * 1024

func privateDeviceLoopback(w http.ResponseWriter, r *http.Request, sm *session.Manager, agentID string, expires time.Time, authorized func(context.Context) bool) {
	port, err := strconv.ParseUint(r.URL.Query().Get("port"), 10, 16)
	if err != nil || port < 1024 || r.Header.Get("Origin") != "" || !websocket.IsWebSocketUpgrade(r) {
		writeTunnelError(w, http.StatusBadRequest, "invalid private loopback request")
		return
	}
	streamID := "private-" + uuid.NewString()
	lease, err := sm.AcquirePrivateLoopback(agentID, streamID)
	if err != nil {
		writeTunnelError(w, http.StatusBadGateway, "selected device is unavailable")
		return
	}
	defer lease.Release()
	send := func(kind v2.TunnelFrameKind, data []byte) error {
		sendCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		return lease.SendPrivateLoopback(sendCtx, &v2.TunnelFrame{StreamId: streamID, Kind: kind, Body: data})
	}
	defer func() { _ = send(v2.TunnelFrameKind_TUNNEL_FRAME_KIND_CANCEL, nil) }()
	startCtx, stopStart := context.WithTimeout(r.Context(), 5*time.Second)
	err = lease.SendPrivateLoopback(startCtx, &v2.TunnelFrame{
		StreamId: streamID, Kind: v2.TunnelFrameKind_TUNNEL_FRAME_KIND_PRIVATE_OPEN,
		TargetUrl: "http://127.0.0.1:" + strconv.FormatUint(port, 10),
	})
	stopStart()
	if err != nil {
		writeTunnelError(w, http.StatusBadGateway, "selected device is unavailable")
		return
	}
	ctx, cancel := context.WithDeadline(r.Context(), expires)
	defer cancel()
	timer := time.NewTimer(35 * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-timer.C:
		writeTunnelError(w, http.StatusGatewayTimeout, "device did not approve or open the port")
		return
	case <-lease.Done():
		writeTunnelError(w, http.StatusBadGateway, "device connection closed")
		return
	case <-lease.PrivateAgentDone():
		writeTunnelError(w, http.StatusBadGateway, "device connection closed")
		return
	case frame := <-lease.Frames():
		if frame.GetKind() != v2.TunnelFrameKind_TUNNEL_FRAME_KIND_PRIVATE_READY {
			writeTunnelError(w, http.StatusBadGateway, "port unavailable or declined on the device")
			return
		}
	}
	if !authorized(ctx) {
		writeTunnelError(w, http.StatusUnauthorized, "device selection expired")
		return
	}
	upgrader := websocket.Upgrader{}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer func() { _ = ws.Close() }()
	ws.SetReadLimit(privateLoopbackChunk)
	data := make(chan []byte, 8)
	go func() {
		defer close(data)
		for {
			kind, body, err := ws.ReadMessage()
			if err != nil || kind != websocket.BinaryMessage {
				return
			}
			select {
			case data <- body:
			case <-ctx.Done():
				return
			}
		}
	}()
	clock := time.NewTicker(3 * time.Second)
	defer clock.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-lease.Done():
			return
		case <-lease.PrivateAgentDone():
			return
		case <-clock.C:
			if !authorized(ctx) {
				return
			}
		case body, ok := <-data:
			if !ok {
				return
			}
			kind := v2.TunnelFrameKind_TUNNEL_FRAME_KIND_PRIVATE_DATA
			if len(body) == 0 {
				kind = v2.TunnelFrameKind_TUNNEL_FRAME_KIND_PRIVATE_END
			}
			if send(kind, body) != nil {
				return
			}
		case frame := <-lease.Frames():
			kind := frame.GetKind()
			body := frame.GetBody()
			if kind == v2.TunnelFrameKind_TUNNEL_FRAME_KIND_PRIVATE_END {
				return
			}
			if kind != v2.TunnelFrameKind_TUNNEL_FRAME_KIND_PRIVATE_DATA || len(body) == 0 || len(body) > privateLoopbackChunk {
				return
			}
			_ = ws.SetWriteDeadline(time.Now().Add(8 * time.Second))
			if ws.WriteMessage(websocket.BinaryMessage, body) != nil {
				return
			}
		}
	}
}
