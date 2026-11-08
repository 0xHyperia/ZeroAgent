package account

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

func (h *HTTPHandler) registerCloudBranches(mux *http.ServeMux) {
	h.registerCloudConversationManagement(mux)
	mux.HandleFunc("POST /api/web-chat/conversations/{id}/branch", h.withSession(h.branchCloudConversation))
	mux.HandleFunc("GET /api/web-chat/branches/{request_id}", h.withSession(h.getCloudBranch))
	mux.HandleFunc("GET /api/web-chat/conversations/{id}/export", h.withSession(h.exportCloudConversation))
}

func (h *HTTPHandler) getCloudBranch(w http.ResponseWriter, r *http.Request, session *Session) {
	store, ok := h.service.store.(CloudBranchStore)
	if !ok {
		writeError(w, &APIError{Status: 503, Message: "conversation branching is unavailable"})
		return
	}
	requestID := r.PathValue("request_id")
	if requestID == "" || len(requestID) > 128 {
		writeError(w, cloudRunAPIError(ErrNotFound))
		return
	}
	branch, err := store.GetCloudBranch(r.Context(), session.UserID, requestID)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{"branch": branch})
}

func (h *HTTPHandler) branchCloudConversation(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	store, ok := h.service.store.(CloudBranchStore)
	if !ok {
		writeError(w, &APIError{Status: 503, Message: "conversation branching is unavailable"})
		return
	}
	var input CloudBranchInput
	r.Body = http.MaxBytesReader(w, r.Body, maxWebChatBodyBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
		return
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		writeError(w, cloudRunAPIError(ErrCloudRunInvalid))
		return
	}
	branch, created, err := store.CreateCloudBranch(r.Context(), session.UserID, r.PathValue("id"), input)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	status := http.StatusOK
	if created {
		status = http.StatusCreated
	}
	writeJSON(w, status, map[string]any{"branch": branch, "created": created})
}

func (h *HTTPHandler) exportCloudConversation(w http.ResponseWriter, r *http.Request, session *Session) {
	format := r.URL.Query().Get("format")
	if format == "" {
		format = "markdown"
	}
	if format != "markdown" && format != "json" {
		writeError(w, &APIError{Status: 400, Message: "unsupported export format"})
		return
	}
	conversation, err := h.service.store.GetCloudConversation(r.Context(), session.UserID, r.PathValue("id"))
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	messages, err := h.service.CloudMessages(r.Context(), session.UserID, conversation.ID)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	total := 0
	for _, message := range messages {
		total += len(message.Content)
		if total > CloudRunMaxInputBytes {
			writeError(w, cloudRunAPIError(ErrCloudRunLimit))
			return
		}
	}
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if format == "json" {
		w.Header().Set("Content-Disposition", `attachment; filename="zeroagent-conversation.json"`)
		writeJSON(w, http.StatusOK, map[string]any{"schema_version": 1, "conversation": conversation, "messages": messages})
		return
	}
	var output strings.Builder
	fmt.Fprintf(&output, "# %s\n\n", strings.ReplaceAll(conversation.Title, "\n", " "))
	for _, message := range messages {
		label := "ZeroAgent"
		if message.Role == "user" {
			label = "用户"
		}
		fmt.Fprintf(&output, "## %s\n\n", label)
		var text string
		if json.Unmarshal(message.Content, &text) == nil {
			output.WriteString(text)
		} else {
			var parts []map[string]any
			_ = json.Unmarshal(message.Content, &parts)
			for _, part := range parts {
				switch part["type"] {
				case "text":
					value, _ := part["text"].(string)
					output.WriteString(value)
				case "file_reference":
					fmt.Fprintf(&output, "\n附件：%v（文件 ID：%v）\n", part["name"], part["file_id"])
				case "artifact_reference":
					fmt.Fprintf(&output, "\n成果：%v（版本：%v，版本 ID：%v）\n", part["name"], part["number"], part["version_id"])
				case "image_url":
					output.WriteString("\n[图片附件]\n")
				}
			}
		}
		writeCloudPresentationMarkdown(&output, message.Presentation)
		output.WriteString("\n\n")
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="zeroagent-conversation.md"`)
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(output.String()))
}
