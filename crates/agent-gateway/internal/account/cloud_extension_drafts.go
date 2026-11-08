package account

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

const prepareExtensionTool = "prepare_extension"

type cloudExtensionDraft struct {
	Kind         string                 `json:"kind"`
	TargetID     string                 `json:"target_id,omitempty"`
	BaseRevision int64                  `json:"base_revision,omitempty"`
	Revision     CloudExtensionRevision `json:"revision"`
}

type cloudExtensionDraftSkill struct {
	Name         string `json:"name"`
	Description  string `json:"description"`
	Instructions string `json:"instructions"`
}

type cloudExtensionDraftRequest struct {
	Kind         string `json:"kind"`
	TargetID     string `json:"target_id,omitempty"`
	BaseRevision int64  `json:"base_revision,omitempty"`
	cloudExtensionDraftSkill
	Skills []cloudExtensionDraftSkill `json:"skills,omitempty"`
	Files  []struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	} `json:"files,omitempty"`
}

func (e *cloudRunToolExecution) canPrepareExtension(kind string, update bool) bool {
	id, name := "skill-creator", "skill-creator"
	if kind == "plugin" {
		id, name = "plugin-creator", "create-plugin"
		if update {
			name = "update-plugin"
		}
	} else if kind != "skill" {
		return false
	}
	for _, p := range e.skillPackages {
		if p.ID == id {
			return cloudExtensionSkillEnabled(p, name)
		}
	}
	return false
}

func (e *cloudRunToolExecution) extensionDraftSchema() []map[string]any {
	kinds := []string{}
	for _, kind := range []string{"skill", "plugin"} {
		if e.canPrepareExtension(kind, false) || e.canPrepareExtension(kind, true) {
			kinds = append(kinds, kind)
		}
	}
	if len(kinds) == 0 {
		return nil
	}
	skillFields := map[string]any{
		"name": cloudToolString("Stable lowercase, hyphen-separated name."), "description": cloudToolString("Explain when the skill applies."),
		"instructions": cloudToolString("Workflow body in Markdown, without frontmatter."),
	}
	fields := maps.Clone(skillFields)
	fields["kind"] = map[string]any{"type": "string", "enum": kinds}
	fields["target_id"] = cloudToolString("Optional exact personal package ID for an update.")
	fields["base_revision"] = map[string]any{"type": "integer", "minimum": 1, "description": "Required with target_id. Use the version returned by read_skill."}
	fields["skills"] = map[string]any{"type": "array", "maxItems": 19, "items": map[string]any{
		"type": "object", "properties": skillFields, "required": []string{"name", "description", "instructions"}, "additionalProperties": false,
	}}
	fields["files"] = map[string]any{"type": "array", "maxItems": 44, "items": map[string]any{
		"type": "object", "properties": map[string]any{"path": cloudToolString("Relative path under references/, assets/ or scripts/."), "content": cloudToolString("UTF-8 text.")},
		"required": []string{"path", "content"}, "additionalProperties": false,
	}}
	return []map[string]any{cloudToolFunction(prepareExtensionTool,
		"Validate a personal ZeroAgent skill or instruction plugin and prepare a private draft. Return its citation in the reply. The user reviews and saves the package in the editor.",
		fields, "kind", "name", "description", "instructions")}
}

func extensionDraftRevision(input cloudExtensionDraftRequest, previous *CloudExtensionRevision) (CloudExtensionRevision, error) {
	revision := CloudExtensionRevision{Files: map[string]string{}}
	if input.Kind != "skill" && input.Kind != "plugin" || input.Kind == "skill" && len(input.Skills) != 0 || len(input.Skills) > 19 || len(input.Files) > 44 {
		return revision, ErrCloudRunInvalid
	}
	primary := "SKILL.md"
	if previous != nil {
		if len(previous.Skills) == 0 || previous.Name != input.Name {
			return revision, ErrCloudRunInvalid
		}
		revision = *previous
		revision.Files = maps.Clone(previous.Files)
		revision.Skills = append([]CloudExtensionSkill(nil), previous.Skills...)
		primary = previous.Skills[0].Entry
	}
	seen := map[string]bool{}
	for _, source := range input.Files {
		allowed := strings.HasPrefix(source.Path, "references/") || strings.HasPrefix(source.Path, "assets/") || strings.HasPrefix(source.Path, "scripts/")
		if !allowed || !validCloudToolPath(source.Path) || strings.ContainsAny(source.Path, ":\r\n") ||
			strings.Contains(source.Path, "/.") || strings.EqualFold(source.Path[strings.LastIndex(source.Path, "/")+1:], "SKILL.md") || seen[source.Path] {
			return revision, ErrCloudRunInvalid
		}
		seen[source.Path] = true
		revision.Files[source.Path] = source.Content
	}
	saveSkill := func(skill cloudExtensionDraftSkill, entry string, index int) error {
		description, body := strings.TrimSpace(skill.Description), strings.TrimSpace(skill.Instructions)
		if !cloudSkillName.MatchString(skill.Name) || strings.ContainsAny(description, "\r\n") || description == "" || body == "" || strings.HasPrefix(body, "---\n") || strings.HasPrefix(body, "---\r\n") {
			return ErrCloudRunInvalid
		}
		revision.Files[entry] = "---\nname: " + skill.Name + "\ndescription: " + strconv.Quote(description) + "\n---\n\n" + body + "\n"
		info := CloudExtensionSkill{Name: skill.Name, Description: description, Entry: entry}
		if index < len(revision.Skills) {
			revision.Skills[index] = info
		} else {
			revision.Skills = append(revision.Skills, info)
		}
		return nil
	}
	revision.Name, revision.Description = input.Name, strings.TrimSpace(input.Description)
	mainSkill := input.cloudExtensionDraftSkill
	if previous != nil {
		mainSkill.Name = previous.Skills[0].Name
	}
	if err := saveSkill(mainSkill, primary, 0); err != nil {
		return revision, err
	}
	names := map[string]bool{mainSkill.Name: true}
	for _, skill := range input.Skills {
		if names[skill.Name] || !cloudSkillName.MatchString(skill.Name) {
			return revision, ErrCloudRunInvalid
		}
		names[skill.Name] = true
		entry, index := "skills/"+skill.Name+"/SKILL.md", len(revision.Skills)
		for i, old := range revision.Skills {
			if old.Name == skill.Name {
				entry, index = old.Entry, i
				break
			}
		}
		if err := saveSkill(skill, entry, index); err != nil {
			return revision, err
		}
	}
	if input.Kind == "plugin" && previous == nil {
		setGeneratedPluginManifest(&revision)
	}
	if !cloudExtensionRevisionValid(revision) {
		return revision, ErrCloudRunInvalid
	}
	return revision, nil
}

func setGeneratedPluginManifest(revision *CloudExtensionRevision) {
	revision.Files["plugin.json"] = string(cloudJSON(map[string]any{
		"name": revision.Name, "description": revision.Description, "skills": "./skills",
		"extensions": map[string]any{"top.usa0": map[string]any{"kind": "plugin", "primarySkill": revision.Skills[0].Name}},
	})) + "\n"
}

func (e *cloudRunToolExecution) executeExtensionDraft(ctx context.Context, round int, call cloudModelToolCall) (json.RawMessage, error) {
	var input cloudExtensionDraftRequest
	if err := decodeCloudToolArguments(call.Arguments, &input); err != nil {
		return nil, err
	}
	if _, err := e.skillCatalog(ctx); err != nil || !e.canPrepareExtension(input.Kind, input.TargetID != "") {
		return nil, &cloudToolRunError{code: "skill_unavailable"}
	}
	if e.hasSecret(json.RawMessage(call.Arguments)) {
		return nil, &cloudToolRunError{code: "model_secret_reflection"}
	}
	op, _, err := e.prepare(ctx, fmt.Sprintf("round:%d:call:%d", round, call.Index), call.Name, map[string]any{
		"sha256": fmt.Sprintf("%x", sha256.Sum256([]byte(call.Arguments))),
	}, "")
	if err != nil {
		return nil, err
	}
	receipt := func() json.RawMessage {
		return cloudJSON(map[string]any{"status": "draft_ready", "citation": "【自定义草稿:" + op.ID + "】", "name": input.Name})
	}
	switch op.State {
	case CloudToolSucceeded:
		return receipt(), nil
	case CloudToolFailed:
		return op.Result, nil
	case CloudToolPrepared:
	default:
		return nil, &cloudToolRunError{code: "cloud_tool_outcome_unknown", unknown: true}
	}
	fail := func(code string) (json.RawMessage, error) {
		result := cloudJSON(map[string]any{"status": "validation_failed", "code": code})
		if err := e.commit(ctx, op, CloudToolFailed, result, code); err != nil {
			return nil, err
		}
		return result, nil
	}
	var base *CloudExtensionRevision
	if input.TargetID != "" || input.BaseRevision != 0 {
		if id, err := uuid.Parse(input.TargetID); err != nil || id.String() != input.TargetID || input.BaseRevision < 1 {
			return fail("extension_draft_invalid")
		}
		store, ok := e.runtime.service.store.(cloudExtensionsStore)
		if !ok {
			return fail("extension_draft_unavailable")
		}
		doc, err := store.GetCloudExtensions(ctx, e.run.UserID)
		if err != nil {
			return fail("extension_draft_unavailable")
		}
		for _, pkg := range doc.Packages {
			if pkg.ID == input.TargetID && !cloudExtensionBuiltin(pkg.ID) && pkg.Kind == input.Kind && len(pkg.Revisions) != 0 {
				latest := pkg.Revisions[len(pkg.Revisions)-1]
				if latest.Number == input.BaseRevision {
					base = &latest
				}
				break
			}
		}
		if base == nil {
			return fail("extension_draft_stale")
		}
	}
	revision, err := extensionDraftRevision(input, base)
	if err != nil {
		return fail("extension_draft_invalid")
	}
	if _, err := e.store.StartCloudTool(ctx, e.run.UserID, op.ID, e.owner, e.run.Attempt); err != nil {
		return nil, err
	}
	draft := cloudExtensionDraft{Kind: input.Kind, TargetID: input.TargetID, BaseRevision: input.BaseRevision, Revision: revision}
	if err := e.commit(ctx, op, CloudToolSucceeded, cloudJSON(draft), ""); err != nil {
		return nil, err
	}
	return receipt(), nil
}

func loadCloudExtensionDraft(ctx context.Context, store any, userID int64, id string) (cloudExtensionDraft, error) {
	var draft cloudExtensionDraft
	tools, ok := store.(CloudToolStore)
	if !ok {
		return draft, ErrNotFound
	}
	op, err := tools.GetCloudToolOperation(ctx, userID, id)
	if err != nil || op.Name != prepareExtensionTool || op.State != CloudToolSucceeded || json.Unmarshal(op.Result, &draft) != nil {
		return draft, ErrNotFound
	}
	return draft, nil
}

func (h *HTTPHandler) cloudExtensionDraftDetail(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	draft, err := loadCloudExtensionDraft(r.Context(), h.service.store, session.UserID, r.PathValue("id"))
	if err != nil {
		cloudExtensionError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, draft)
}
