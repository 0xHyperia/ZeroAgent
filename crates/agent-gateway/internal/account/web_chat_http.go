package account

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
)

const maxWebChatBodyBytes = 32 << 20

func (h *HTTPHandler) registerWebChat(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/web-chat/generation-settings", h.withSession(h.cloudGenerationSettingsResource))
	mux.HandleFunc("PUT /api/web-chat/generation-settings", h.withSession(h.cloudGenerationSettingsResource))
	h.registerCloudExtensions(mux)
	h.registerCloudRuns(mux)
	h.registerCloudBranches(mux)
	h.registerCloudProjects(mux)
	h.registerCloudMemories(mux)
	h.registerCloudResearchSources(mux)
	h.registerCloudFiles(mux)
	mux.HandleFunc("GET /api/web-chat/image-settings", h.withSession(h.cloudImageSettingsResource))
	mux.HandleFunc("PUT /api/web-chat/image-settings", h.withSession(h.cloudImageSettingsResource))
	mux.HandleFunc("GET /api/web-settings", h.withSession(h.getWebSettings))
	mux.HandleFunc("PATCH /api/web-settings", h.withSession(h.updateWebSettings))
	mux.HandleFunc("GET /api/web-chat/model-limits", h.withSession(h.cloudModelLimitsResource))
	mux.HandleFunc("PUT /api/web-chat/model-limits", h.withSession(h.cloudModelLimitsResource))
	mux.HandleFunc("GET /api/web-chat/conversations", h.withSession(h.listCloudConversations))
	mux.HandleFunc("GET /api/web-chat/conversations/page", h.withSession(h.listCloudConversationPage))
	mux.HandleFunc("POST /api/web-chat/conversations", h.withSession(h.createCloudConversation))
	mux.HandleFunc("PATCH /api/web-chat/conversations/{id}", h.withSession(h.updateCloudConversation))
	mux.HandleFunc("DELETE /api/web-chat/conversations/{id}", h.withSession(h.deleteCloudConversation))
	mux.HandleFunc("GET /api/web-chat/conversations/{id}/messages", h.withSession(h.listCloudMessages))
	mux.HandleFunc("GET /api/web-chat/conversations/{id}/messages/{message_id}", h.withSession(h.getCloudHistoryMessage))
	mux.HandleFunc("GET /api/web-chat/conversations/{id}/history", h.withSession(h.listCloudHistoryHeads))
	mux.HandleFunc("POST /api/web-chat/completions", h.withSession(h.streamCloudCompletion))
	mux.HandleFunc("GET /api/web-chat/provider-keys/{id}/models", h.withSession(h.webProviderModels))
}

func (h *HTTPHandler) webProviderModels(w http.ResponseWriter, r *http.Request, session *Session) {
	keyID, err := strconv.ParseInt(strings.TrimSpace(r.PathValue("id")), 10, 64)
	if err != nil || keyID <= 0 {
		writeError(w, &APIError{Status: http.StatusBadRequest, Message: "invalid API key ID"})
		return
	}
	models, err := h.service.WebProviderModels(r.Context(), session, keyID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"models": models})
}

func (h *HTTPHandler) updateCloudConversation(w http.ResponseWriter, r *http.Request, session *Session) {
	var request struct {
		Title string `json:"title"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	conversation, err := h.service.RenameCloudConversation(
		r.Context(),
		session.UserID,
		r.PathValue("id"),
		request.Title,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversation": conversation})
}

func (h *HTTPHandler) getWebSettings(w http.ResponseWriter, r *http.Request, session *Session) {
	settings, err := h.service.WebSettings(r.Context(), session.UserID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": settings})
}

func (h *HTTPHandler) updateWebSettings(w http.ResponseWriter, r *http.Request, session *Session) {
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var request WebSettings
	if !decodeRequest(w, r, &request) {
		return
	}
	settings, err := h.service.UpdateWebSettings(r.Context(), session.UserID, request)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"settings": settings})
}

func (h *HTTPHandler) listCloudConversations(w http.ResponseWriter, r *http.Request, session *Session) {
	items, err := h.service.ListCloudConversations(r.Context(), session.UserID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"conversations": items})
}

func (h *HTTPHandler) createCloudConversation(w http.ResponseWriter, r *http.Request, session *Session) {
	var request struct {
		Model string `json:"model"`
	}
	if !decodeRequest(w, r, &request) {
		return
	}
	conversation, err := h.service.CreateCloudConversation(r.Context(), session.UserID, request.Model)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"conversation": conversation})
}

func (h *HTTPHandler) deleteCloudConversation(w http.ResponseWriter, r *http.Request, session *Session) {
	if err := h.service.DeleteCloudConversation(r.Context(), session.UserID, r.PathValue("id")); err != nil {
		writeError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *HTTPHandler) listCloudMessages(w http.ResponseWriter, r *http.Request, session *Session) {
	before, limit, err := cloudHistoryRequest(r)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	page, err := h.service.CloudHistoryPage(r.Context(), session.UserID, r.PathValue("id"), before, limit)
	if err != nil {
		writeError(w, cloudRunAPIError(err))
		return
	}
	writeCloudHistoryJSON(w, page)
}

func cloudConversationTitle(content json.RawMessage) string {
	var text string
	if json.Unmarshal(content, &text) != nil {
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(content, &parts) == nil {
			for _, part := range parts {
				if part.Type == "text" {
					text += part.Text
				}
			}
		}
	}
	text = strings.Join(strings.Fields(text), " ")
	if text == "" {
		return "新对话"
	}
	runes := []rune(text)
	if len(runes) > 48 {
		return string(runes[:48]) + "..."
	}
	return text
}
