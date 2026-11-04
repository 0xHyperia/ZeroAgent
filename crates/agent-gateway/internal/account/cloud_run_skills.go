package account

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
)

//go:embed skills/*/SKILL.md
var cloudBuiltinSkills embed.FS

const cloudVisualSkillGuidance = ` Built-in workflows available via read_skill: imagegen (real generation/reference edits) and product-design (UX audits, visual directions, responsive implementation and verification). Read imagegen before generate_image; read product-design for deliberate UX/design work. Skills grant no unavailable tools. Image generation uses the user's separately configured default model; missing configuration must be surfaced, never substituted. Ready images are displayed in the conversation and saved privately in the personal space.`

func (e *cloudRunToolExecution) visualSchemas() []map[string]any {
	return []map[string]any{
		cloudToolFunction("read_skill", "Read the built-in workflow before product design or image generation.", map[string]any{"name": map[string]any{"type": "string", "enum": []string{"imagegen", "product-design"}}}, "name"),
		cloudToolFunction("generate_image", "Generate one image or edit owned references with the default image model. Read imagegen first. Returns a durable artifact or needs_configuration. Never retry unknown outcomes.", map[string]any{
			"prompt":     map[string]any{"type": "string", "maxLength": 16000},
			"name":       map[string]any{"type": "string", "description": "Descriptive PNG filename."},
			"size":       map[string]any{"type": "string", "enum": []string{"auto", "1024x1024", "1536x1024", "1024x1536"}},
			"quality":    map[string]any{"type": "string", "enum": []string{"auto", "low", "medium", "high"}},
			"references": map[string]any{"type": "array", "maxItems": 4, "items": map[string]any{"type": "object", "properties": map[string]any{"file_id": map[string]any{"type": "string"}, "artifact_version_id": map[string]any{"type": "string"}}, "additionalProperties": false}},
			"family_id":  map[string]any{"type": "string", "description": "Owned generated image family only for a new version of the same image."},
		}, "prompt", "name"),
	}
}
func (e *cloudRunToolExecution) executeSkill(ctx context.Context, round int, call cloudModelToolCall) (json.RawMessage, error) {
	var args struct {
		Name string `json:"name"`
	}
	if err := decodeCloudToolArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	if args.Name != "imagegen" && args.Name != "product-design" {
		return nil, &cloudToolRunError{code: "model_tool_invalid"}
	}
	content, err := cloudBuiltinSkills.ReadFile("skills/" + args.Name + "/SKILL.md")
	if err != nil {
		return nil, err
	}
	op, _, err := e.prepare(ctx, fmt.Sprintf("round:%d:call:%d", round, call.Index), call.Name, map[string]any{"name": args.Name}, "")
	if err != nil {
		return nil, err
	}
	if op.State == CloudToolSucceeded {
		return op.Result, nil
	}
	if op.State != CloudToolPrepared {
		return nil, &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true}
	}
	if _, err = e.store.StartCloudTool(ctx, e.run.UserID, op.ID, e.owner, e.run.Attempt); err != nil {
		return nil, err
	}
	result := cloudJSON(map[string]any{"name": args.Name, "instructions": string(content)})
	if err = e.commit(ctx, op, CloudToolSucceeded, result, ""); err != nil {
		return nil, err
	}
	return result, nil
}
