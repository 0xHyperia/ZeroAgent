package account

import "strings"

func cloudContentKnownFields(value map[string]any, allowed ...string) bool {
	for key := range value {
		known := false
		for _, name := range allowed {
			if name == key {
				known = true
				break
			}
		}
		if !known {
			return false
		}
	}
	return true
}

// Browser content is data, not a place for provider control parameters. New
// requests reject unknown keys; model assembly projects even previously saved
// content to the same supported structure, without editing canonical history.
func cloudTextImagePart(part map[string]any, strict bool) (map[string]any, bool) {
	switch part["type"] {
	case "text":
		text, ok := part["text"].(string)
		if !ok || strict && !cloudContentKnownFields(part, "type", "text") {
			return nil, false
		}
		return map[string]any{"type": "text", "text": text}, true
	case "image_url":
		image, ok := part["image_url"].(map[string]any)
		if !ok || strict && (!cloudContentKnownFields(part, "type", "image_url") || !cloudContentKnownFields(image, "url", "detail")) {
			return nil, false
		}
		url, ok := image["url"].(string)
		if !ok || (!strings.HasPrefix(url, "data:image/png;base64,") && !strings.HasPrefix(url, "data:image/jpeg;base64,") && !strings.HasPrefix(url, "data:image/webp;base64,") && !strings.HasPrefix(url, "data:image/gif;base64,")) {
			return nil, false
		}
		clean := map[string]any{"url": url}
		if detail, exists := image["detail"]; exists {
			value, ok := detail.(string)
			if !ok || (value != "auto" && value != "low" && value != "high") {
				return nil, false
			}
			clean["detail"] = value
		}
		return map[string]any{"type": "image_url", "image_url": clean}, true
	}
	return nil, false
}
