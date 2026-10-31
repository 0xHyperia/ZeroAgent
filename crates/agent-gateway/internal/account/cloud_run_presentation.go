package account

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	CloudPresentationMaxBytes   = 16 << 20
	cloudPresentationMaxBlocks  = 512
	cloudModelMaxReasoningBytes = 1 << 20
)

// CloudPresentation contains only public, committed display facts. It is not a
// tool transcript, an execution capability, or model input for the next turn.
type CloudPresentation struct {
	Version         int                      `json:"version"`
	Blocks          []CloudPresentationBlock `json:"blocks"`
	Model           string                   `json:"model,omitempty"`
	ReasoningEffort string                   `json:"reasoning_effort,omitempty"`
	State           string                   `json:"state,omitempty"`
	Usage           json.RawMessage          `json:"usage,omitempty"`
	StartedAt       time.Time                `json:"started_at"`
	CompletedAt     *time.Time               `json:"completed_at,omitempty"`
	Rounds          []CloudPresentationRound `json:"rounds,omitempty"`
}

type CloudPresentationBlock struct {
	ID          string                      `json:"id"`
	Type        string                      `json:"type"`
	Round       int                         `json:"round"`
	Text        string                      `json:"text,omitempty"`
	ToolID      string                      `json:"tool_id,omitempty"`
	Name        string                      `json:"name,omitempty"`
	State       string                      `json:"state,omitempty"`
	Status      string                      `json:"status,omitempty"`
	StartedAt   time.Time                   `json:"started_at"`
	CompletedAt *time.Time                  `json:"completed_at,omitempty"`
	Resources   []CloudPresentationResource `json:"resources,omitempty"`
}

type CloudPresentationRound struct {
	Round       int             `json:"round"`
	Model       string          `json:"model"`
	Usage       json.RawMessage `json:"usage,omitempty"`
	StartedAt   time.Time       `json:"started_at"`
	CompletedAt *time.Time      `json:"completed_at,omitempty"`
}

func cloudPresentation(run *CloudRun) (*CloudPresentation, error) {
	p := &CloudPresentation{Version: 1, Blocks: []CloudPresentationBlock{}, Model: run.Model, ReasoningEffort: run.ReasoningEffort, StartedAt: run.CreatedAt}
	if len(run.Presentation) > 0 {
		if json.Unmarshal(run.Presentation, p) != nil || p.Version != 1 {
			return nil, ErrCloudRunInvalid
		}
	}
	return p, nil
}

func cloudPresentationHasContent(raw json.RawMessage) bool {
	var p CloudPresentation
	return len(raw) > 0 && json.Unmarshal(raw, &p) == nil && len(p.Blocks) > 0
}

// Derive the projection after checking the original commit hash and execution
// lease. Enriched timestamps never change retry identity. The two stores save
// projection, event and terminal canonical message in the same transaction.
func applyCloudPresentation(run *CloudRun, commit *CloudRunCommit, now time.Time) error {
	kind := commit.EventType
	if commit.Delta != "" {
		kind = "message.delta"
	}
	if kind != "message.delta" && kind != "reasoning.delta" && kind != "model.started" && kind != "model.completed" && !strings.HasPrefix(kind, "tool.") {
		return nil
	}
	var data struct {
		Round  int             `json:"round"`
		Delta  string          `json:"delta"`
		ToolID string          `json:"tool_id"`
		Name   string          `json:"name"`
		Usage  json.RawMessage `json:"usage"`
	}
	if json.Unmarshal(commit.Payload, &data) != nil || data.Round < 0 || data.Round > 1024 || !utf8.ValidString(data.Delta) {
		return ErrCloudRunInvalid
	}
	if kind == "message.delta" {
		data.Delta = commit.Delta
	}
	if (kind == "message.delta" || kind == "reasoning.delta") && data.Delta == "" {
		return nil
	}
	p, err := cloudPresentation(run)
	if err != nil {
		return err
	}
	// An old active run may already contain public output when this version is
	// deployed. Keep that prefix when its first structured event is committed.
	if len(run.Presentation) == 0 {
		prefix := run.Output
		if commit.Delta != "" {
			prefix = strings.TrimSuffix(prefix, commit.Delta)
		}
		if prefix != "" {
			p.Blocks = append(p.Blocks, CloudPresentationBlock{ID: "legacy:text", Type: "text", Round: 0, Text: prefix, StartedAt: run.CreatedAt})
		}
	}
	p.State, p.Usage = run.State, cloudPresentationUsage(run.Usage)
	payload := map[string]any{"round": data.Round}
	if strings.HasPrefix(kind, "model.") {
		var round *CloudPresentationRound
		for i := range p.Rounds {
			if p.Rounds[i].Round == data.Round {
				round = &p.Rounds[i]
				break
			}
		}
		if round == nil {
			if len(p.Rounds) >= cloudPresentationMaxBlocks {
				return ErrCloudRunLimit
			}
			p.Rounds = append(p.Rounds, CloudPresentationRound{Round: data.Round, Model: run.Model, StartedAt: now})
			round = &p.Rounds[len(p.Rounds)-1]
		}
		if kind == "model.completed" {
			round.CompletedAt, round.Usage = &now, cloudPresentationUsage(data.Usage)
			for i := range p.Blocks {
				if p.Blocks[i].Round == data.Round && p.Blocks[i].Type != "tool" && p.Blocks[i].CompletedAt == nil {
					p.Blocks[i].CompletedAt = &now
				}
			}
		}
		payload["model"], payload["started_at"] = round.Model, round.StartedAt
		if round.CompletedAt != nil {
			payload["completed_at"] = round.CompletedAt
		}
		if len(round.Usage) > 0 {
			payload["usage"] = round.Usage
		}
	} else {
		blockType := strings.SplitN(kind, ".", 2)[0]
		if blockType == "message" {
			blockType = "text"
		}
		id := fmt.Sprintf("%s:%d", blockType, data.Round)
		if blockType == "tool" {
			toolID, idErr := canonicalCloudRunID(data.ToolID)
			if idErr != nil || cloudPublicToolStatus(data.Name) == "" {
				return ErrCloudRunInvalid
			}
			data.ToolID, id = toolID, "tool:"+toolID
		} else {
			// Same-round providers may alternate public reasoning and answer
			// content. Only append to the current open segment; revisiting an
			// earlier type creates a new ordered segment rather than moving text.
			segments := 0
			for i := range p.Blocks {
				if p.Blocks[i].Type == blockType && p.Blocks[i].Round == data.Round {
					segments++
				}
			}
			if len(p.Blocks) > 0 {
				last := &p.Blocks[len(p.Blocks)-1]
				if last.Type == blockType && last.Round == data.Round && last.CompletedAt == nil {
					id = last.ID
				} else if segments > 0 {
					id = fmt.Sprintf("%s:%d", id, segments+1)
				}
			}
		}
		var block *CloudPresentationBlock
		for i := range p.Blocks {
			if p.Blocks[i].ID == id {
				block = &p.Blocks[i]
				break
			}
		}
		if block == nil {
			if len(p.Blocks) >= cloudPresentationMaxBlocks {
				return ErrCloudRunLimit
			}
			for i := range p.Blocks {
				previous := &p.Blocks[i]
				if previous.Type != "tool" && previous.CompletedAt == nil {
					previous.CompletedAt = &now
				}
			}
			p.Blocks = append(p.Blocks, CloudPresentationBlock{ID: id, Type: blockType, Round: data.Round, StartedAt: now})
			block = &p.Blocks[len(p.Blocks)-1]
		}
		if blockType == "tool" {
			state, status := "", ""
			switch kind {
			case "tool.prepared":
				state, status = CloudToolPrepared, "正在准备任务"
			case "tool.started", "tool.executing":
				state, status = CloudToolExecuting, cloudPublicToolStatus(data.Name)
			case "tool.completed":
				state, status = CloudToolSucceeded, "已完成"
			case "tool.failed":
				state, status = CloudToolFailed, "执行失败"
			case "tool.unknown":
				state, status = CloudToolUnknown, "结果待确认"
			case "tool.cancelled":
				state, status = CloudToolCancelled, "已取消"
			default:
				return ErrCloudRunInvalid
			}
			if block.Name != "" && (block.Name != data.Name || block.Round != data.Round) {
				return ErrCloudRunConflict
			}
			if block.State != "" && block.State != CloudToolPrepared && block.State != CloudToolExecuting && (state == CloudToolPrepared || state == CloudToolExecuting) {
				return ErrCloudRunConflict
			}
			if block.State == CloudToolExecuting && state == CloudToolPrepared {
				return ErrCloudRunConflict
			}
			previousState := block.State
			block.ToolID, block.Name, block.State, block.Status = data.ToolID, data.Name, state, status
			if state != CloudToolPrepared && state != CloudToolExecuting && (block.CompletedAt == nil || previousState == CloudToolUnknown && state != CloudToolUnknown) {
				block.CompletedAt = &now
			}
			if len(commit.presentationResources) > 0 {
				block.Resources = append([]CloudPresentationResource(nil), commit.presentationResources...)
			}
			payload["tool_id"], payload["name"], payload["state"], payload["status"] = block.ToolID, block.Name, block.State, block.Status
			if len(block.Resources) > 0 {
				payload["resources"] = block.Resources
			}
		} else {
			limit := CloudRunMaxOutputBytes
			used := len(block.Text)
			if blockType == "reasoning" {
				limit = cloudModelMaxReasoningBytes
				used = 0
				for _, segment := range p.Blocks {
					if segment.Type == "reasoning" && segment.Round == data.Round {
						used += len(segment.Text)
					}
				}
			}
			if used+len(data.Delta) > limit {
				return ErrCloudRunLimit
			}
			block.Text += data.Delta
			payload["delta"] = data.Delta
		}
		payload["block_id"], payload["started_at"] = block.ID, block.StartedAt
		if block.CompletedAt != nil {
			payload["completed_at"] = block.CompletedAt
		}
	}
	encoded, err := json.Marshal(p)
	// Reserve room for final timestamps/status so recovery can always finish.
	limit := CloudPresentationMaxBytes - (256 << 10)
	if run.Terminal() {
		limit = CloudPresentationMaxBytes
	}
	if err != nil || len(encoded) > limit {
		return ErrCloudRunLimit
	}
	run.Presentation = encoded
	if kind == commit.EventType {
		commit.Payload = cloudJSON(payload)
	}
	return nil
}

func cloudPresentationUsage(raw json.RawMessage) json.RawMessage {
	var values map[string]json.RawMessage
	if json.Unmarshal(raw, &values) != nil {
		return nil
	}
	result := map[string]int64{}
	for _, key := range []string{"prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"} {
		var n int64
		if value, ok := values[key]; ok && json.Unmarshal(value, &n) == nil && n >= 0 {
			result[key] = n
		}
	}
	if len(result) == 0 {
		return nil
	}
	return cloudJSON(result)
}

func finishCloudPresentation(run *CloudRun, now time.Time) {
	if len(run.Presentation) == 0 {
		return
	}
	p, err := cloudPresentation(run)
	if err != nil {
		return
	}
	p.State, p.CompletedAt, p.Usage = run.State, &now, cloudPresentationUsage(run.Usage)
	for i := range p.Blocks {
		block := &p.Blocks[i]
		if block.CompletedAt == nil {
			block.CompletedAt = &now
			if block.Type == "tool" {
				// A terminal run does not prove an external operation was stopped.
				block.State, block.Status = CloudToolUnknown, "结果待确认"
			}
		}
	}
	for i := range p.Rounds {
		if p.Rounds[i].CompletedAt == nil {
			p.Rounds[i].CompletedAt = &now
		}
	}
	run.Presentation = cloudJSON(p)
}

func cloudPresentationTerminalPayload(run *CloudRun, payload json.RawMessage, now time.Time) json.RawMessage {
	if !run.Terminal() {
		return payload
	}
	var data map[string]any
	if json.Unmarshal(payload, &data) != nil || data == nil {
		data = map[string]any{}
	}
	data["state"], data["started_at"], data["completed_at"] = run.State, run.CreatedAt, now
	if usage := cloudPresentationUsage(run.Usage); len(usage) > 0 {
		data["usage"] = usage
	}
	return cloudJSON(data)
}

func writeCloudPresentationMarkdown(output *strings.Builder, raw json.RawMessage) {
	var presentation CloudPresentation
	if len(raw) == 0 || json.Unmarshal(raw, &presentation) != nil || presentation.Version != 1 {
		return
	}
	output.WriteString("\n\n### 回复记录\n\n")
	fmt.Fprintf(output, "模型：%s；状态：%s\n", strings.ReplaceAll(presentation.Model, "\n", " "), presentation.State)
	if len(presentation.Usage) > 0 {
		fmt.Fprintf(output, "\n用量：`%s`\n", presentation.Usage)
	}
	for _, block := range presentation.Blocks {
		switch block.Type {
		case "reasoning":
			fmt.Fprintf(output, "\n#### 模型思考（第 %d 轮）\n\n%s\n", block.Round+1, block.Text)
		case "tool":
			fmt.Fprintf(output, "\n- 第 %d 轮 · %s · %s (%s)\n", block.Round+1, block.Name, block.Status, block.State)
			for _, resource := range block.Resources {
				fmt.Fprintf(output, "  - %s · %s · %s：%s", resource.Role, resource.Kind, resource.ID, strings.ReplaceAll(resource.Name, "\n", " "))
				if resource.Version > 0 {
					fmt.Fprintf(output, "（版本 %d）", resource.Version)
				}
				output.WriteString("\n")
			}
		}
	}
}
