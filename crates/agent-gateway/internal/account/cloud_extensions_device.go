package account

import (
	"encoding/json"
	"io"
	"net/http"
	"path"
	"strconv"
	"strings"

	"go.yaml.in/yaml/v3"
)

const cloudDeviceSkillSnapshotPath = "/api/web-chat/extensions/device-snapshot"

type cloudDeviceSkillRef struct {
	PackageID string `json:"package_id"`
	Revision  int64  `json:"revision"`
	Name      string `json:"name"`
}

type cloudDeviceSkill struct {
	cloudDeviceSkillRef
	Entry string            `json:"entry"`
	Files map[string]string `json:"files"`
}

func (ref cloudDeviceSkillRef) valid() bool {
	return len(ref.PackageID) <= 64 && cloudSkillName.MatchString(ref.PackageID) &&
		len(ref.Name) <= 64 && cloudSkillName.MatchString(ref.Name) &&
		ref.Revision >= 1 && ref.Revision <= 999_999_999
}

func (h *HTTPHandler) cloudDeviceSkillCompatibility(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	if session.Purpose != desktopCloudAccessPurpose {
		writeError(w, &APIError{Status: http.StatusForbidden, Reason: "device_skill_login_required", Message: "Use the signed-in device to load this skill."})
		return
	}
	query := r.URL.Query()
	revision, err := strconv.ParseInt(query.Get("revision"), 10, 64)
	ref := cloudDeviceSkillRef{PackageID: r.PathValue("id"), Revision: revision, Name: query.Get("skill")}
	if err != nil || !ref.valid() || strconv.FormatInt(revision, 10) != query.Get("revision") {
		cloudExtensionError(w, ErrCloudRunInvalid)
		return
	}
	if _, ok := h.readDeviceSkills(w, r, session, []cloudDeviceSkillRef{ref}); ok {
		w.WriteHeader(http.StatusNoContent)
	}
}

func (h *HTTPHandler) cloudDeviceSkillSnapshot(w http.ResponseWriter, r *http.Request, session *Session) {
	w.Header().Set("Cache-Control", "no-store")
	if session.Purpose != desktopCloudAccessPurpose {
		writeError(w, &APIError{Status: http.StatusForbidden, Reason: "device_skill_login_required", Message: "Use the signed-in device to load this skill."})
		return
	}
	if !h.cloudWriteAllowed(w, r) {
		return
	}
	var input struct {
		References []cloudDeviceSkillRef `json:"references"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil || decoder.Decode(new(any)) != io.EOF ||
		len(input.References) == 0 || len(input.References) > 4 {
		cloudExtensionError(w, ErrCloudRunInvalid)
		return
	}
	revisions := map[string]int64{}
	seen := map[cloudDeviceSkillRef]bool{}
	for _, ref := range input.References {
		if !ref.valid() || seen[ref] {
			cloudExtensionError(w, ErrCloudRunInvalid)
			return
		}
		if previous := revisions[ref.PackageID]; previous != 0 && previous != ref.Revision {
			cloudExtensionError(w, ErrCloudRunConflict)
			return
		}
		revisions[ref.PackageID], seen[ref] = ref.Revision, true
	}
	if body, ok := h.readDeviceSkills(w, r, session, input.References); ok {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}
}

func (h *HTTPHandler) readDeviceSkills(w http.ResponseWriter, r *http.Request, session *Session, references []cloudDeviceSkillRef) ([]byte, bool) {
	store, ok := h.service.store.(cloudExtensionsStore)
	if !ok {
		cloudExtensionError(w, ErrNotFound)
		return nil, false
	}
	doc, err := store.GetCloudExtensions(r.Context(), session.UserID)
	if err != nil {
		cloudExtensionError(w, err)
		return nil, false
	}
	packages := effectiveCloudExtensions(doc)
	skills := make([]cloudDeviceSkill, 0, len(references))
	for _, ref := range references {
		skill, found, compatible := cloudDeviceSkillAt(packages, ref)
		if !found {
			cloudExtensionError(w, ErrNotFound)
			return nil, false
		}
		if !compatible {
			writeError(w, &APIError{Status: http.StatusUnprocessableEntity, Reason: "device_skill_unsupported", Message: "This skill revision requires capabilities unavailable on this device."})
			return nil, false
		}
		skills = append(skills, skill)
	}
	body := cloudJSON(map[string]any{"skills": skills})
	if len(body) > 256<<10 {
		cloudExtensionError(w, ErrCloudRunLimit)
		return nil, false
	}
	return body, true
}

// The device reads one declared entry, its supporting files and shared
// references. This projection never installs a package, grants a tool, or
// includes another entry's source or a script.
func cloudDeviceSkillAt(packages []CloudExtension, ref cloudDeviceSkillRef) (cloudDeviceSkill, bool, bool) {
	for _, pkg := range packages {
		if pkg.ID != ref.PackageID {
			continue
		}
		revision := cloudExtensionRevisionAt(pkg, ref.Revision)
		if revision == nil {
			break
		}
		skill := cloudSkillInRevision(pkg, revision, ref.Name)
		if skill == nil {
			break
		}
		snapshot := cloudDeviceSkill{cloudDeviceSkillRef: ref, Entry: skill.Entry, Files: map[string]string{}}
		if cloudExtensionBuiltin(pkg.ID) &&
			(pkg.ID != "product-design" || skill.Name != "audit" ||
				ref.Revision != cloudProductDesignQARevision) {
			return snapshot, true, false
		}
		entry := revision.Files[skill.Entry]
		if entry == "" || deviceSkillDeclaresDependencies(revision.Files, skill.Entry) {
			return snapshot, true, false
		}
		dir := path.Dir(skill.Entry)
		kind := pkg.Kind
		for name, content := range revision.Files {
			sharedReference := strings.HasPrefix(name, "references/") &&
				(!cloudExtensionBuiltin(pkg.ID) || name == "references/quality.md")
			if name != skill.Entry && name != "plugin.json" && name != ".codex-plugin/plugin.json" &&
				((dir != "." && strings.HasPrefix(name, dir+"/")) ||
					sharedReference || (dir == "." && kind == "skill")) {
				if !deviceSkillTextResource(name) {
					return snapshot, true, false
				}
				snapshot.Files[name] = content
			}
		}
		snapshot.Files[skill.Entry] = entry
		return snapshot, true, true
	}
	return cloudDeviceSkill{}, false, false
}

func deviceSkillDeclaresDependencies(files map[string]string, entry string) bool {
	body := strings.TrimPrefix(strings.ReplaceAll(files[entry], "\r\n", "\n"), "\uFEFF")
	if strings.HasPrefix(body, "---\n") {
		frontmatter := body[3:]
		header, _, closed := strings.Cut(frontmatter, "\n---\n")
		if !closed {
			header, closed = strings.CutSuffix(frontmatter, "\n---")
		}
		if !closed || deviceSkillMetadataRequiresCapabilities(header) {
			return true
		}
	}
	for _, name := range []string{"mcp.json", ".mcp.json", ".app.json", "hooks/hooks.json"} {
		if strings.TrimSpace(files[name]) != "" {
			return true
		}
	}
	for _, name := range []string{"plugin.json", ".codex-plugin/plugin.json", "agents/openai.yaml", "agents/openai.yml"} {
		if deviceSkillMetadataRequiresCapabilities(files[name]) {
			return true
		}
	}
	dir := path.Dir(entry)
	return dir != "." && (deviceSkillMetadataRequiresCapabilities(files[path.Join(dir, "agents/openai.yaml")]) ||
		deviceSkillMetadataRequiresCapabilities(files[path.Join(dir, "agents/openai.yml")]))
}

func deviceSkillMetadataRequiresCapabilities(body string) bool {
	if strings.TrimSpace(body) == "" {
		return false
	}
	decoder := yaml.NewDecoder(strings.NewReader(body))
	var fields map[string]any
	err := decoder.Decode(&fields)
	if err == io.EOF {
		return false
	}
	return err != nil || decoder.Decode(new(any)) != io.EOF || deviceSkillMetadataHasDependencies(fields)
}

func deviceSkillMetadataHasDependencies(fields map[string]any) bool {
	for key, value := range fields {
		switch strings.ToLower(strings.TrimSpace(key)) {
		case "allowed-tools", "requires", "dependencies", "mcp", "mcpservers", "hooks", "tools", "apps":
			if deviceSkillDependencyPresent(value) {
				return true
			}
		case "metadata":
			nested, _ := value.(map[string]any)
			if deviceSkillMetadataHasDependencies(nested) {
				return true
			}
		case "extensions":
			extensions, _ := value.(map[string]any)
			openAI, _ := extensions["com.openai"].(map[string]any)
			if deviceSkillMetadataHasDependencies(openAI) {
				return true
			}
		}
	}
	return false
}

func deviceSkillDependencyPresent(value any) bool {
	switch value := value.(type) {
	case nil:
		return false
	case bool:
		return value
	case string:
		return strings.TrimSpace(value) != ""
	case map[string]any:
		for _, child := range value {
			if deviceSkillDependencyPresent(child) {
				return true
			}
		}
		return false
	case []any:
		for _, child := range value {
			if deviceSkillDependencyPresent(child) {
				return true
			}
		}
		return false
	default:
		return true
	}
}

func deviceSkillTextResource(name string) bool {
	for _, part := range strings.Split(name, "/") {
		if strings.HasPrefix(part, ".") || strings.EqualFold(part, "scripts") {
			return false
		}
	}
	switch strings.ToLower(path.Ext(name)) {
	case ".md", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml":
		return true
	default:
		return false
	}
}
