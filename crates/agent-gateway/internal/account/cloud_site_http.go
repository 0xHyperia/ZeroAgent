package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudsite"
)

func (h *HTTPHandler) registerCloudSites(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/web-chat/sites/config", h.withSession(h.cloudSiteConfig))
	mux.HandleFunc("POST /api/web-chat/sites/releases/{id}", h.withSession(h.createCloudSite))
	mux.HandleFunc("GET /api/web-chat/sites/releases/{id}", h.withSession(h.getCloudSite))
	mux.HandleFunc("POST /api/web-chat/sites/releases/{id}/preview", h.withSession(h.previewCloudSite))
	mux.HandleFunc("POST /api/web-chat/sites/releases/{id}/shares", h.withSession(h.shareCloudSite))
	mux.HandleFunc("GET /api/web-chat/sites/families/{id}/shares", h.withSession(h.listCloudSiteShares))
	mux.HandleFunc("DELETE /api/web-chat/sites/grants/{id}", h.withSession(h.revokeCloudSite))
}
func cloudSiteAPIError(err error) error {
	switch {
	case errors.Is(err, ErrCloudSiteInvalid), errors.Is(err, cloudsite.ErrInvalid):
		return &APIError{Status: 400, Message: "invalid or unsupported static site bundle or access request"}
	case errors.Is(err, ErrCloudSiteConflict):
		return &APIError{Status: 409, Message: "site or access grant changed; reload before retrying"}
	default:
		return cloudArtifactAPIError(err)
	}
}
func decodeCloudSiteRequest(w http.ResponseWriter, r *http.Request, out any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(out) != nil || d.Decode(&struct{}{}) != io.EOF {
		writeError(w, cloudSiteAPIError(ErrCloudSiteInvalid))
		return false
	}
	return true
}
func (h *HTTPHandler) cloudSiteConfig(w http.ResponseWriter, r *http.Request, _ *Session) {
	_, err := h.service.siteProvider()
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, 200, map[string]bool{"enabled": err == nil})
}
func (h *HTTPHandler) createCloudSite(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		EntryPoint string `json:"entry_point"`
	}
	if !decodeCloudSiteRequest(w, r, &input) {
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	release, err := h.service.CreateCloudSiteRelease(ctx, session, r.PathValue("id"), input.EntryPoint)
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, 200, map[string]any{"release": release})
}
func (h *HTTPHandler) getCloudSite(w http.ResponseWriter, r *http.Request, session *Session) {
	p, err := h.service.siteProvider()
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	release, err := p.store.GetCloudSiteRelease(r.Context(), session.UserID, r.PathValue("id"))
	if err == nil {
		_, err = h.service.siteArtifact(r.Context(), release)
	}
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, 200, map[string]any{"release": release})
}
func (h *HTTPHandler) previewCloudSite(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		RequestID string `json:"request_id"`
	}
	if !decodeCloudSiteRequest(w, r, &input) {
		return
	}
	h.issueCloudSite(w, r, session, input.RequestID, "private", 10*time.Minute)
}
func (h *HTTPHandler) shareCloudSite(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		RequestID        string `json:"request_id"`
		ExpiresInSeconds int64  `json:"expires_in_seconds"`
	}
	if !decodeCloudSiteRequest(w, r, &input) {
		return
	}
	if input.ExpiresInSeconds == 0 {
		input.ExpiresInSeconds = 7 * 24 * 3600
	}
	if input.ExpiresInSeconds < 1 || input.ExpiresInSeconds > 30*24*3600 {
		writeError(w, cloudSiteAPIError(ErrCloudSiteInvalid))
		return
	}
	h.issueCloudSite(w, r, session, input.RequestID, "share", time.Duration(input.ExpiresInSeconds)*time.Second)
}
func (h *HTTPHandler) issueCloudSite(w http.ResponseWriter, r *http.Request, session *Session, requestID, mode string, ttl time.Duration) {
	g, err := h.service.CreateCloudSiteAccess(r.Context(), session, r.PathValue("id"), requestID, mode, ttl)
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, 200, map[string]any{"grant": g})
}
func (h *HTTPHandler) listCloudSiteShares(w http.ResponseWriter, r *http.Request, session *Session) {
	p, err := h.service.siteProvider()
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	items, err := p.store.ListCloudSiteShares(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	available := []CloudSiteGrant{}
	for _, g := range items {
		release, err := p.store.GetCloudSiteRelease(r.Context(), session.UserID, g.ReleaseID)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			writeError(w, cloudSiteAPIError(err))
			return
		}
		if _, err = h.service.siteArtifact(r.Context(), release); errors.Is(err, ErrNotFound) {
			continue
		} else if err != nil {
			writeError(w, cloudSiteAPIError(err))
			return
		}
		g.URL, err = siteGrantURL(p, &g, release.Manifest.EntryPoint)
		if err != nil {
			writeError(w, cloudSiteAPIError(err))
			return
		}
		available = append(available, g)
	}
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, 200, map[string]any{"shares": available})
}
func (h *HTTPHandler) revokeCloudSite(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		Version int64 `json:"version"`
	}
	if !decodeCloudSiteRequest(w, r, &input) {
		return
	}
	p, err := h.service.siteProvider()
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	g, err := p.store.RevokeCloudSiteGrant(r.Context(), session.UserID, r.PathValue("id"), input.Version)
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, 200, map[string]any{"grant": g})
}

// Mount on the dedicated numeric-loopback content listener only. This handler
// ignores main-site cookies, Authorization and all forwarded-host headers.
func (s *Service) CloudSiteContentHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), document-domain=()")
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
		if r.Method != "GET" && r.Method != "HEAD" {
			w.Header().Set("Allow", "GET, HEAD")
			w.WriteHeader(405)
			return
		}
		parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/v/"), "/", 2)
		if !strings.HasPrefix(r.URL.Path, "/v/") || len(parts) != 2 {
			http.NotFound(w, r)
			return
		}
		p, err := s.siteProvider()
		if err != nil {
			http.NotFound(w, r)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		release, a, err := s.siteAccess(ctx, p, parts[0], r.Host)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		name := parts[1]
		if name == "" {
			// Keep the already verified capability, encoding only the asset path.
			location := (&url.URL{Path: "/v/" + parts[0] + "/" + release.Manifest.EntryPoint}).String()
			http.Redirect(w, r, location, http.StatusTemporaryRedirect)
			return
		}
		if !cloudsite.ValidPath(name) {
			http.NotFound(w, r)
			return
		}
		var entry *cloudsite.Entry
		for i := range release.Manifest.Entries {
			if release.Manifest.Entries[i].Path == name {
				entry = &release.Manifest.Entries[i]
				break
			}
		}
		if entry == nil {
			http.NotFound(w, r)
			return
		}
		// Cache hits still decompress an entry and may hold its response bytes
		// for a slow client. Bound that work independently of S3 download slots.
		if err = acquireCloudFileSlot(ctx, p.renders); err != nil {
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			return
		}
		defer func() { <-p.renders }()
		data, err := s.siteArchive(ctx, p, a)
		if err != nil {
			w.WriteHeader(503)
			return
		}
		body, err := cloudsite.ReadEntry(bytes.NewReader(data), int64(len(data)), *entry)
		if err != nil {
			w.WriteHeader(502)
			return
		}
		valid := func() bool {
			_, current, err := s.siteAccess(ctx, p, parts[0], r.Host)
			return err == nil && current.ID == a.ID && current.SHA256 == a.SHA256
		}
		if !valid() {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Security-Policy", "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src blob:; manifest-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors "+p.config.AppOrigin+"; sandbox allow-scripts allow-same-origin allow-downloads")
		w.Header().Set("Content-Type", entry.MIME)
		http.ServeContent(w, r, name, time.Time{}, cloudFileDownloadReader{ReadSeeker: bytes.NewReader(body), valid: valid})
	})
}
