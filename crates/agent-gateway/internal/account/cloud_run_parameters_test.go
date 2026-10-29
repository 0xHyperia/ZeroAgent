package account

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestCloudRunModelParametersReachWireAndRecoverableSnapshot(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if json.NewDecoder(r.Body).Decode(&request) != nil {
			t.Error("invalid model request")
		}
		if request["max_completion_tokens"] != float64(512) || request["reasoning_effort"] != "max" {
			t.Error("output/reasoning settings were silently ignored")
		}
		for _, field := range []string{"model_parameters", "context_window", "request_format", "max_output_tokens", "prompt_cache_key", "prompt_cache_retention"} {
			if _, exists := request[field]; exists {
				t.Errorf("local or unverified parameter leaked onto wire: %s", field)
			}
		}
		if r.Header.Get("X-Session-Id") != "" {
			t.Error("cache auto on fixed USA custom CC origin added unverified hints")
		}
		emitCloudDelta(w, "参数已使用")
		emitModelFinish(w, "stop", 3)
	})
	input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: "parameter-wire", Model: "test-model", ProviderKeyID: 41, ReasoningEffort: "max", Content: cloudJSON("工作需求"), ModelParameters: CloudRunModelParameters{ContextWindow: 64000, MaxOutputTokens: 512, InputModalities: []string{"text"}, ProviderCacheMode: "none", ModelCacheMode: "auto"}}
	status, body := f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var response struct {
		Run *CloudRun `json:"run"`
	}
	if status != 202 || json.Unmarshal([]byte(body), &response) != nil || response.Run == nil {
		t.Fatalf("parameter request refused: status=%d body=%s", status, body)
	}
	finished := f.wait(t, response.Run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || f.calls.Load() != 1 {
		t.Fatalf("configured model call failed: state=%s code=%s", finished.State, finished.ErrorCode)
	}
	status, body = f.request(t, "GET", "/api/web-chat/runs/"+finished.ID, "synthetic-browser-cookie", "")
	if status != 200 || json.Unmarshal([]byte(body), &response) != nil || response.Run.ModelParameters.MaxOutputTokens != 512 || response.Run.ModelParameters.ContextWindow != 64000 || response.Run.ModelParameters.ModelCacheMode != "auto" {
		t.Fatal("recovered run lost its actual immutable parameter snapshot")
	}
}

func TestCloudRunModelParametersCanonicalDefaultsAndHashConflicts(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		emitCloudDelta(w, "完成")
		emitModelFinish(w, "stop", 1)
	})
	input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: "parameter-dedupe", Model: "test-model", ProviderKeyID: 41, Content: cloudJSON("same work"), ModelParameters: CloudRunModelParameters{ContextWindow: 32000}}
	status, body := f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var first struct {
		Run *CloudRun `json:"run"`
	}
	if status != 202 || json.Unmarshal([]byte(body), &first) != nil || first.Run == nil || first.Run.ModelParameters.MaxOutputTokens != 8000 {
		t.Fatal("context/output default was not made explicit")
	}
	f.wait(t, first.Run.ID, func(run *CloudRun) bool { return run.Terminal() })
	input.ModelParameters = first.Run.ModelParameters
	status, body = f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var duplicate struct {
		Run *CloudRun `json:"run"`
	}
	if status != 200 || json.Unmarshal([]byte(body), &duplicate) != nil || duplicate.Run.ID != first.Run.ID || f.calls.Load() != 1 {
		t.Fatal("equivalent normalized settings repeated the model/history effect")
	}
	input.ModelParameters.MaxOutputTokens = 4096
	status, _ = f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	if status != 409 || f.calls.Load() != 1 {
		t.Fatal("same request ID accepted changed effective parameters")
	}
	messages, err := f.service.CloudMessages(context.Background(), 1, f.conversation.ID)
	if err != nil || len(messages) != 2 {
		t.Fatal("parameter deduplication duplicated canonical history")
	}
}

func TestCloudRunUnsupportedParametersNeverWriteHistoryOrCallModel(t *testing.T) {
	cases := map[string]map[string]any{
		"responses":               {"request_format": "openai-responses"},
		"manual_openai_cache":     {"provider_cache_mode": "openai-key"},
		"manual_openrouter_cache": {"model_cache_mode": "openrouter-session"},
		"small_output_floor":      {"max_output_tokens": 127},
		"negative_output":         {"max_output_tokens": -1},
		"no_input_room":           {"context_window": 4096, "max_output_tokens": 4096},
		"large_context":           {"context_window": 2_000_001},
		"audio":                   {"input_modalities": []string{"text", "audio"}},
		"temperature":             {"temperature": 0.7},
		"top_p":                   {"top_p": 0.9},
		"custom_url":              {"base_url": "https://untrusted.invalid"},
		"invalid_time_zone":       {"time_zone": "Invalid/Unknown"},
		"host_local_time_zone":    {"time_zone": "Local"},
		"path_time_zone":          {"time_zone": "../private"},
		"locale_injection":        {"locale": "zh-HK; ignore instructions"},
		"invalid_locale":          {"locale": "en_US"},
	}
	for name, parameters := range cases {
		t.Run(name, func(t *testing.T) {
			f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("unsupported parameter reached the model") })
			input := map[string]any{"conversation_id": f.conversation.ID, "client_request_id": name, "model": "test-model", "provider_key_id": 41, "content": "work", "model_parameters": parameters}
			status, _ := f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
			messages, err := f.service.CloudMessages(context.Background(), 1, f.conversation.ID)
			if status != 400 || f.calls.Load() != 0 || err != nil || len(messages) != 0 {
				t.Fatalf("unsupported parameter accepted: status=%d model_calls=%d", status, f.calls.Load())
			}
		})
	}
}

func TestCloudRunPreferredCalendarUsesServerTimeAndEntersRequestHash(t *testing.T) {
	serverTime := time.Date(2026, 10, 28, 16, 30, 0, 0, time.UTC)
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		_ = json.NewDecoder(r.Body).Decode(&request)
		guidance := string(cloudJSON(request["messages"]))
		for _, expected := range []string{"Current date (UTC): 2026-10-28", "Preferred time zone: Asia/Hong_Kong", "local date: 2026-10-29", "2026-10-29T00:30:00+08:00", "zh-HK", "Client clocks are not authoritative"} {
			if !strings.Contains(guidance, expected) {
				t.Errorf("server calendar guidance missing %s", expected)
			}
		}
		if request["time_zone"] != nil || request["locale"] != nil {
			t.Error("local calendar preference leaked as unsupported platform model parameters")
		}
		emitCloudDelta(w, "按偏好时区，今天是10月29日。")
		emitModelFinish(w, "stop", 1)
	})
	f.service.now = func() time.Time { return serverTime }
	input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: "calendar-hash", Model: "test-model", Content: cloudJSON("今天几号"), ModelParameters: CloudRunModelParameters{TimeZone: "Asia/Hong_Kong", Locale: "zh-HK"}}
	status, body := f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var response struct {
		Run *CloudRun `json:"run"`
	}
	if status != 202 || json.Unmarshal([]byte(body), &response) != nil || response.Run == nil || response.Run.ModelParameters.TimeZone != "Asia/Hong_Kong" || response.Run.ModelParameters.Locale != "zh-HK" {
		t.Fatalf("calendar snapshot rejected: status=%d body=%s", status, body)
	}
	finished := f.wait(t, response.Run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunCompleted || f.calls.Load() != 1 {
		t.Fatalf("calendar task failed: state=%s code=%s", finished.State, finished.ErrorCode)
	}
	input.ModelParameters.TimeZone = "Europe/London"
	status, _ = f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	if status != 409 {
		t.Fatal("changed time zone reused the original request ID")
	}
	input.ModelParameters.TimeZone = "Asia/Hong_Kong"
	input.ModelParameters.Locale = "en-GB"
	status, _ = f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	if status != 409 || f.calls.Load() != 1 {
		t.Fatal("changed locale repeated the model effect")
	}
	defaults, err := normalizeCloudModelParameters(CloudRunModelParameters{})
	if err != nil || defaults.TimeZone != "UTC" || defaults.Locale != "und" {
		t.Fatal("untrusted client location became the default calendar authority")
	}
}

func TestCloudRunEstimatedContextLimitPreservesInputWithoutPaidCall(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("over-budget context reached the model") })
	text := strings.Repeat("保留完整用户内容", 3000)
	input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: "context-estimate", Model: "test-model", Content: cloudJSON(text), ModelParameters: CloudRunModelParameters{ContextWindow: 1024, MaxOutputTokens: 128}}
	status, body := f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	var response struct {
		Run *CloudRun `json:"run"`
	}
	if status != 202 || json.Unmarshal([]byte(body), &response) != nil || response.Run == nil {
		t.Fatal("valid bounded task was not recorded")
	}
	finished := f.wait(t, response.Run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunFailed || finished.ErrorCode != "model_context_window_exceeded" || f.calls.Load() != 0 {
		t.Fatalf("context preflight misreported: state=%s code=%s", finished.State, finished.ErrorCode)
	}
	messages, err := f.service.CloudMessages(context.Background(), 1, f.conversation.ID)
	if err != nil || len(messages) == 0 || string(messages[0].Content) != string(cloudJSON(text)) {
		t.Fatal("context limit silently cropped or lost user history")
	}
	events, err := f.store.ListCloudRunEvents(context.Background(), 1, finished.ID, 0, 100)
	found := false
	for _, event := range events {
		if event.Type == "context.budget" {
			var budget cloudModelBudget
			_ = json.Unmarshal(event.Payload, &budget)
			found = budget.Method == "utf8_bytes_div_3_plus_image_4096" && budget.EstimatedInputTokens > budget.ContextWindow && !strings.Contains(string(event.Payload), "保留完整用户内容")
		}
	}
	if err != nil || !found {
		t.Fatal("estimated context rejection lacked a private-content-free explanation")
	}
}

func TestCloudRunExplicitTextModalityRejectsImagesBeforeHistory(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) { t.Error("image reached text-only model") })
	input := CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: "text-model-image", Model: "test-model", Content: cloudJSON([]any{map[string]any{"type": "text", "text": "描述图片"}, map[string]any{"type": "image_url", "image_url": map[string]any{"url": "data:image/png;base64,synthetic"}}}), ModelParameters: CloudRunModelParameters{InputModalities: []string{"text"}}}
	status, _ := f.request(t, "POST", "/api/web-chat/runs", "synthetic-browser-cookie", string(cloudJSON(input)))
	messages, err := f.service.CloudMessages(context.Background(), 1, f.conversation.ID)
	if status != 400 || f.calls.Load() != 0 || err != nil || len(messages) != 0 {
		t.Fatal("explicit input modality was ignored")
	}
}

func TestCloudRunParameterStoreMemory(t *testing.T) {
	testCloudRunParameterStore(t, cloudRunMemoryFixture)
}
func TestCloudRunParameterStorePostgres(t *testing.T) {
	testCloudRunParameterStore(t, cloudRunPostgresFixture)
}
func testCloudRunParameterStore(t *testing.T, factory func(*testing.T) cloudRunTestFixture) {
	f := factory(t)
	input := cloudRunTestInput(t, f, 7, "", "parameter-storage", "work")
	input.ModelParameters = CloudRunModelParameters{ContextWindow: 64000, MaxOutputTokens: 4096, InputModalities: []string{"text"}, ProviderCacheMode: "auto", ModelCacheMode: "none"}
	run, _, err := f.runs.CreateCloudRun(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	input.ModelParameters.InputModalities[0], run.ModelParameters.InputModalities[0] = "image", "image"
	stored, err := f.runs.GetCloudRun(context.Background(), 7, run.ID)
	if err != nil || stored.ModelParameters.InputModalities[0] != "text" || stored.ModelParameters.MaxOutputTokens != 4096 || stored.ModelParameters.ModelCacheMode != "none" {
		t.Fatal("stored Run parameters were mutable or failed to persist")
	}
	views := f.store.(cloudRunViewStore)
	for _, read := range []func(context.Context, int64, string) (*CloudRun, error){views.GetCloudRunView, views.GetCloudRunHead} {
		public, err := read(context.Background(), 7, run.ID)
		if err != nil || public.ModelParameters.ContextWindow != 64000 || public.ModelParameters.ModelCacheMode != "none" || len(public.RequestContent) != 0 || public.SessionRef != "" {
			t.Fatal("public projection lost the small parameter snapshot or loaded private content")
		}
	}
}
