package account

import (
	"embed"
	"io/fs"
	"maps"
	"strings"
)

//go:embed skills-native
var cloudNativeWorkflows embed.FS

const cloudNativeWorkflowRevision = 5
const cloudProductDesignQARevision = 6

type cloudWorkflowPresentation struct {
	Overview string
	Examples []string
}

func cloudNativeWorkflow(id, kind string, base CloudExtensionRevision, catalogOnly bool) CloudExtensionRevision {
	type presentation struct {
		name, description, overview string
		examples                    []string
	}
	info := map[string]presentation{
		"product-design": {"Product Design", "Research, design, and build interactive prototypes.",
			"Use your screenshots, project context, and research to explore a design. Open the resulting prototype in a private preview, check the phone and desktop layouts, and annotate changes in place.",
			[]string{"Audit this product flow using my screenshots", "Explore three directions for this feature", "Build an interactive prototype from this reference"}},
		"plugin-creator": {"Plugin Creator", "Create or refine a personal plugin with related skills.",
			"Turn a repeatable workflow into a personal plugin. Review the main instructions, bundled skills, and supporting files before saving it to your account.",
			[]string{"Create a plugin for a task I do often", "Turn these instructions into a plugin", "Improve a plugin I own"}},
		"imagegen": {"Image Gen", "Create or edit images with your configured image model.",
			"Generate images from a description or edit an owned reference. Saved images are available in your personal space, and edits keep the original version.",
			[]string{"Create a product hero image", "Edit my reference and preserve the subject", "Generate a transparent asset for this design"}},
		"skill-creator": {"Skill Creator", "Create or update a reusable personal skill.",
			"Describe when the skill should trigger and what success looks like. Review the generated instructions and supporting files before adding it to your personal skills.",
			[]string{"Turn my instructions into a reusable skill"}},
	}[id]
	next := base
	next.Number, next.Name, next.Description = cloudNativeWorkflowRevision, info.name, info.description
	if id == "product-design" {
		next.Number = cloudProductDesignQARevision
	}
	next.Native = &cloudWorkflowPresentation{Overview: info.overview, Examples: info.examples}
	next.Files = maps.Clone(base.Files)
	next.Skills = append([]CloudExtensionSkill(nil), base.Skills...)
	overlayCloudNativeFiles(next.Files, "skills-native/"+id, catalogOnly)
	for i := range next.Skills {
		skill := &next.Skills[i]
		_, skill.Description = cloudSkillFrontmatter(next.Files[skill.Entry])
		if id == "product-design" && skill.Name == "design-qa" {
			skill.DisplayName = "Design QA"
		}
	}
	next.Files["plugin.json"] = string(cloudJSON(map[string]any{
		"name": id, "description": info.description, "skills": "./skills",
		"interface": map[string]any{"displayName": info.name, "longDescription": info.overview, "defaultPrompt": info.examples},
		"extensions": map[string]any{"top.usa0": map[string]any{
			"kind": kind, "primarySkill": next.Skills[0].Name, "aliases": next.Aliases,
		}},
	})) + "\n"
	if !cloudExtensionRevisionValid(next) {
		panic("invalid ZeroAgent workflow definition")
	}
	return next
}

func overlayCloudNativeFiles(files map[string]string, root string, catalogOnly bool) {
	err := fs.WalkDir(cloudNativeWorkflows, root, func(name string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		if catalogOnly && entry.Name() != "SKILL.md" {
			return nil
		}
		raw, err := cloudNativeWorkflows.ReadFile(name)
		if err == nil {
			files[strings.TrimPrefix(name, root+"/")] = string(raw)
		}
		return err
	})
	if err != nil {
		panic("invalid embedded ZeroAgent workflow")
	}
}
