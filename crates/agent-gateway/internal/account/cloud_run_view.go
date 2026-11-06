package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
)

// Viewer reads never load the private model request or execution credentials.
// Polling needs only a watermark/state; the accumulated output is read on attach.
type cloudRunViewStore interface {
	GetCloudRunView(context.Context, int64, string) (*CloudRun, error)
	GetCloudRunHead(context.Context, int64, string) (*CloudRun, error)
	ListCloudRunViews(context.Context, int64, string, bool, string) ([]CloudRun, error)
	ListCloudRunActiveTools(context.Context, int64, string) ([]CloudRunActiveTool, error)
}

type CloudRunActiveTool struct {
	ID     string `json:"tool_id"`
	Name   string `json:"name"`
	State  string `json:"state"`
	Status string `json:"status"`
}
type cloudRunPublicSnapshot struct {
	*CloudRun
	ActiveTools []CloudRunActiveTool `json:"active_tools"`
}

func cloudPublicToolStatus(name string) string {
	switch name {
	case "generate_image":
		return "正在创作图像"
	case "read_skill":
		return "正在准备创作"
	case prepareExtensionTool:
		return "正在校验草稿"
	case "execute_code":
		return "正在分析与计算"
	case "execute_command":
		return "正在运行和检查"
	case "read_file":
		return "正在读取工作文件"
	case "write_file":
		return "正在保存工作文件"
	case "publish_artifact":
		return "正在保存可下载成果"
	case "publish_site":
		return "正在保存站点"
	case "web_search":
		return "正在搜索资料"
	case "fetch_page":
		return "正在读取网页"
	case "read_source":
		return "正在核对来源"
	case "read_history":
		return "正在查阅当前会话历史"
	case "load_uploaded_file":
		return "正在载入附件"
	case "extract_archive":
		return "正在解包代码资料"
	}
	return ""
}
func cloudPublicRun(run CloudRun) *CloudRun {
	run.ModelParameters = cloneCloudModelParameters(run.ModelParameters)
	if run.PublicResearch != nil {
		copy := *run.PublicResearch
		run.PublicResearch = &copy
	}
	run.RequestContent = nil
	run.SessionRef = ""
	run.RequestHash = ""
	run.LeaseOwner = ""
	run.Attempt = 0
	// LeaseUntil is private, but clear it as well so a viewer copy is not authority.
	run.LeaseUntil = time.Time{}
	run.Presentation = append(json.RawMessage(nil), run.Presentation...)
	run.Usage = append(json.RawMessage(nil), run.Usage...)
	return &run
}

func readCloudRunView(ctx context.Context, store CloudRunStore, userID int64, id string) (*CloudRun, error) {
	if views, ok := store.(cloudRunViewStore); ok {
		return views.GetCloudRunView(ctx, userID, id)
	}
	return store.GetCloudRun(ctx, userID, id)
}
func readCloudRunHead(ctx context.Context, store CloudRunStore, userID int64, id string) (*CloudRun, error) {
	if views, ok := store.(cloudRunViewStore); ok {
		return views.GetCloudRunHead(ctx, userID, id)
	}
	return store.GetCloudRun(ctx, userID, id)
}
func (h *HTTPHandler) cloudRunSnapshot(ctx context.Context, userID int64, run *CloudRun) (cloudRunPublicSnapshot, error) {
	snapshot := cloudRunPublicSnapshot{CloudRun: run, ActiveTools: []CloudRunActiveTool{}}
	if run.Terminal() {
		return snapshot, nil
	}
	if views, ok := h.service.store.(cloudRunViewStore); ok {
		tools, err := views.ListCloudRunActiveTools(ctx, userID, run.ID)
		if err != nil {
			return snapshot, err
		}
		if tools != nil {
			snapshot.ActiveTools = tools
		}
	}
	return snapshot, nil
}

func (s *MemoryStore) GetCloudRunView(ctx context.Context, userID int64, id string) (*CloudRun, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	run, err := s.cloudRunLocked(userID, id)
	if err != nil {
		return nil, err
	}
	return cloudPublicRun(*run), nil
}
func (s *MemoryStore) GetCloudRunHead(ctx context.Context, userID int64, id string) (*CloudRun, error) {
	run, err := s.GetCloudRunView(ctx, userID, id)
	if err != nil {
		return nil, err
	}
	run.Output = ""
	run.Presentation = nil
	return run, nil
}
func (s *MemoryStore) ListCloudRunViews(ctx context.Context, userID int64, conversationID string, active bool, requestID string) ([]CloudRun, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	conversation, ok := s.cloudConversations[conversationID]
	if !ok || conversation.UserID != userID {
		return nil, ErrNotFound
	}
	result := make([]CloudRun, 0)
	if s.cloudRuns == nil {
		return result, nil
	}
	for _, item := range s.cloudRuns.runs {
		if item.UserID != userID || item.ConversationID != conversationID || (active && item.Terminal()) || (requestID != "" && item.ClientRequestID != requestID) {
			continue
		}
		run := cloudPublicRun(item)
		if !active && requestID == "" {
			run.Output = ""
			run.Presentation = nil
		}
		result = append(result, *run)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].CreatedAt.Equal(result[j].CreatedAt) {
			return result[i].ID > result[j].ID
		}
		return result[i].CreatedAt.After(result[j].CreatedAt)
	})
	if len(result) > 100 {
		result = result[:100]
	}
	return result, nil
}
func (s *MemoryStore) ListCloudRunActiveTools(ctx context.Context, userID int64, runID string) ([]CloudRunActiveTool, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	run, err := s.cloudRunLocked(userID, runID)
	if err != nil {
		return nil, err
	}
	result := make([]CloudRunActiveTool, 0)
	if run.Terminal() || s.cloudTools == nil {
		return result, nil
	}
	for _, op := range s.cloudTools.operations {
		status := cloudPublicToolStatus(op.Name)
		if op.UserID == userID && op.RunID == runID && status != "" && (op.State == CloudToolPrepared || op.State == CloudToolExecuting || op.State == CloudToolUnknown) {
			if op.State == CloudToolPrepared {
				status = "正在准备任务"
			}
			if op.State == CloudToolUnknown {
				status = "操作结果待核对"
			}
			result = append(result, CloudRunActiveTool{op.ID, op.Name, op.State, status})
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	if len(result) > 8 {
		result = result[:8]
	}
	return result, nil
}

const cloudRunPublicColumns = `r.id::text,r.conversation_id::text,r.user_id,r.client_request_id,r.model,r.reasoning_effort,r.provider_key_id,r.user_message_id::text,r.assistant_message_id::text,r.state,OUTPUT_COLUMN,r.usage,r.error_code,r.last_seq,r.created_at,r.updated_at,r.model_parameters,r.public_research,PRESENTATION_COLUMN`

func scanCloudRunView(row cloudRunScanner) (*CloudRun, error) {
	var run CloudRun
	var usage, parameters, publicResearch, presentation []byte
	err := row.Scan(&run.ID, &run.ConversationID, &run.UserID, &run.ClientRequestID, &run.Model, &run.ReasoningEffort, &run.ProviderKeyID, &run.UserMessageID, &run.AssistantMessageID, &run.State, &run.Output, &usage, &run.ErrorCode, &run.LastSeq, &run.CreatedAt, &run.UpdatedAt, &parameters, &publicResearch, &presentation)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(parameters, &run.ModelParameters); err != nil {
		return nil, ErrCloudRunInvalid
	}
	if run.ModelParameters, err = normalizeCloudModelParameters(run.ModelParameters); err != nil {
		return nil, err
	}
	if err = json.Unmarshal(publicResearch, &run.PublicResearch); err != nil {
		return nil, ErrCloudRunInvalid
	}
	if run.PublicResearch, err = normalizeCloudPublicResearch(run.PublicResearch); err != nil {
		return nil, err
	}
	run.Presentation = append(json.RawMessage(nil), presentation...)
	run.Usage = append(json.RawMessage(nil), usage...)
	return &run, err
}
func (s *PersistentStore) GetCloudRunView(ctx context.Context, userID int64, id string) (*CloudRun, error) {
	return s.getCloudRunProjection(ctx, userID, id, true)
}
func (s *PersistentStore) GetCloudRunHead(ctx context.Context, userID int64, id string) (*CloudRun, error) {
	return s.getCloudRunProjection(ctx, userID, id, false)
}
func (s *PersistentStore) getCloudRunProjection(ctx context.Context, userID int64, id string, output bool) (*CloudRun, error) {
	id, err := canonicalCloudRunID(id)
	if err != nil {
		return nil, err
	}
	column := "''"
	if output {
		column = "r.output"
	}
	columns := cloudRunProjectionColumns(column)
	return scanCloudRunView(s.db.QueryRowContext(ctx, "SELECT "+columns+` FROM zeroagent_cloud_runs r JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.user_id=$1 AND r.id=$2`, userID, id))
}
func (s *PersistentStore) ListCloudRunViews(ctx context.Context, userID int64, conversationID string, active bool, requestID string) ([]CloudRun, error) {
	conversationID, err := canonicalCloudRunID(conversationID)
	if err != nil {
		return nil, err
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM zerobox_cloud_conversations WHERE user_id=$1 AND id=$2)`, userID, conversationID).Scan(&exists); err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrNotFound
	}
	column := "''"
	if active || requestID != "" {
		column = "r.output"
	}
	columns := cloudRunProjectionColumns(column)
	rows, err := s.db.QueryContext(ctx, "SELECT "+columns+` FROM zeroagent_cloud_runs r JOIN zerobox_cloud_conversations c ON c.id=r.conversation_id AND c.user_id=r.user_id WHERE r.user_id=$1 AND r.conversation_id=$2 AND (NOT $3 OR r.state IN ('queued','running','cancelling')) AND ($4='' OR r.client_request_id=$4) ORDER BY r.created_at DESC,r.id DESC LIMIT 100`, userID, conversationID, active, requestID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]CloudRun, 0)
	for rows.Next() {
		run, err := scanCloudRunView(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, *run)
	}
	return result, rows.Err()
}
func (s *PersistentStore) ListCloudRunActiveTools(ctx context.Context, userID int64, runID string) ([]CloudRunActiveTool, error) {
	if _, err := s.GetCloudRunHead(ctx, userID, runID); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT o.id::text,o.name,o.state FROM zeroagent_cloud_tool_operations o JOIN zeroagent_cloud_runs r ON r.id=o.run_id AND r.user_id=o.user_id WHERE o.user_id=$1 AND o.run_id=$2 AND r.state IN ('queued','running','cancelling') AND o.state IN ('prepared','executing','unknown') AND o.name IN ('execute_code','execute_command','read_file','write_file','publish_artifact','publish_site','web_search','fetch_page','read_source','load_uploaded_file','read_history','extract_archive') ORDER BY o.updated_at DESC,o.id LIMIT 8`, userID, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]CloudRunActiveTool, 0)
	for rows.Next() {
		var item CloudRunActiveTool
		if err = rows.Scan(&item.ID, &item.Name, &item.State); err != nil {
			return nil, err
		}
		item.Status = cloudPublicToolStatus(item.Name)
		if item.State == CloudToolPrepared {
			item.Status = "正在准备任务"
		}
		if item.State == CloudToolUnknown {
			item.Status = "操作结果待核对"
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func cloudRunProjectionColumns(output string) string {
	presentation := "NULL::jsonb"
	if output == "r.output" {
		presentation = "r.presentation"
	}
	return strings.Replace(strings.Replace(cloudRunPublicColumns, "OUTPUT_COLUMN", output, 1), "PRESENTATION_COLUMN", presentation, 1)
}
