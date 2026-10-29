package account

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"unicode/utf8"
)

func cloudModelChunk(delta map[string]any, finish any, usage any) []byte {
	choice := map[string]any{"index": 0, "delta": delta}
	if finish != nil {
		choice["finish_reason"] = finish
	}
	chunk := map[string]any{"choices": []any{choice}}
	if usage != nil {
		chunk["usage"] = usage
	}
	data, _ := json.Marshal(chunk)
	return data
}
func cloudModelTool(index int, id, name, args string) map[string]any {
	return map[string]any{"index": index, "id": id, "type": "function", "function": map[string]any{"name": name, "arguments": args}}
}
func cloudModelToolsFrame(tools ...map[string]any) []byte {
	return cloudModelChunk(map[string]any{"tool_calls": tools}, nil, nil)
}
func requireModelCode(t *testing.T, err error, code string) {
	t.Helper()
	var typed *cloudModelStreamError
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("decoder error code got=%v want=%s", err, code)
	}
}

func TestCloudModelStreamInterleavedToolsNeedCompleteExplicitFinish(t *testing.T) {
	stream := newCloudModelStream([]string{"synthetic-secret-key"})
	frames := [][]byte{
		cloudModelToolsFrame(cloudModelTool(1, "call_b", "cloud_", `{"query":"`)),
		cloudModelToolsFrame(cloudModelTool(0, "call_a", "read_", `{"path":`)),
		cloudModelChunk(map[string]any{"content": "正在准备。", "tool_calls": []any{map[string]any{"index": 1, "function": map[string]any{"name": "search", "arguments": "资料\"}"}}}}, nil, nil),
		cloudModelToolsFrame(map[string]any{"index": 0, "id": "call_a", "type": "function", "function": map[string]any{"name": "file", "arguments": `"notes.txt"}`}}),
		cloudModelChunk(map[string]any{}, "tool_calls", map[string]any{"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12, "private": "synthetic-secret-key"}),
		[]byte("[DONE]"),
	}
	var delta strings.Builder
	for _, frame := range frames {
		update, err := stream.FeedSSE(frame)
		if err != nil {
			t.Fatal(err)
		}
		delta.WriteString(update.Delta)
	}
	round, err := stream.Finish()
	if err != nil {
		t.Fatal(err)
	}
	if round.Text != delta.String() || round.Text != "正在准备。" || round.FinishReason != "tool_calls" || len(round.ToolCalls) != 2 {
		t.Fatal("tool round did not preserve ordered text and complete calls")
	}
	if round.ToolCalls[0].ID != "call_a" || round.ToolCalls[0].Name != "read_file" || round.ToolCalls[0].Arguments != `{"path":"notes.txt"}` || round.ToolCalls[1].Name != "cloud_search" || round.ToolCalls[1].Arguments != "{\"query\":\"资料\"}" {
		t.Fatal("tool fragments did not assemble in index order")
	}
	if string(round.Usage) != `{"completion_tokens":2,"prompt_tokens":10,"total_tokens":12}` {
		t.Fatal("usage did not remain a numeric allowlist")
	}
	second, err := stream.Finish()
	if err != nil || string(cloudJSON(second)) != string(cloudJSON(round)) {
		t.Fatal("Finish was not idempotent")
	}
}

func TestCloudModelStreamMissingFinishCannotAuthorizeTools(t *testing.T) {
	for _, finish := range []string{"", "stop", "length", "content_filter", "tool_calls"} {
		t.Run("finish_"+finish, func(t *testing.T) {
			stream := newCloudModelStream(nil)
			if _, err := stream.FeedSSE(cloudModelChunk(map[string]any{"content": "safe partial"}, nil, nil)); err != nil {
				t.Fatal(err)
			}
			if finish != "tool_calls" {
				if _, err := stream.FeedSSE(cloudModelToolsFrame(cloudModelTool(0, "call_a", "tool", `{}`))); err != nil {
					t.Fatal(err)
				}
			}
			if finish != "" {
				if _, err := stream.FeedSSE(cloudModelChunk(map[string]any{}, finish, nil)); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := stream.FeedSSE([]byte("[DONE]")); err != nil {
				t.Fatal(err)
			}
			round, err := stream.Finish()
			code := "model_tool_invalid"
			if finish == "length" {
				code = "model_output_limit"
			}
			if finish == "content_filter" {
				code = "model_content_filtered"
			}
			requireModelCode(t, err, code)
			if len(round.ToolCalls) != 0 || round.Text != "safe partial" {
				t.Fatal("incomplete/failed tool round escaped or lost partial text")
			}
		})
	}
	stream := newCloudModelStream(nil)
	stream.FeedSSE(cloudModelChunk(map[string]any{"content": "partial"}, nil, nil))
	stream.FeedSSE([]byte("[DONE]"))
	round, err := stream.Finish()
	requireModelCode(t, err, "invalid_model_stream")
	if round.Text != "partial" {
		t.Fatal("transport-only terminator lost partial")
	}
	// A known finish_reason is itself explicit. An EOF after stop need not
	// invent a DONE event and cannot authorize calls when none were declared.
	stream = newCloudModelStream(nil)
	stream.FeedSSE(cloudModelChunk(map[string]any{"content": "complete"}, "stop", nil))
	round, err = stream.Finish()
	if err != nil || round.Text != "complete" {
		t.Fatal("explicit stop followed by EOF was lost")
	}
}

func TestCloudModelStreamRejectsToolIdentityAndIndexConflicts(t *testing.T) {
	for _, input := range []struct {
		name   string
		frames [][]byte
	}{
		{"changedID", [][]byte{cloudModelToolsFrame(cloudModelTool(0, "call_a", "tool", `{}`)), cloudModelToolsFrame(map[string]any{"index": 0, "id": "call_b"})}},
		{"duplicateIDs", [][]byte{cloudModelToolsFrame(cloudModelTool(0, "same", "first", `{}`), cloudModelTool(1, "same", "second", `{}`))}},
		{"indexGap", [][]byte{cloudModelToolsFrame(cloudModelTool(1, "call_a", "tool", `{}`))}},
		{"negativeIndex", [][]byte{cloudModelToolsFrame(cloudModelTool(-1, "call_a", "tool", `{}`))}},
		{"outOfRange", [][]byte{cloudModelToolsFrame(cloudModelTool(8, "call_a", "tool", `{}`))}},
		{"missingIndex", [][]byte{cloudModelToolsFrame(map[string]any{"id": "call_a", "type": "function", "function": map[string]any{"name": "tool", "arguments": "{}"}})}},
		{"duplicateFrameIndex", [][]byte{cloudModelToolsFrame(cloudModelTool(0, "call_a", "tool", `{}`), cloudModelTool(0, "call_a", "tool", `{}`))}},
		{"unknownType", [][]byte{cloudModelToolsFrame(map[string]any{"index": 0, "id": "call_a", "type": "object", "function": map[string]any{"name": "tool", "arguments": "{}"}})}},
		{"missingType", [][]byte{cloudModelToolsFrame(map[string]any{"index": 0, "id": "call_a", "function": map[string]any{"name": "tool", "arguments": "{}"}})}},
		{"longID", [][]byte{cloudModelToolsFrame(cloudModelTool(0, strings.Repeat("a", 201), "tool", `{}`))}},
		{"invalidName", [][]byte{cloudModelToolsFrame(cloudModelTool(0, "call_a", "tool.name", `{}`))}},
		{"longName", [][]byte{cloudModelToolsFrame(cloudModelTool(0, "call_a", strings.Repeat("a", 65), `{}`))}},
		{"argumentsLimit", [][]byte{cloudModelToolsFrame(cloudModelTool(0, "call_a", "tool", `{"value":"`+strings.Repeat("a", cloudModelMaxArguments)+`"}`))}},
	} {
		t.Run(input.name, func(t *testing.T) {
			stream := newCloudModelStream(nil)
			var feedErr error
			for _, frame := range input.frames {
				if _, feedErr = stream.FeedSSE(frame); feedErr != nil {
					break
				}
			}
			if feedErr == nil {
				_, feedErr = stream.FeedSSE(cloudModelChunk(map[string]any{}, "tool_calls", nil))
			}
			round, err := stream.Finish()
			if feedErr != nil {
				requireModelCode(t, feedErr, "model_tool_invalid")
			}
			requireModelCode(t, err, "model_tool_invalid")
			if len(round.ToolCalls) != 0 {
				t.Fatal("invalid tool identity was executable")
			}
		})
	}
}

func TestCloudModelStreamArgumentsAreStrictObjectsAndDecodedSecretsAreRejected(t *testing.T) {
	for _, arguments := range []string{"", `[]`, `null`, `"string"`, `{"incomplete":`, `{"a":1}{"b":2}`, `{"a":1,"a":2}`, `{"a":1,"\u0061":2}`, `{"value":"\ud800"}`, `{"value":"\udc00"}`, `{"value":` + strings.Repeat("[", 34) + `0` + strings.Repeat("]", 34) + `}`} {
		stream := newCloudModelStream(nil)
		stream.FeedSSE(cloudModelToolsFrame(cloudModelTool(0, "call_a", "tool", arguments)))
		stream.FeedSSE(cloudModelChunk(map[string]any{}, "tool_calls", nil))
		round, err := stream.Finish()
		requireModelCode(t, err, "model_tool_invalid")
		if len(round.ToolCalls) != 0 {
			t.Fatal("invalid arguments escaped")
		}
	}
	for _, arguments := range []string{`{"value":"synthetic-secret-key"}`, `{"value":"synthetic\u002dsecret\u002dkey"}`, `{"synthetic\u002dsecret-key":"value"}`, `{"nested":[{"key":"` + base64.StdEncoding.EncodeToString([]byte("synthetic-secret-key")) + `"}]}`} {
		stream := newCloudModelStream([]string{"synthetic-secret-key"})
		stream.FeedSSE(cloudModelToolsFrame(cloudModelTool(0, "call_a", "tool", arguments)))
		stream.FeedSSE(cloudModelChunk(map[string]any{}, "tool_calls", nil))
		round, err := stream.Finish()
		requireModelCode(t, err, "model_secret_reflection")
		if len(round.ToolCalls) != 0 || strings.Contains(string(cloudJSON(round)), "synthetic-secret-key") {
			t.Fatal("secret tool arguments were published")
		}
	}
	stream := newCloudModelStream(nil)
	stream.FeedSSE(cloudModelToolsFrame(cloudModelTool(0, "call_a", "tool", `{"emoji":"\ud83d`)))
	stream.FeedSSE(cloudModelToolsFrame(map[string]any{"index": 0, "function": map[string]any{"arguments": `\ude00"}`}}))
	stream.FeedSSE(cloudModelChunk(map[string]any{}, "tool_calls", nil))
	round, err := stream.Finish()
	if err != nil || len(round.ToolCalls) != 1 {
		t.Fatal("valid split UTF-16 escape pair was rejected")
	}
}

func TestCloudModelStreamTextRedactionAndSafeFailureTails(t *testing.T) {
	secret := "synthetic-secret-key"
	for _, finish := range []string{"stop", "length", "content_filter", ""} {
		t.Run("finish_"+finish, func(t *testing.T) {
			stream := newCloudModelStream([]string{secret})
			var emitted strings.Builder
			for _, text := range []string{"safe synthetic-", "secret-", "key / ", base64.StdEncoding.EncodeToString([]byte(secret))[:10], base64.StdEncoding.EncodeToString([]byte(secret))[10:], " end syn"} {
				update, err := stream.FeedSSE(cloudModelChunk(map[string]any{"content": text}, nil, nil))
				if err != nil {
					t.Fatal(err)
				}
				emitted.WriteString(update.Delta)
				if strings.Contains(emitted.String(), secret) {
					t.Fatal("a credential escaped before the next frame")
				}
			}
			if finish != "" {
				update, err := stream.FeedSSE(cloudModelChunk(map[string]any{}, finish, nil))
				if err != nil {
					t.Fatal(err)
				}
				emitted.WriteString(update.Delta)
			}
			round, err := stream.Finish()
			if finish == "stop" && err != nil {
				t.Fatal(err)
			}
			if finish == "length" {
				requireModelCode(t, err, "model_output_limit")
			}
			if finish == "content_filter" {
				requireModelCode(t, err, "model_content_filtered")
			}
			if finish == "" {
				requireModelCode(t, err, "invalid_model_stream")
			}
			if strings.Contains(round.Text, secret) || strings.Contains(round.Text, base64.StdEncoding.EncodeToString([]byte(secret))) || !strings.Contains(round.Text, "[redacted]") || !strings.HasSuffix(round.Text, " end syn") || !utf8.ValidString(round.Text) {
				t.Fatal("safe accumulated round text was incomplete or private")
			}
			if !strings.HasPrefix(round.Text, emitted.String()) {
				t.Fatal("Finish changed an already emitted prefix")
			}
		})
	}
}

func TestCloudModelStreamUnknownFinishAndMalformedFramesAreSticky(t *testing.T) {
	for _, frame := range [][]byte{
		[]byte(`{"choices":[{"index":0,"delta":{"content":"\ud800"}}]}`),
		{0xff, 0xfe}, []byte(`not JSON`), []byte(`{"choices":[]} {}`),
		[]byte(`{"choices":[{"index":1,"delta":{"content":"wrong"}}]}`),
		[]byte(`{"choices":[{"index":0,"delta":{}},{"index":1,"delta":{}}]}`),
		cloudModelChunk(map[string]any{}, "unknown_private_finish", nil),
		[]byte(strings.Repeat(" ", CloudRunMaxEventBytes+1)),
	} {
		stream := newCloudModelStream(nil)
		_, err := stream.FeedSSE(frame)
		requireModelCode(t, err, "invalid_model_stream")
		round, finishErr := stream.Finish()
		requireModelCode(t, finishErr, "invalid_model_stream")
		if round.Text != "" || len(round.ToolCalls) != 0 {
			t.Fatal("malformed frame supplied usable data")
		}
	}
	stream := newCloudModelStream(nil)
	stream.FeedSSE(cloudModelChunk(map[string]any{"content": "partial"}, "stop", nil))
	_, err := stream.FeedSSE(cloudModelChunk(map[string]any{"content": "after finish"}, nil, nil))
	requireModelCode(t, err, "invalid_model_stream")
	round, err := stream.Finish()
	requireModelCode(t, err, "invalid_model_stream")
	if round.Text != "partial" {
		t.Fatal("trailing content changed a finished round")
	}
}

func TestCloudModelStreamUsageOnlyAndTextLimits(t *testing.T) {
	stream := newCloudModelStream(nil)
	stream.FeedSSE(cloudModelChunk(map[string]any{"content": "text"}, "stop", map[string]any{"prompt_tokens": 2, "negative": -1, "completion_tokens": -1, "bad": "secret"}))
	update, err := stream.FeedSSE([]byte(`{"choices":[],"usage":{"completion_tokens":3,"total_tokens":5,"input_tokens":"2","output_tokens":1.5,"secret":"private"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if string(update.Usage) != `{"completion_tokens":3,"prompt_tokens":2,"total_tokens":5}` {
		t.Fatal("usage did not normalize partial numeric fields")
	}
	round, err := stream.Finish()
	if err != nil || string(round.Usage) != string(update.Usage) {
		t.Fatal("usage-only trailer was lost")
	}
	stream = newCloudModelStream(nil)
	frame := cloudModelChunk(map[string]any{"content": strings.Repeat("a", 64<<10)}, nil, nil)
	for i := 0; i < CloudRunMaxOutputBytes/(64<<10); i++ {
		if _, err = stream.FeedSSE(frame); err != nil {
			t.Fatal(err)
		}
	}
	_, err = stream.FeedSSE(cloudModelChunk(map[string]any{"content": "x"}, nil, nil))
	requireModelCode(t, err, "model_output_limit")
	round, err = stream.Finish()
	requireModelCode(t, err, "model_output_limit")
	if len(round.Text) != CloudRunMaxOutputBytes || len(round.ToolCalls) != 0 {
		t.Fatal("output limit lost bounded partial or exposed calls")
	}
}
