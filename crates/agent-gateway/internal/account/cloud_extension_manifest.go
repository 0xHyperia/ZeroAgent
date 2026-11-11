package account

import (
	"encoding/json"
	"io/fs"
	"path"
	"slices"
	"sort"
	"strings"
	"unicode/utf8"
)

type cloudPluginInterface struct {
	DisplayName      string `json:"displayName"`
	ShortDescription string `json:"shortDescription"`
}

type cloudPluginManifest struct {
	Name        string                     `json:"name"`
	Description string                     `json:"description"`
	Skills      json.RawMessage            `json:"skills"`
	Interface   cloudPluginInterface       `json:"interface"`
	Extensions  map[string]json.RawMessage `json:"extensions"`
	MCPServers  json.RawMessage            `json:"mcpServers"`
	Apps        json.RawMessage            `json:"apps"`
	Hooks       json.RawMessage            `json:"hooks"`
}

func cloudManifestPresent(raw json.RawMessage) bool {
	return len(raw) > 0 && string(raw) != "null" && string(raw) != "{}" && string(raw) != "[]"
}

// Parse declarative instruction packages only. A manifest cannot add a tool,
// connection or executable capability to the account-owned cloud executor.
func cloudRevisionFromManifest(files map[string]string) (CloudExtensionRevision, string, error) {
	return parseCloudRevisionManifest(files, cloudExtensionRevisionValid)
}

func parseCloudRevisionManifest(files map[string]string, validate func(CloudExtensionRevision) bool) (CloudExtensionRevision, string, error) {
	v := CloudExtensionRevision{Files: files}
	raw := files["plugin.json"]
	if raw == "" {
		raw = files[".codex-plugin/plugin.json"]
	}
	var manifest cloudPluginManifest
	if raw == "" || json.Unmarshal([]byte(raw), &manifest) != nil || !cloudSkillName.MatchString(manifest.Name) {
		return v, "", ErrCloudRunInvalid
	}
	var openai struct {
		Interface  cloudPluginInterface `json:"interface"`
		MCPServers json.RawMessage      `json:"mcpServers"`
		Apps       json.RawMessage      `json:"apps"`
		Hooks      json.RawMessage      `json:"hooks"`
	}
	if extension := manifest.Extensions["com.openai"]; len(extension) > 0 {
		if json.Unmarshal(extension, &openai) != nil {
			return v, "", ErrCloudRunInvalid
		}
		manifest.Interface = openai.Interface
	}
	for _, declaration := range []json.RawMessage{manifest.MCPServers, manifest.Apps, manifest.Hooks, openai.MCPServers, openai.Apps, openai.Hooks} {
		if cloudManifestPresent(declaration) {
			return v, "", ErrCloudRunInvalid
		}
	}
	for _, name := range []string{"mcp.json", ".mcp.json", ".app.json", "hooks/hooks.json"} {
		if files[name] != "" {
			return v, "", ErrCloudRunInvalid
		}
	}
	var local struct {
		PrimarySkill string            `json:"primarySkill"`
		Kind         string            `json:"kind"`
		Aliases      map[string]string `json:"aliases"`
	}
	if extension := manifest.Extensions["top.usa0"]; len(extension) > 0 && json.Unmarshal(extension, &local) != nil {
		return v, "", ErrCloudRunInvalid
	}
	roots := []string{"skills"}
	if len(manifest.Skills) > 0 {
		var single string
		if json.Unmarshal(manifest.Skills, &single) == nil {
			roots = []string{single}
		} else if json.Unmarshal(manifest.Skills, &roots) != nil {
			return v, "", ErrCloudRunInvalid
		}
	}
	entries := map[string]bool{}
	if files["SKILL.md"] != "" {
		entries["SKILL.md"] = true
	}
	for _, root := range roots {
		root = strings.TrimSuffix(strings.TrimPrefix(root, "./"), "/")
		if !validCloudToolPath(root) || path.Clean(root) != root || strings.HasPrefix(root, ".") || strings.Contains(root, ":") {
			return v, "", ErrCloudRunInvalid
		}
		if files[root+"/SKILL.md"] != "" {
			entries[root+"/SKILL.md"] = true
			continue
		}
		for name := range files {
			if !strings.HasPrefix(name, root+"/") || path.Base(name) != "SKILL.md" {
				continue
			}
			if strings.Count(strings.TrimPrefix(name, root+"/"), "/") == 1 {
				entries[name] = true
			}
		}
	}
	for entry := range entries {
		name, description := cloudSkillFrontmatter(files[entry])
		v.Skills = append(v.Skills, CloudExtensionSkill{Name: name, Description: description, Entry: entry})
	}
	sort.Slice(v.Skills, func(i, j int) bool {
		if (v.Skills[i].Name == local.PrimarySkill) != (v.Skills[j].Name == local.PrimarySkill) {
			return v.Skills[i].Name == local.PrimarySkill
		}
		return v.Skills[i].Name < v.Skills[j].Name
	})
	if local.PrimarySkill != "" && (len(v.Skills) == 0 || v.Skills[0].Name != local.PrimarySkill) {
		return v, "", ErrCloudRunInvalid
	}
	for alias, target := range local.Aliases {
		found := false
		for _, skill := range v.Skills {
			found = found || skill.Name == target
		}
		if !cloudSkillName.MatchString(alias) || !found || alias == target {
			return v, "", ErrCloudRunInvalid
		}
	}
	v.Aliases = local.Aliases
	v.Name = manifest.Interface.DisplayName
	if v.Name == "" {
		v.Name = manifest.Name
	}
	v.Description = manifest.Description
	if v.Description == "" {
		v.Description = manifest.Interface.ShortDescription
	}
	if !validate(v) {
		return v, "", ErrCloudRunInvalid
	}
	return v, local.Kind, nil
}

var cloudFileSkillIDs = []string{"documents", "pdf", "spreadsheet", "presentations"}

func declaredBuiltinCloudExtensions(root string, number int64) []CloudExtension {
	return readBuiltinCloudExtensions(root, number, []string{"product-design", "imagegen", "plugin-creator", "skill-creator"})
}

func readBuiltinCloudExtensions(root string, number int64, ids []string) []CloudExtension {
	result := []CloudExtension{}
	for _, id := range ids {
		files := map[string]string{}
		fileSkill := root == "skills" && slices.Contains(cloudFileSkillIDs, id)
		prefix := root + "/" + id + "/"
		err := fs.WalkDir(cloudBuiltinSkills, strings.TrimSuffix(prefix, "/"), func(name string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			body, err := cloudBuiltinSkills.ReadFile(name)
			if err == nil && (!fileSkill || utf8.Valid(body) && !strings.ContainsRune(string(body), 0)) {
				files[strings.TrimPrefix(name, prefix)] = string(body)
			}
			return err
		})
		if err != nil {
			continue
		}
		validate := cloudExtensionRevisionValid
		if fileSkill {
			validate = func(revision CloudExtensionRevision) bool {
				return cloudExtensionRevisionWithin(revision, 128, 128<<10, 1<<20)
			}
		}
		revision, kind, err := parseCloudRevisionManifest(files, validate)
		if err != nil {
			continue
		}
		revision.Number = number
		result = append(result, CloudExtension{ID: id, Kind: kind, Installed: true, Enabled: true, DisabledSkills: []string{}, Revisions: []CloudExtensionRevision{revision}})
	}
	return result
}
