package account

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"

	"github.com/liveagent/agent-gateway/internal/objectstore"
)

func (h *HTTPHandler) registerCloudArtifacts(mux *http.ServeMux) {
	mux.HandleFunc("POST /api/web-chat/artifacts/versions/{id}/restore", h.withSession(h.restoreCloudArtifact))
	mux.HandleFunc("GET /api/web-chat/artifacts/restores/{request_id}", h.withSession(h.cloudArtifactRestoreReceipt))
	mux.HandleFunc("GET /api/web-chat/artifacts", h.withSession(h.listCloudArtifacts))
	mux.HandleFunc("GET /api/web-chat/artifacts/versions/{id}", h.withSession(h.getCloudArtifact))
	mux.HandleFunc("GET /api/web-chat/artifacts/versions/{id}/download", h.withSession(h.downloadCloudArtifact))
	mux.HandleFunc("DELETE /api/web-chat/artifacts/{family_id}", h.withSession(h.deleteCloudArtifact))
}
func cloudArtifactAPIError(err error) error {
	var apiError *APIError
	if errors.As(err, &apiError) {
		return apiError
	}
	switch {
	case errors.Is(err, ErrCloudArtifactInvalid):
		return &APIError{Status: 400, Message: "invalid artifact request"}
	case errors.Is(err, ErrCloudArtifactConflict), errors.Is(err, ErrCloudRunLeaseLost):
		return &APIError{Status: 409, Message: "artifact operation changed"}
	case errors.Is(err, ErrCloudArtifactQuota):
		return &APIError{Status: 413, Message: "artifact storage quota exceeded"}
	default:
		return cloudFileAPIError(err)
	}
}
func (h *HTTPHandler) listCloudArtifacts(w http.ResponseWriter, r *http.Request, session *Session) {
	store, err := h.service.artifactStore()
	if err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	limit := 50
	if value := r.URL.Query().Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil {
			writeError(w, cloudArtifactAPIError(ErrCloudArtifactInvalid))
			return
		}
	}
	page, err := store.ListCloudArtifacts(r.Context(), session.UserID, r.URL.Query().Get("conversation_id"), r.URL.Query().Get("family_id"), r.URL.Query().Get("before"), limit)
	if err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	public := make([]*CloudArtifactVersion, 0, len(page.Versions))
	for i := range page.Versions {
		public = append(public, publicCloudArtifact(&page.Versions[i]))
	}
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, 200, map[string]any{"versions": public, "next_cursor": page.NextCursor})
}
func (h *HTTPHandler) readCloudArtifact(ctx context.Context, userID int64, id string) (*CloudArtifactVersion, error) {
	canonical, err := canonicalCloudFileID(id)
	if err != nil {
		return nil, ErrNotFound
	}
	store, err := h.service.artifactStore()
	if err != nil {
		return nil, err
	}
	version, err := store.GetCloudArtifactVersion(ctx, userID, canonical)
	if err != nil {
		return nil, err
	}
	if version.DeletedAt != nil {
		return nil, ErrNotFound
	}
	return version, nil
}
func (h *HTTPHandler) getCloudArtifact(w http.ResponseWriter, r *http.Request, session *Session) {
	version, err := h.readCloudArtifact(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, 200, map[string]any{"version": publicCloudArtifact(version)})
}
func (h *HTTPHandler) downloadCloudArtifact(w http.ResponseWriter, r *http.Request, session *Session) {
	version, err := h.readCloudArtifact(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	if version.State != CloudArtifactReady {
		writeError(w, cloudArtifactAPIError(ErrCloudArtifactConflict))
		return
	}
	provider, err := h.service.cloudFileProvider()
	if err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	if err = acquireCloudFileSlot(r.Context(), provider.downloads); err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	defer func() { <-provider.downloads }()
	staged, err := os.CreateTemp("", "zeroagent-artifact-download-*")
	if err != nil {
		writeError(w, cloudArtifactAPIError(objectstore.ErrUnavailable))
		return
	}
	defer func() { _ = staged.Close(); _ = os.Remove(staged.Name()) }()
	if err = verifyCloudArtifactObject(r.Context(), provider.objects, version, staged); err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	if _, err = staged.Seek(0, 0); err != nil {
		writeError(w, cloudArtifactAPIError(objectstore.ErrUnavailable))
		return
	}
	valid := func() bool {
		if !h.cloudViewerValid(r.Context(), session) {
			return false
		}
		current, err := h.readCloudArtifact(r.Context(), session.UserID, version.ID)
		return err == nil && current.State == CloudArtifactReady && current.SHA256 == version.SHA256
	}
	if !valid() {
		writeError(w, cloudArtifactAPIError(ErrNotFound))
		return
	}
	cloudFileResponseHeaders(w, nil)
	w.Header().Set("Content-Type", version.MIME)
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": version.Name}))
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	http.ServeContent(w, r, version.Name, version.CreatedAt, cloudFileDownloadReader{ReadSeeker: staged, valid: valid})
}
func (h *HTTPHandler) deleteCloudArtifact(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	familyID, err := canonicalCloudFileID(r.PathValue("family_id"))
	if err != nil {
		writeError(w, cloudArtifactAPIError(ErrNotFound))
		return
	}
	store, err := h.service.artifactStore()
	if err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	provider, err := h.service.cloudFileProvider()
	if err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	versions, err := store.DeleteCloudArtifactFamily(r.Context(), session.UserID, familyID)
	if err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	status := http.StatusOK
	for _, version := range versions {
		if err = provider.objects.Delete(r.Context(), version.ObjectKey); err != nil && !errors.Is(err, objectstore.ErrNotFound) {
			status = http.StatusAccepted
			continue
		}
		if version.ErrorCode == "late_write_unknown" {
			status = http.StatusAccepted
			continue
		}
		if _, err = store.UpdateCloudArtifact(r.Context(), session.UserID, version.ID, version.Version, "", 0, CloudArtifactUpdate{State: CloudArtifactDeleted}); err != nil {
			status = http.StatusAccepted
		}
	}
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, status, map[string]any{"family_id": familyID, "state": map[bool]string{true: CloudArtifactDeleted, false: CloudArtifactDeleting}[status == 200]})
}

func (h *HTTPHandler) restoreCloudArtifact(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		HeadID    string `json:"expected_head_id"`
		RequestID string `json:"client_request_id"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(&struct{}{}) != io.EOF {
		writeError(w, cloudArtifactAPIError(ErrCloudArtifactInvalid))
		return
	}
	source, err := canonicalCloudFileID(r.PathValue("id"))
	if err != nil {
		writeError(w, cloudArtifactAPIError(ErrNotFound))
		return
	}
	result, err := h.service.RestoreCloudArtifact(r.Context(), session.UserID, source, input.HeadID, input.RequestID)
	if err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, 200, map[string]any{"version": result})
}
func (h *HTTPHandler) cloudArtifactRestoreReceipt(w http.ResponseWriter, r *http.Request, session *Session) {
	result, err := h.service.CloudArtifactRestoreReceipt(r.Context(), session.UserID, r.PathValue("request_id"))
	if err != nil {
		writeError(w, cloudArtifactAPIError(err))
		return
	}
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, 200, map[string]any{"version": result})
}
