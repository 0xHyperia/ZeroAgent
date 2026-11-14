package cloudchat_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// Test-only deterministic image peer. These procedural covers verify the real
// upload, receipt, gallery and edit flow, never the quality of a remote model.
type browserVisualFixture struct {
	images [][]byte
	calls  atomic.Uint32
}

func newBrowserVisualFixture(t *testing.T) *browserVisualFixture {
	t.Helper()
	f := &browserVisualFixture{}
	palettes := [][3]color.NRGBA{
		{{23, 53, 48, 255}, {175, 194, 164, 255}, {239, 237, 224, 255}},
		{{43, 40, 65, 255}, {186, 174, 216, 255}, {236, 230, 242, 255}},
		{{91, 51, 39, 255}, {217, 163, 126, 255}, {248, 234, 211, 255}},
	}
	for _, p := range palettes {
		img := image.NewNRGBA(image.Rect(0, 0, 960, 720))
		for y := 0; y < 720; y++ {
			for x := 0; x < 960; x++ {
				c := p[2]
				if x < 214 {
					c = p[0]
				}
				if x > 250 && x < 916 && y > 84 && y < 251 {
					c = p[1]
				}
				if x > 250 && y > 300 && y < 639 && x < 916 {
					c = color.NRGBA{255, 255, 255, 255}
				}
				if x > 282 && x < 725 && (y > 112 && y < 124 || y > 146 && y < 180 || y > 350 && y < 366) {
					c = p[0]
				}
				if x > 282 && x < 650 && y > 408 && y < 610 && y%44 < 3 {
					c = p[1]
				}
				if x > 42 && x < 166 && y > 120 && y < 430 && y%60 < 4 {
					c = p[1]
				}
				if x > 770 && x < 878 && y > 400 && y < 588 {
					c = p[1]
				}
				img.SetNRGBA(x, y, c)
			}
		}
		var out bytes.Buffer
		if err := png.Encode(&out, img); err != nil {
			t.Fatal(err)
		}
		f.images = append(f.images, out.Bytes())
	}
	return f
}

func (f *browserVisualFixture) serveImage(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer fixture-model-key-only" || r.Header.Get("Idempotency-Key") == "" {
		http.Error(w, "invalid local image authority", http.StatusUnauthorized)
		return
	}
	index := f.calls.Add(1) - 1
	select {
	case <-r.Context().Done():
		return
	case <-time.After(6 * time.Second):
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"data": []any{map[string]any{"b64_json": base64.StdEncoding.EncodeToString(f.images[int(index)%len(f.images)])}}})
}

func (f *browserVisualFixture) respondModel(w http.ResponseWriter, body []byte) bool {
	var req struct {
		Messages []struct {
			Role    string
			Content json.RawMessage
		}
	}
	if json.Unmarshal(body, &req) != nil {
		return false
	}
	lastUser := -1
	for i, m := range req.Messages {
		if m.Role == "user" {
			lastUser = i
		}
	}
	if lastUser < 0 || !strings.Contains(string(req.Messages[lastUser].Content), "视觉创作验收") {
		return false
	}
	var plain string
	if json.Unmarshal(req.Messages[lastUser].Content, &plain) != nil {
		var parts []struct{ Text string }
		_ = json.Unmarshal(req.Messages[lastUser].Content, &parts)
		for _, p := range parts {
			plain += p.Text
		}
	}
	reference := browserArtifactPattern.FindStringSubmatch(plain)
	results := []map[string]any{}
	for _, m := range req.Messages[lastUser+1:] {
		if m.Role != "tool" {
			continue
		}
		var s string
		var data map[string]any
		_ = json.Unmarshal(m.Content, &s)
		_ = json.Unmarshal([]byte(s), &data)
		results = append(results, data)
	}
	call := func(name string, args any) {
		tool := map[string]any{"index": 0, "id": fmt.Sprintf("visual_call_%d", len(results)), "type": "function", "function": map[string]any{"name": name, "arguments": string(browserJSON(args))}}
		_, _ = fmt.Fprintf(w, "data: %s\n\n", browserJSON(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{tool}}}}}))
		browserModelFinish(w, "tool_calls")
	}
	if len(results) < 2 {
		name := "product-design"
		if len(results) == 1 {
			name = "imagegen"
		}
		call("read_skill", map[string]any{"name": name})
		return true
	}
	count := 3
	if len(reference) > 0 {
		count = 1
	}
	if len(results) < count+2 && results[len(results)-1]["status"] == nil {
		args := map[string]any{"prompt": "A calm editorial workspace concept. Synthetic local visual acceptance cover.", "name": fmt.Sprintf("视觉方案-%d.png", len(results)-1), "size": "1536x1024", "quality": "low"}
		if len(reference) > 0 {
			args["references"] = []any{map[string]any{"artifact_version_id": reference[1]}}
			args["family_id"] = reference[2]
		}
		call("generate_image", args)
		return true
	}
	text := "这组本地合成方案用于验收布局、加载和图片交互，不代表真实模型质量。\n\n"
	for _, result := range results {
		if result["status"] == "needs_configuration" {
			text += "请先选择默认生图模型，再回到当前对话继续。"
		}
	}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", browserJSON(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": text}}}}))
	browserModelFinish(w, "stop")
	return true
}
