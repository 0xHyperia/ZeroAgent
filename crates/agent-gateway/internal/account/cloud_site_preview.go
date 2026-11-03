package account

import (
	"context"
	_ "embed"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/liveagent/agent-gateway/internal/cloudsite"
)

//go:embed cloud_site_preview.js
var cloudSitePreviewScript string

func sitePreviewDocument(body []byte, origin string) []byte {
	encoded, _ := json.Marshal(origin)
	// Only application-owned code/configuration is inserted; site bytes are unchanged.
	bridge := "<script>(" + cloudSitePreviewScript + ")(" + string(encoded) + ");</script>"
	text := string(body)
	lower := strings.ToLower(text)
	if at := strings.LastIndex(lower, "</body>"); at >= 0 {
		return []byte(text[:at] + bridge + text[at:])
	}
	if at := strings.LastIndex(lower, "</html>"); at >= 0 {
		return []byte(text[:at] + bridge + text[at:])
	}
	return append(body, []byte(bridge)...)
}

func (h *HTTPHandler) cloudSiteCover(w http.ResponseWriter, r *http.Request, session *Session) {
	p, err := h.service.siteProvider()
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	release, err := p.store.GetCloudSiteRelease(ctx, session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	a, err := h.service.siteArtifact(ctx, release)
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	if err = acquireCloudFileSlot(ctx, p.renders); err != nil {
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	defer func() { <-p.renders }()
	archive, err := h.service.siteArchive(ctx, p, a)
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	cover, err := cloudsite.Cover(archive, release.Manifest)
	if err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	if _, err = h.service.siteArtifact(ctx, release); err != nil {
		writeError(w, cloudSiteAPIError(err))
		return
	}
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, 200, map[string]string{"html": cover})
}
