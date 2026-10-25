package server

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"io"
	"net/http"
	"strings"

	"github.com/liveagent/agent-gateway/internal/auth"
	"github.com/liveagent/agent-gateway/internal/config"
	"github.com/liveagent/agent-gateway/internal/handler"
	"github.com/liveagent/agent-gateway/internal/protocol/pbws"
	"github.com/liveagent/agent-gateway/internal/session"
)

// These constructors serve the desktop-owned loopback process. They do not replace production
// OAuth or expose the upstream generic login/Agent management APIs.
func NewHTTPServerWithImages(cfg *config.Config, sm *session.Manager, principal pbws.AgentAuthenticator, images *handler.ImageGateway) http.Handler {
	return NewHTTPServerWithLocalImages(cfg, sm, principal, fixedImageHub(cfg, images))
}

type localHTTPHandler struct {
	http.Handler
	base http.Handler
}

func (h *localHTTPHandler) Close() error {
	if closer, ok := h.base.(io.Closer); ok {
		return closer.Close()
	}
	return nil
}

func NewHTTPServerWithLocalImages(cfg *config.Config, sm *session.Manager, principal pbws.AgentAuthenticator, images *LocalImageHub) http.Handler {
	base := NewHTTPServer(cfg, sm, principal)
	mux := http.NewServeMux()
	imageMux := http.NewServeMux()
	imageMux.HandleFunc("GET /api/image/identity", images.identity())
	imageMux.Handle("/api/image/", images)
	imageMux.Handle("/api/image", images)
	protected := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		parts := strings.SplitN(strings.TrimSpace(r.Header.Get("Authorization")), " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || !auth.ValidateToken(parts[1], cfg.Token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		imageMux.ServeHTTP(w, r)
	})
	mux.Handle("/api/image/", protected)
	mux.Handle("/api/image", protected)
	mux.Handle("/", base)
	wrapped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/healthz" && cfg.InstanceNonce != "" {
			probe := sha256.Sum256([]byte(cfg.InstanceNonce))
			if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-LiveAgent-Instance-Probe")), []byte(hex.EncodeToString(probe[:]))) == 1 {
				w.Header().Set("X-LiveAgent-Instance", cfg.InstanceNonce)
			}
		}
		mux.ServeHTTP(w, r)
	})
	return &localHTTPHandler{Handler: wrapped, base: base}
}
