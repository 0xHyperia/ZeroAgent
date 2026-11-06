package account

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"io/fs"
	"log"
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"
)

// Only redistributable packages are embedded. A local development Gateway
// can read the separately copied, digest-pinned proprietary packages.
//
//go:embed all:codex-packages
var cloudCodexOriginals embed.FS

type codexOriginalSource struct {
	Local  bool   `json:"local"`
	SHA256 string `json:"sha256"`
}

type codexOriginalInterface struct {
	Overview string
	Examples []string
	Apps     []cloudExtensionApp
}

type cloudExtensionApp struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

const codexOriginalRevision = 4

var cachedCodexOriginals = sync.OnceValue(func() map[string]CloudExtensionRevision {
	var local fs.FS
	if dir := os.Getenv("ZEROAGENT_CODEX_ORIGINALS_DIR"); dir != "" {
		local = os.DirFS(dir)
	}
	return loadCodexOriginals(local)
})

func loadCodexOriginals(local fs.FS) map[string]CloudExtensionRevision {
	pinned, _ := cloudCodexOriginals.ReadFile("codex-packages/sources.json")
	var sources map[string]codexOriginalSource
	if err := json.Unmarshal(pinned, &sources); err != nil {
		panic("invalid embedded Codex package lock")
	}
	result := map[string]CloudExtensionRevision{}
	for id, spec := range sources {
		var source fs.FS = cloudCodexOriginals
		root := "codex-packages/" + id
		if spec.Local {
			if local == nil {
				continue
			}
			source, root = local, id
		}
		files, err := codexOriginalText(source, root, spec.SHA256)
		if err != nil {
			log.Printf("Codex original %s unavailable: package does not match the pinned snapshot", id)
			continue
		}
		if v, ok := codexOriginalDefinition(id, files); ok {
			result[id] = v
		}
	}
	return result
}

func codexOriginalText(source fs.FS, root, digest string) (map[string]string, error) {
	text := map[string]string{}
	hashes := map[string][sha256.Size]byte{}
	total := int64(0)
	err := fs.WalkDir(source, root, func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		if !entry.Type().IsRegular() || len(hashes) >= 256 {
			return ErrCloudRunInvalid
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		if total > 4<<20 {
			return ErrCloudRunLimit
		}
		body, err := fs.ReadFile(source, name)
		if err != nil {
			return err
		}
		relative := strings.TrimPrefix(name, root+"/")
		hashes[relative] = sha256.Sum256(body)
		if len(body) <= 64<<10 && utf8.Valid(body) && !strings.ContainsRune(string(body), 0) {
			text[relative] = string(body)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(hashes))
	for name := range hashes {
		names = append(names, name)
	}
	sort.Strings(names)
	hash := sha256.New()
	for _, name := range names {
		hash.Write([]byte(name + "\x00"))
		sum := hashes[name]
		hash.Write(sum[:])
	}
	if hex.EncodeToString(hash.Sum(nil)) != digest {
		return nil, ErrCloudRunInvalid
	}
	return text, nil
}

// Extract catalog metadata without running, installing, or registering any
// of the package's declared connectors, tools, hooks, or scripts.
func codexOriginalDefinition(id string, files map[string]string) (CloudExtensionRevision, bool) {
	ui := &codexOriginalInterface{}
	v := CloudExtensionRevision{Number: codexOriginalRevision, Files: files, Codex: ui}
	primary := id
	if raw := files[".codex-plugin/plugin.json"]; raw != "" {
		var manifest struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Skills      string `json:"skills"`
			Apps        string `json:"apps"`
			Interface   struct {
				Name     string   `json:"displayName"`
				Overview string   `json:"longDescription"`
				Short    string   `json:"shortDescription"`
				Examples []string `json:"defaultPrompt"`
			} `json:"interface"`
		}
		if json.Unmarshal([]byte(raw), &manifest) != nil || manifest.Name != id {
			return v, false
		}
		v.Name, v.Description = manifest.Interface.Name, manifest.Interface.Short
		ui.Overview, ui.Examples = manifest.Interface.Overview, manifest.Interface.Examples
		if v.Description == "" {
			v.Description = manifest.Description
		}
		root := strings.TrimSuffix(strings.TrimPrefix(manifest.Skills, "./"), "/") + "/"
		for name, body := range files {
			if relative, ok := strings.CutPrefix(name, root); ok && path.Base(relative) == "SKILL.md" && strings.Count(relative, "/") == 1 {
				sk := codexOriginalSkill(name, body, files)
				if sk.Name == "" {
					return v, false
				}
				v.Skills = append(v.Skills, sk)
			}
		}
		switch id {
		case "product-design":
			primary = "index"
		case "plugin-creator":
			primary = "create-plugin"
			if manifest.Apps == "./.app.json" {
				var declaration struct {
					Apps map[string]struct{ ID string } `json:"apps"`
				}
				if json.Unmarshal([]byte(files[".app.json"]), &declaration) != nil {
					return v, false
				}
				if declaration.Apps[id].ID != "" {
					ui.Apps = []cloudExtensionApp{{Name: v.Name, Description: manifest.Description}}
				}
			}
		}
	} else {
		sk := codexOriginalSkill("SKILL.md", files["SKILL.md"], files)
		v.Name, v.Description = sk.DisplayName, codexAgentField(files["agents/openai.yaml"], "short_description")
		v.Skills = []CloudExtensionSkill{sk}
		ui.Overview = sk.Description
		if example := codexAgentField(files["agents/openai.yaml"], "default_prompt"); example != "" {
			ui.Examples = []string{example}
		}
	}
	sort.Slice(v.Skills, func(i, j int) bool {
		a, b := v.Skills[i].Name, v.Skills[j].Name
		if (a == primary) != (b == primary) {
			return a == primary
		}
		return a < b
	})
	return v, v.Name != "" && len(v.Skills) > 0 && v.Skills[0].Name == primary
}

func codexOriginalSkill(name, body string, files map[string]string) CloudExtensionSkill {
	id, description := cloudSkillFrontmatter(body)
	if !cloudSkillName.MatchString(id) || description == "" {
		return CloudExtensionSkill{}
	}
	agent := files[path.Join(path.Dir(name), "agents/openai.yaml")]
	return CloudExtensionSkill{Name: id, Description: description, Entry: name, DisplayName: codexAgentField(agent, "display_name")}
}

// The pinned agent manifests use simple quoted scalar interface fields.
func codexAgentField(body, key string) string {
	for _, line := range strings.Split(body, "\n") {
		if value, ok := strings.CutPrefix(line, "  "+key+": "); ok {
			decoded, _ := strconv.Unquote(strings.TrimSpace(value))
			return decoded
		}
	}
	return ""
}
