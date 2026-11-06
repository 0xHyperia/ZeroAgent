package account

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
)

//go:embed skills skills-releases
var cloudBuiltinSkills embed.FS

const cloudVisualSkillGuidance = ` When installed and enabled in the skill catalog, read imagegen before generate_image and product-design for deliberate UX/design work. Skills grant no unavailable tools. When read_skill returns host_guidance, use that CloudChat mapping for the original Codex workflow. Image generation uses the user's separately configured default model; missing configuration must be surfaced, never substituted. Ready images are displayed in the conversation and saved privately in the personal space.`

const cloudCodexHostGuidance = "The attached source is an original Codex workflow. In CloudChat use only the tools advertised in this run. Use generate_image for the workflow's image_gen generation and edits; do not invoke an external image API or the bundled image CLI. Read bundled text with read_skill. Run code only in an advertised isolated workspace. Codex app connectors, host files, and credentials referenced in the source are unavailable; do not simulate a successful connection, publish, or write."

func (e *cloudRunToolExecution) visualSchemas() []map[string]any {
	result := []map[string]any{
		cloudToolFunction("read_skill", "Read an installed skill workflow or one of its listed source files. Does not execute scripts.", map[string]any{"name": cloudToolString("Installed skill name from the available catalog."), "package_id": cloudToolString("Package ID from the catalog; required when skill names are ambiguous."), "file": cloudToolString("Optional exact relative source file listed by the skill.")}, "name"),
		cloudToolFunction("generate_image", "Generate one image or edit owned references with the default image model. Read imagegen first. Returns a durable artifact or needs_configuration. Never retry unknown outcomes.", map[string]any{
			"prompt":     map[string]any{"type": "string", "maxLength": 16000},
			"name":       map[string]any{"type": "string", "description": "Descriptive PNG filename."},
			"size":       map[string]any{"type": "string", "enum": []string{"auto", "1024x1024", "1536x1024", "1024x1536"}},
			"quality":    map[string]any{"type": "string", "enum": []string{"auto", "low", "medium", "high"}},
			"background": map[string]any{"type": "string", "enum": []string{"auto", "transparent"}, "description": "Use transparent only when requested; the returned PNG is checked for transparent pixels."},
			"references": map[string]any{"type": "array", "maxItems": 4, "items": map[string]any{"type": "object", "properties": map[string]any{"file_id": map[string]any{"type": "string"}, "artifact_version_id": map[string]any{"type": "string"}}, "additionalProperties": false}},
			"family_id":  map[string]any{"type": "string", "description": "Owned generated image family only for a new version of the same image."},
		}, "prompt", "name"),
	}
	if e.skillPackages != nil {
		enabled := false
		for _, p := range e.skillPackages {
			if p.ID == "imagegen" && cloudExtensionSkillEnabled(p, "imagegen") {
				enabled = true
			}
		}
		if !enabled {
			return result[:1]
		}
	}
	return result
}
func (e *cloudRunToolExecution) executeSkill(ctx context.Context, round int, call cloudModelToolCall) (json.RawMessage, error) {
	var args struct {
		Name      string `json:"name"`
		File      string `json:"file,omitempty"`
		PackageID string `json:"package_id,omitempty"`
	}
	if err := decodeCloudToolArguments(call.Arguments, &args); err != nil {
		return nil, err
	}
	content, err := e.resolveSkill(ctx, args.PackageID, args.Name, args.File)
	if err != nil {
		return nil, &cloudToolRunError{code: "skill_unavailable"}
	}
	op, _, err := e.prepare(ctx, fmt.Sprintf("round:%d:call:%d", round, call.Index), call.Name, map[string]any{"name": args.Name, "file": args.File, "package_id": content["package_id"], "version": content["version"]}, "")
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
	result := cloudJSON(content)
	if err = e.commit(ctx, op, CloudToolSucceeded, result, ""); err != nil {
		return nil, err
	}
	return result, nil
}
