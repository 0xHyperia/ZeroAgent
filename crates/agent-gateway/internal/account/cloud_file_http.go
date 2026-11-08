package account

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/objectstore"
)

func (h *HTTPHandler) registerCloudFiles(mux *http.ServeMux) {
	h.registerCloudArtifacts(mux)
	h.registerCloudSpace(mux)
	h.registerCloudSites(mux)
	mux.HandleFunc("POST /api/web-chat/files", h.withSession(h.uploadCloudFile))
	mux.HandleFunc("GET /api/web-chat/files", h.withSession(h.listCloudFiles))
	mux.HandleFunc("GET /api/web-chat/uploads/{id}", h.withSession(h.getCloudFileUpload))
	mux.HandleFunc("GET /api/web-chat/files/{id}", h.withSession(h.getCloudFile))
	mux.HandleFunc("GET /api/web-chat/files/{id}/content", h.withSession(h.cloudFileContent))
	mux.HandleFunc("GET /api/web-chat/files/{id}/segments", h.withSession(h.cloudFileSegments))
	mux.HandleFunc("GET /api/web-chat/files/{id}/download", h.withSession(h.downloadCloudFile))
	mux.HandleFunc("DELETE /api/web-chat/files/{id}", h.withSession(h.deleteCloudFile))
}

func (h *HTTPHandler) cloudFileStore() (CloudFileStore, error) {
	store, ok := h.service.store.(CloudFileStore)
	if !ok {
		return nil, objectstore.ErrDisabled
	}
	return store, nil
}

func cloudFileAPIError(err error) error {
	status, message := http.StatusServiceUnavailable, "cloud file storage is unavailable"
	switch {
	case errors.Is(err, ErrNotFound), errors.Is(err, objectstore.ErrNotFound):
		status, message = http.StatusNotFound, "cloud file was not found"
	case errors.Is(err, ErrCloudFileInvalid), errors.Is(err, objectstore.ErrInvalidInput), errors.Is(err, objectstore.ErrInvalidKey):
		status, message = http.StatusBadRequest, "invalid cloud file request"
	case errors.Is(err, ErrCloudFileTooLarge), errors.Is(err, objectstore.ErrTooLarge):
		status, message = http.StatusRequestEntityTooLarge, "cloud file exceeds its size limit"
	case errors.Is(err, ErrCloudFileQuota):
		status, message = http.StatusConflict, "cloud file account storage limit reached"
	case errors.Is(err, ErrCloudFileBusy), errors.Is(err, objectstore.ErrThrottled):
		status, message = http.StatusTooManyRequests, "cloud file service is busy; retry later"
	case errors.Is(err, ErrCloudFileConflict):
		status, message = http.StatusConflict, "cloud file state changed; refresh before retrying"
	case errors.Is(err, objectstore.ErrIntegrity), errors.Is(err, objectstore.ErrLengthMismatch):
		status, message = http.StatusBadGateway, "cloud file integrity verification failed"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		status, message = http.StatusRequestTimeout, "cloud file operation timed out"
	}
	return &APIError{Status: status, Message: message}
}

func cloudFileResponseHeaders(w http.ResponseWriter, file *CloudFile) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if file != nil {
		w.Header().Set("ETag", fmt.Sprintf("\"%d\"", file.Version))
	}
}

// Derive the original's ID from both the authenticated owner and the upload
// request. A request ID from another account cannot reserve or read the file.
func cloudFileUploadIdentity(userID int64, uploadID string) (string, error) {
	id, err := uuid.Parse(uploadID)
	if err != nil || id.Version() != 4 || id.Variant() != uuid.RFC4122 || id.String() != uploadID {
		return "", ErrCloudFileInvalid
	}
	key := fmt.Sprintf("zeroagent:cloud-file-upload:v1:%d:%s", userID, uploadID)
	return uuid.NewSHA1(uuid.NameSpaceOID, []byte(key)).String(), nil
}

func (h *HTTPHandler) getCloudFileUpload(w http.ResponseWriter, r *http.Request, session *Session) {
	cloudFileResponseHeaders(w, nil)
	uploadID := r.PathValue("id")
	fileID, err := cloudFileUploadIdentity(session.UserID, uploadID)
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	file, err := h.readCloudFile(r.Context(), session.UserID, fileID, false)
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	cloudFileResponseHeaders(w, file)
	h.service.cloudFileCapabilities(r.Context(), file)
	writeJSON(w, http.StatusOK, map[string]any{"file": file, "upload_id": uploadID})
}

func (h *HTTPHandler) uploadCloudFile(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	provider, err := h.service.cloudFileProvider()
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	if err = acquireCloudFileSlot(r.Context(), provider.uploads); err != nil {
		w.Header().Set("Retry-After", "2")
		writeError(w, cloudFileAPIError(err))
		return
	}
	defer func() { <-provider.uploads }()
	// Includes multipart overhead; file size is independently checked below and
	// again while hashing. Multipart spools above 1 MiB to private temporary disk.
	r.Body = http.MaxBytesReader(w, r.Body, CloudFileMaxBytes+(1<<20))
	operationCtx, cancel := context.WithTimeout(r.Context(), 2*time.Minute)
	defer cancel()
	limitedBody := r.Body
	stopBodyClose := context.AfterFunc(operationCtx, func() { limitedBody.Close() })
	defer stopBodyClose()
	r = r.WithContext(operationCtx)
	if err = r.ParseMultipartForm(1 << 20); err != nil {
		if r.MultipartForm != nil {
			defer r.MultipartForm.RemoveAll()
		}
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			err = ErrCloudFileTooLarge
		} else {
			err = ErrCloudFileInvalid
		}
		writeError(w, cloudFileAPIError(err))
		return
	}
	defer r.MultipartForm.RemoveAll()
	if len(r.MultipartForm.File) != 1 || len(r.MultipartForm.File["file"]) != 1 {
		writeError(w, cloudFileAPIError(ErrCloudFileInvalid))
		return
	}
	for key, values := range r.MultipartForm.Value {
		if (key != "conversation_id" && key != "upload_id") || len(values) != 1 {
			writeError(w, cloudFileAPIError(ErrCloudFileInvalid))
			return
		}
	}
	var uploadID, fileID string
	if values, provided := r.MultipartForm.Value["upload_id"]; provided {
		uploadID = values[0]
		fileID, err = cloudFileUploadIdentity(session.UserID, uploadID)
		if err != nil {
			writeError(w, cloudFileAPIError(ErrCloudFileInvalid))
			return
		}
	}
	conversationID := r.FormValue("conversation_id")
	if conversationID != "" {
		conversationID, err = canonicalCloudFileID(conversationID)
		if err != nil {
			writeError(w, cloudFileAPIError(err))
			return
		}
		if _, err = h.service.store.GetCloudConversation(r.Context(), session.UserID, conversationID); err != nil {
			writeError(w, cloudFileAPIError(ErrNotFound))
			return
		}
	}
	header := r.MultipartForm.File["file"][0]
	if header.Size > CloudFileMaxBytes {
		writeError(w, cloudFileAPIError(ErrCloudFileTooLarge))
		return
	}
	if !validCloudFileName(header.Filename) {
		writeError(w, cloudFileAPIError(ErrCloudFileInvalid))
		return
	}
	source, err := header.Open()
	if err != nil {
		writeError(w, cloudFileAPIError(ErrCloudFileInvalid))
		return
	}
	defer source.Close()
	if !h.cloudViewerValid(r.Context(), session) {
		writeError(w, &APIError{Status: http.StatusUnauthorized, Message: "account session expired"})
		return
	}
	file, err := provider.upload(r.Context(), session.UserID, conversationID, fileID, header.Filename, source, header.Size)
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	if !h.cloudViewerValid(r.Context(), session) {
		writeError(w, &APIError{Status: http.StatusUnauthorized, Message: "account session expired"})
		return
	}
	cloudFileResponseHeaders(w, file)
	h.service.cloudFileCapabilities(r.Context(), file)
	result := map[string]any{"file": file}
	if uploadID != "" {
		result["upload_id"] = uploadID
	}
	writeJSON(w, http.StatusCreated, result)
}

func (h *HTTPHandler) listCloudFiles(w http.ResponseWriter, r *http.Request, session *Session) {
	store, err := h.cloudFileStore()
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	conversationID := r.URL.Query().Get("conversation_id")
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		limit, err = strconv.Atoi(raw)
		if err != nil || limit < 1 || limit > 100 {
			writeError(w, cloudFileAPIError(ErrCloudFileInvalid))
			return
		}
	}
	files, err := store.ListCloudFiles(r.Context(), session.UserID, conversationID, r.URL.Query().Get("before"), limit+1)
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	next := ""
	if len(files) > limit {
		files = files[:limit]
		next = files[len(files)-1].ID
	}
	if files == nil {
		files = []CloudFile{}
	}
	capabilities := make([]*CloudFile, len(files))
	for i := range files {
		capabilities[i] = &files[i]
	}
	h.service.cloudFileCapabilities(r.Context(), capabilities...)
	cloudFileResponseHeaders(w, nil)
	writeJSON(w, http.StatusOK, map[string]any{"files": files, "next_cursor": next})
}

func (h *HTTPHandler) readCloudFile(ctx context.Context, userID int64, id string, allowDeleted bool) (*CloudFile, error) {
	store, err := h.cloudFileStore()
	if err != nil {
		return nil, err
	}
	var file *CloudFile
	if allowDeleted {
		file, err = store.GetCloudFile(ctx, userID, id)
	} else {
		file, err = cloudFileMetadata(ctx, store, userID, id)
	}
	if err != nil {
		return nil, err
	}
	if !allowDeleted && file.DeletedAt != nil {
		return nil, ErrNotFound
	}
	return file, nil
}

func (h *HTTPHandler) getCloudFile(w http.ResponseWriter, r *http.Request, session *Session) {
	file, err := h.readCloudFile(r.Context(), session.UserID, r.PathValue("id"), false)
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	cloudFileResponseHeaders(w, file)
	h.service.cloudFileCapabilities(r.Context(), file)
	writeJSON(w, http.StatusOK, map[string]any{"file": file})
}

func (h *HTTPHandler) deleteCloudFile(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	provider, err := h.service.cloudFileProvider()
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	file, err := h.readCloudFile(r.Context(), session.UserID, r.PathValue("id"), true)
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	if match := r.Header.Get("If-Match"); file.DeletedAt == nil && match != "" && match != fmt.Sprintf("\"%d\"", file.Version) {
		writeError(w, cloudFileAPIError(ErrCloudFileConflict))
		return
	}
	if file.State != CloudFileDeleted {
		file, err = provider.metadata.UpdateCloudFile(r.Context(), session.UserID, file.ID, file.Version, CloudFileUpdate{State: CloudFileDeleting})
		if err == nil {
			err = h.service.cancelCloudFileParser(r.Context(), file)
		}
		if err == nil {
			file, err = provider.metadata.GetCloudFile(r.Context(), session.UserID, file.ID)
		}
		if err == nil {
			file, err = provider.deleteOriginal(r.Context(), file)
		}
		if err != nil {
			writeError(w, cloudFileAPIError(err))
			return
		}
	}
	cloudFileResponseHeaders(w, file)
	writeJSON(w, http.StatusOK, map[string]any{"file": file})
}

type cloudFileDownloadReader struct {
	io.ReadSeeker
	valid func() bool
}

func (r cloudFileDownloadReader) Read(buffer []byte) (int, error) {
	if !r.valid() {
		return 0, context.Canceled
	}
	return r.ReadSeeker.Read(buffer)
}

func (h *HTTPHandler) downloadCloudFile(w http.ResponseWriter, r *http.Request, session *Session) {
	provider, err := h.service.cloudFileProvider()
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	file, err := h.readCloudFile(r.Context(), session.UserID, r.PathValue("id"), false)
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	if file.UploadedAt == nil {
		writeError(w, cloudFileAPIError(ErrCloudFileConflict))
		return
	}
	if err = acquireCloudFileSlot(r.Context(), provider.downloads); err != nil {
		w.Header().Set("Retry-After", "2")
		writeError(w, cloudFileAPIError(err))
		return
	}
	defer func() { <-provider.downloads }()
	staged, err := provider.stageDownload(r.Context(), file)
	if err != nil {
		writeError(w, cloudFileAPIError(err))
		return
	}
	defer func() { staged.Close(); os.Remove(staged.Name()) }()
	valid := func() bool {
		if !h.cloudViewerValid(r.Context(), session) {
			return false
		}
		current, getErr := cloudFileMetadata(r.Context(), provider.metadata, session.UserID, file.ID)
		return getErr == nil && current.DeletedAt == nil && current.UploadedAt != nil
	}
	if !valid() {
		writeError(w, cloudFileAPIError(ErrNotFound))
		return
	}
	cloudFileResponseHeaders(w, file)
	w.Header().Set("Content-Type", file.MIME)
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": file.Name}))
	w.Header().Set("Content-Security-Policy", "sandbox")
	w.Header().Set("Cross-Origin-Resource-Policy", "same-origin")
	// ETag refers to the immutable original; metadata has its own version ETag.
	w.Header().Set("ETag", "\""+strings.ToLower(file.SHA256)+"\"")
	http.ServeContent(w, r, file.Name, file.CreatedAt, cloudFileDownloadReader{ReadSeeker: staged, valid: valid})
}
