package account

import (
	"context"
	"encoding/json"
	"regexp"
	"strconv"
)

var cloudSkillReference = regexp.MustCompile(`zeroagent-skill:([a-z0-9-]+)/([1-9][0-9]{0,8})/([a-z0-9-]+)`)

type cloudSkillPin struct {
	packageID string
	revision  int64
	name      string
}

func (s *Service) cloudSkillCatalog(ctx context.Context, userID int64) ([]CloudExtension, error) {
	store, ok := s.store.(cloudExtensionsStore)
	if !ok {
		return builtinCloudExtensions(), nil
	}
	doc, err := store.GetCloudExtensions(ctx, userID)
	if err != nil {
		return nil, err
	}
	return effectiveCloudExtensions(doc), nil
}

func cloudSkillPinProblem(packages []CloudExtension, pins []cloudSkillPin) string {
	revisions := make(map[string]int64, len(pins))
	for _, pin := range pins {
		if previous := revisions[pin.packageID]; previous != 0 && previous != pin.revision {
			return "skill_revision_conflict"
		}
		revisions[pin.packageID] = pin.revision
	}
	byID := make(map[string]CloudExtension, len(packages))
	for _, pkg := range packages {
		byID[pkg.ID] = pkg
	}
	for _, pin := range pins {
		pkg := byID[pin.packageID]
		revision := cloudExtensionRevisionAt(pkg, pin.revision)
		if revision == nil || cloudSkillInRevision(pkg, revision, pin.name) == nil {
			return "skill_reference_unavailable"
		}
	}
	return ""
}

// Only the user's text can select a skill. In a multipart request, media URLs
// and resource metadata can contain the same string without being a mention.
func cloudSkillPins(content json.RawMessage) []cloudSkillPin {
	var input string
	if json.Unmarshal(content, &input) == nil {
		return appendCloudSkillPins(nil, input)
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(content, &parts) != nil {
		return nil
	}
	var pins []cloudSkillPin
	for _, part := range parts {
		if part.Type == "text" {
			pins = appendCloudSkillPins(pins, part.Text)
		}
	}
	return pins
}

func appendCloudSkillPins(pins []cloudSkillPin, text string) []cloudSkillPin {
	for _, match := range cloudSkillReference.FindAllStringSubmatchIndex(text, -1) {
		if (match[0] > 0 && cloudSkillTokenByte(text[match[0]-1])) ||
			(match[1] < len(text) && cloudSkillTokenByte(text[match[1]])) {
			continue
		}
		packageID, name := text[match[2]:match[3]], text[match[6]:match[7]]
		if !cloudSkillName.MatchString(packageID) || !cloudSkillName.MatchString(name) {
			continue
		}
		revision, _ := strconv.ParseInt(text[match[4]:match[5]], 10, 64)
		pins = append(pins, cloudSkillPin{packageID: packageID, revision: revision, name: name})
	}
	return pins
}

func cloudSkillTokenByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' ||
		c == '-' || c == '_' || c == '/' || c == ':'
}

func cloudExtensionRevisionAt(pkg CloudExtension, number int64) *CloudExtensionRevision {
	if number == 0 && len(pkg.Revisions) != 0 {
		return &pkg.Revisions[len(pkg.Revisions)-1]
	}
	for i := range pkg.Revisions {
		if pkg.Revisions[i].Number == number {
			return &pkg.Revisions[i]
		}
	}
	return nil
}

func cloudSkillInRevision(pkg CloudExtension, revision *CloudExtensionRevision, requested string) *CloudExtensionSkill {
	if !cloudExtensionSkillEnabled(pkg, requested) {
		return nil
	}
	name := requested
	if alias := revision.Aliases[requested]; alias != "" {
		name = alias
	}
	for i := range revision.Skills {
		skill := &revision.Skills[i]
		if skill.Name == name {
			if cloudExtensionSkillEnabled(pkg, skill.Name) {
				return skill
			}
			return nil
		}
	}
	if name == requested && name == pkg.ID && len(revision.Skills) > 0 &&
		cloudExtensionSkillEnabled(pkg, revision.Skills[0].Name) {
		return &revision.Skills[0]
	}
	return nil
}
