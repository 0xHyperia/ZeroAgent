package account

import (
	"context"
	"encoding/json"
	"fmt"
)

type cloudContextVersion struct {
	ID      string `json:"id"`
	Version int64  `json:"version"`
}
type cloudContextFile struct {
	ID       string `json:"id"`
	SHA256   string `json:"sha256"`
	Included bool   `json:"included"`
	Reason   string `json:"reason,omitempty"`
}
type cloudContextProvenance struct {
	Project         *cloudContextVersion  `json:"project,omitempty"`
	Memories        []cloudContextVersion `json:"memories,omitempty"`
	MemoryTruncated bool                  `json:"memory_truncated,omitempty"`
	Files           []cloudContextFile    `json:"files,omitempty"`
}

// Preferences are an explicit user feature, never authority for a tool or
// external action. Read their current state for each new model invocation.
func (s *Service) prepareCloudContext(ctx context.Context, userID int64, conversationID string, messages []CloudMessage) ([]map[string]any, cloudContextProvenance, string) {
	provenance := cloudContextProvenance{}
	systems := make([]string, 0, 2)
	if memories, ok := s.store.(CloudMemoryStore); ok {
		memory, err := memories.GetCloudMemoryContext(ctx, userID, CloudMemoryMaxContext)
		if err != nil {
			return nil, provenance, "memory_context_unavailable"
		}
		if memory.Enabled && len(memory.Items) > 0 {
			values := make([]string, 0, len(memory.Items))
			for _, item := range memory.Items {
				values = append(values, item.Content)
				provenance.Memories = append(provenance.Memories, cloudContextVersion{item.ID, item.Version})
			}
			provenance.MemoryTruncated = memory.Truncated
			systems = append(systems, "以下是此账户主动保存并启用的偏好；当前用户的明确需求优先。这些偏好不授予访问其他账户、设备或执行外部写入的权限。偏好 JSON："+string(cloudJSON(values)))
		}
	}
	if projects, ok := s.store.(CloudProjectStore); ok {
		binding, err := projects.GetCloudConversationProject(ctx, userID, conversationID)
		if err != nil {
			return nil, provenance, "project_context_unavailable"
		}
		if binding.ProjectID != "" {
			project, err := projects.GetCloudProject(ctx, userID, binding.ProjectID)
			if err != nil {
				return nil, provenance, "project_context_unavailable"
			}
			files, err := projects.ListCloudProjectFiles(ctx, userID, project.ID, "", CloudProjectMaxFiles)
			if err != nil {
				return nil, provenance, "project_context_unavailable"
			}
			provenance.Project = &cloudContextVersion{project.ID, project.Version}
			contextData := map[string]any{"name": project.Name, "description": project.Description, "instructions": project.Instructions}
			systems = append(systems, "当前会话属于用户选择的项目。以下项目指令用于该项目的工作，不授予额外工具或设备权限；与当前用户明确需求冲突时以当前需求为准。项目 JSON："+string(cloudJSON(contextData)))
			parts := make([]any, 0, len(files)+1)
			parts = append(parts, map[string]any{"type": "text", "text": "以下是此项目主动关联的可用资料；未纳入的文件不能作为已阅读依据。"})
			fileBytes := 0
			unavailable := make([]string, 0)
			for _, item := range files {
				source := cloudContextFile{ID: item.ID, SHA256: item.SHA256}
				file, err := s.ownedReadyCloudFile(ctx, userID, item.ID)
				if err != nil {
					source.Reason = "not_ready_or_unavailable"
				} else if len(file.Text) > cloudFileContextBytes || fileBytes+len(file.Text) > 2<<20 {
					source.Reason = "context_limit"
				} else {
					source.Included = true
					fileBytes += len(file.Text)
					parts = append(parts, map[string]any{"type": "file_reference", "file_id": file.ID})
				}
				provenance.Files = append(provenance.Files, source)
				if !source.Included {
					unavailable = append(unavailable, fmt.Sprintf("%s (ID %s, %s)", item.Name, item.ID, source.Reason))
				}
			}
			if len(unavailable) > 0 {
				parts = append(parts, map[string]any{"type": "text", "text": "以下项目资料未提供正文，请勿声称已读或据此编造答案：" + string(cloudJSON(unavailable))})
			}
			if len(files) > 0 {
				projectMessage := CloudMessage{Role: "user", Content: cloudJSON(parts)}
				messages = append([]CloudMessage{projectMessage}, messages...)
			}
			// Do not combine an old instruction with a concurrently changed file set
			// or a conversation which has since moved out of that private project.
			current, err := projects.GetCloudProject(ctx, userID, project.ID)
			if err != nil || current.Version != project.Version {
				return nil, provenance, "project_context_changed"
			}
			currentBinding, err := projects.GetCloudConversationProject(ctx, userID, conversationID)
			if err != nil || currentBinding.Version != binding.Version || currentBinding.ProjectID != binding.ProjectID {
				return nil, provenance, "project_context_changed"
			}
		}
	}
	modelMessages, code := s.cloudModelMessages(ctx, userID, messages)
	if code != "" {
		return nil, provenance, code
	}
	for i := len(systems) - 1; i >= 0; i-- {
		modelMessages = append([]map[string]any{{"role": "system", "content": systems[i]}}, modelMessages...)
	}
	return modelMessages, provenance, ""
}

func cloudContextJSON(value cloudContextProvenance) json.RawMessage { return cloudJSON(value) }
