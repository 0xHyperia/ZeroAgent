package cloudchat_test

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/cloudexecutor"
)

const browserFixtureChartCode = "# ZEROAGENT_BROWSER_SYNTHETIC_CHART_V1\n# UI protocol fixture only; this code is never executed.\n"
const browserFixtureChartPath = "results/browser-chart.png"

// Standard-library raster bytes exercise the real artifact publication and
// browser preview protocol. They are not evidence of E2B or model execution.
func browserFixtureChartPNG(t *testing.T) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, 320, 180))
	draw.Draw(canvas, canvas.Bounds(), image.NewUniform(color.RGBA{248, 250, 252, 255}), image.Point{}, draw.Src)
	draw.Draw(canvas, image.Rect(32, 20, 34, 153), image.NewUniform(color.RGBA{71, 85, 105, 255}), image.Point{}, draw.Src)
	draw.Draw(canvas, image.Rect(32, 151, 300, 153), image.NewUniform(color.RGBA{71, 85, 105, 255}), image.Point{}, draw.Src)
	for index, height := range []int{55, 96, 122} {
		palette := []color.RGBA{{59, 130, 246, 255}, {16, 185, 129, 255}, {139, 92, 246, 255}}
		x := 61 + index*79
		draw.Draw(canvas, image.Rect(x, 151-height, x+43, 151), image.NewUniform(palette[index]), image.Point{}, draw.Src)
	}
	var output bytes.Buffer
	if err := png.Encode(&output, canvas); err != nil {
		t.Fatal("encode synthetic fixture PNG")
	}
	return output.Bytes()
}

func respondBrowserChart(w http.ResponseWriter, toolResults int, lastResult map[string]any) bool {
	name := "execute_code"
	arguments := map[string]any{"language": "python", "code": browserFixtureChartCode}
	if toolResults == 1 {
		name, arguments = "publish_artifact", map[string]any{"path": browserFixtureChartPath, "name": "browser-chart.png"}
	} else if toolResults >= 2 {
		artifact, _ := lastResult["artifact"].(map[string]any)
		id, _ := artifact["id"].(string)
		if _, err := uuid.Parse(id); err != nil {
			http.Error(w, "synthetic chart publication did not succeed", http.StatusBadGateway)
			return true
		}
		text := "320×180 合成条形图已保存，可以查看和下载。\n\n【成果:" + id + "】\n\n这是本地 UI 协议夹具，未执行真实 E2B，也不用于验收模型内容质量。"
		_, _ = fmt.Fprintf(w, "data: %s\n\n", browserJSON(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": text}}}}))
		browserModelFinish(w, "stop")
		return true
	}
	call := map[string]any{"index": 0, "id": fmt.Sprintf("browser_chart_%d", toolResults), "type": "function", "function": map[string]any{"name": name, "arguments": string(browserJSON(arguments))}}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", browserJSON(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{call}}}}}))
	browserModelFinish(w, "tool_calls")
	return true
}

func TestBrowserSyntheticChartProtocol(t *testing.T) {
	f := newBrowserToolFixture(t)
	ctx := context.Background()
	op := cloudexecutor.Operation{OperationID: uuid.NewString(), OwnerScope: "fixture-owner", WorkspaceRef: "fixture-workspace", Action: "sandbox.create", Input: map[string]any{}}
	created, err := f.client.Execute(ctx, op)
	if err != nil {
		t.Fatal(err)
	}
	var info struct {
		SandboxID string `json:"sandbox_id"`
	}
	if json.Unmarshal(created.Result, &info) != nil || info.SandboxID == "" {
		t.Fatal("missing synthetic sandbox")
	}
	op = cloudexecutor.Operation{OperationID: uuid.NewString(), OwnerScope: "fixture-owner", WorkspaceRef: "fixture-workspace", Action: "code.run", SandboxID: info.SandboxID, Input: map[string]any{"code": browserFixtureChartCode, "language": "python", "timeout_ms": 30000}}
	for range 2 {
		if receipt, err := f.client.Execute(ctx, op); err != nil || receipt.State != cloudexecutor.StateSucceeded {
			t.Fatalf("fixed chart receipt unavailable: %v", err)
		}
	}
	if f.snapshot()["code_runs"] != 1 {
		t.Fatal("replayed operation materialized a second chart")
	}
	op.OperationID, op.Action, op.Input = uuid.NewString(), "file.download.chunk", map[string]any{"path": browserFixtureChartPath, "offset": 0, "max_bytes": 1 << 20}
	receipt, err := f.client.Execute(ctx, op)
	if err != nil {
		t.Fatal(err)
	}
	var chunk struct {
		Data   string `json:"data_base64"`
		SHA256 string `json:"sha256"`
		EOF    bool   `json:"eof"`
	}
	if json.Unmarshal(receipt.Result, &chunk) != nil || !chunk.EOF {
		t.Fatal("incomplete synthetic chart transfer")
	}
	data, err := base64.StdEncoding.Strict().DecodeString(chunk.Data)
	if err != nil {
		t.Fatal("invalid chart bytes")
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	digest := sha256.Sum256(data)
	if err != nil || config.Width != 320 || config.Height != 180 || chunk.SHA256 != hex.EncodeToString(digest[:]) || !bytes.Equal(data, f.chartPNG) {
		t.Fatal("chart dimensions or persisted hash mismatch")
	}
	op.OperationID, op.Action, op.Input = uuid.NewString(), "code.run", map[string]any{"code": "print('arbitrary code')", "language": "python"}
	if _, err := f.client.Execute(ctx, op); err == nil || f.snapshot()["code_runs"] != 1 {
		t.Fatal("synthetic peer accepted arbitrary code")
	}
	status := string(browserJSON(f.snapshot()))
	for _, denied := range []string{browserFixtureChartCode, browserFixtureChartPath, "Bearer", strings.Repeat("b", 48)} {
		if strings.Contains(status, denied) {
			t.Fatal("private fixture fields leaked into status")
		}
	}
}

func TestBrowserSyntheticChartModelSequence(t *testing.T) {
	f := newBrowserToolFixture(t)
	messages := []any{map[string]any{"role": "user", "content": "请做图表验收"}}
	for round, expected := range []string{"execute_code", "publish_artifact", "【成果:82000000-0000-4000-8000-000000000099】"} {
		recorder := httptest.NewRecorder()
		if !f.respondModel(recorder, browserJSON(map[string]any{"messages": messages})) {
			t.Fatal("chart trigger was not handled")
		}
		if recorder.Code != 200 || !strings.Contains(recorder.Body.String(), expected) {
			t.Fatalf("unexpected synthetic model round %d", round)
		}
		if round == 0 && !strings.Contains(recorder.Body.String(), "tool_calls") || round == 1 && strings.Contains(recorder.Body.String(), "execute_code") {
			t.Fatal("chart flow skipped or repeated code execution")
		}
		result := map[string]any{"ok": true}
		if round == 1 {
			result["artifact"] = map[string]any{"id": "82000000-0000-4000-8000-000000000099", "state": "ready"}
		}
		messages = append(messages, map[string]any{"role": "tool", "content": string(browserJSON(result))})
	}
}
