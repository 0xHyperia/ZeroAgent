package account

import (
	"encoding/json"
	"net/http"
	"strconv"
)

func (h *HTTPHandler) cloudFileSegments(w http.ResponseWriter, r *http.Request, session *Session) {
	file, err := h.service.ownedReadyCloudFile(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, err)
		return
	}
	start := 0
	limit := 100
	if value := r.URL.Query().Get("offset"); value != "" {
		start, err = strconv.Atoi(value)
		if err != nil {
			writeError(w, cloudFileAPIError(ErrCloudFileInvalid))
			return
		}
	}
	if value := r.URL.Query().Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
	}
	if err != nil || start < 0 || start > len(file.Segments) || limit < 1 || limit > 100 {
		writeError(w, cloudFileAPIError(ErrCloudFileInvalid))
		return
	}
	end := start + limit
	if end > len(file.Segments) {
		end = len(file.Segments)
	}
	selected := []CloudFileSegment{}
	size := 0
	for _, segment := range file.Segments[start:end] {
		encoded, _ := json.Marshal(segment)
		if size+len(encoded) > 256<<10 {
			break
		}
		size += len(encoded)
		selected = append(selected, segment)
	}
	truncated := false
	warnings := []string{}
	if file.ParseTask != nil {
		truncated = file.ParseTask.Truncated
		warnings = file.ParseTask.Warnings
	}
	cloudFileResponseHeaders(w, file)
	writeJSON(w, http.StatusOK, map[string]any{"file_id": file.ID, "sha256": file.SHA256, "offset": start, "total_segments": len(file.Segments), "next_offset": start + len(selected), "segments": selected, "truncated": truncated, "warnings": warnings})
}
