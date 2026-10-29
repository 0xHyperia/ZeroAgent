package account

import (
	"encoding/json"
	"net/http"
	"regexp"
	"sync"
	"time"
	_ "time/tzdata"
)

// This is an immutable per-Run configuration snapshot, not credentials or an
// alternative connection. The only wire is the fixed USA Chat Completions port.
type CloudRunModelParameters struct {
	RequestFormat     string   `json:"request_format,omitempty"`
	ContextWindow     int64    `json:"context_window,omitempty"`
	MaxOutputTokens   int64    `json:"max_output_tokens,omitempty"`
	InputModalities   []string `json:"input_modalities,omitempty"`
	ProviderCacheMode string   `json:"provider_cache_mode,omitempty"`
	ModelCacheMode    string   `json:"model_cache_mode,omitempty"`
	TimeZone          string   `json:"time_zone"`
	Locale            string   `json:"locale"`
}

var cloudLocalePattern = regexp.MustCompile(`^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$`)
var cloudTimeZones sync.Map

func cloudTimeZone(name string) (*time.Location, error) {
	if value, ok := cloudTimeZones.Load(name); ok {
		return value.(*time.Location), nil
	}
	location, err := time.LoadLocation(name)
	if err == nil {
		cloudTimeZones.Store(name, location)
	}
	return location, err
}

func cloudParameterError(reason, message string) error {
	return &APIError{Status: http.StatusBadRequest, Reason: reason, Message: message}
}

func normalizeCloudModelParameters(input CloudRunModelParameters) (CloudRunModelParameters, error) {
	if input.TimeZone == "" {
		input.TimeZone = "UTC"
	}
	if len(input.TimeZone) > 128 || input.TimeZone == "Local" {
		return input, cloudParameterError("model_time_zone_invalid", "time_zone must be a valid IANA time zone")
	}
	if _, err := cloudTimeZone(input.TimeZone); err != nil {
		return input, cloudParameterError("model_time_zone_invalid", "time_zone must be a valid IANA time zone")
	}
	if input.Locale == "" {
		input.Locale = "und"
	}
	if len(input.Locale) > 64 || !cloudLocalePattern.MatchString(input.Locale) {
		return input, cloudParameterError("model_locale_invalid", "locale must be a bounded language tag such as zh-HK or en-US")
	}
	if input.RequestFormat == "" {
		input.RequestFormat = "openai-completions"
	}
	if input.RequestFormat != "openai-completions" {
		return input, cloudParameterError("model_request_format_unsupported", "CloudChat currently supports only the platform Chat Completions request format")
	}
	if (input.ContextWindow != 0 && (input.ContextWindow < 1024 || input.ContextWindow > 2_000_000)) ||
		(input.MaxOutputTokens != 0 && (input.MaxOutputTokens < 128 || input.MaxOutputTokens > 1_000_000)) {
		return input, cloudParameterError("model_token_limits_invalid", "context_window must be 1024..2000000; max_output_tokens must be 128..1000000, or omitted for platform defaults")
	}
	if input.ContextWindow > 0 && input.MaxOutputTokens == 0 {
		input.MaxOutputTokens = min(int64(8192), input.ContextWindow/4)
	}
	if input.ContextWindow > 0 && input.MaxOutputTokens >= input.ContextWindow {
		return input, cloudParameterError("model_token_limits_invalid", "max_output_tokens must leave room for input within context_window")
	}
	if input.ProviderCacheMode == "" {
		input.ProviderCacheMode = "auto"
	}
	if (input.ProviderCacheMode != "auto" && input.ProviderCacheMode != "none") ||
		(input.ModelCacheMode != "" && input.ModelCacheMode != "auto" && input.ModelCacheMode != "none") {
		return input, cloudParameterError("model_cache_mode_unsupported", "CloudChat currently supports only auto or none cache hints; manual OpenAI/OpenRouter modes are not verified for all platform groups")
	}
	if len(input.InputModalities) == 0 {
		input.InputModalities = []string{"text", "image"}
	} else if len(input.InputModalities) == 1 && input.InputModalities[0] == "text" {
		input.InputModalities = []string{"text"}
	} else if len(input.InputModalities) == 2 && input.InputModalities[0] == "text" && input.InputModalities[1] == "image" {
		input.InputModalities = []string{"text", "image"}
	} else {
		return input, cloudParameterError("model_input_modalities_invalid", "input_modalities must be [text] or [text,image]")
	}
	return input, nil
}

func validCloudReasoningEffort(value string) bool {
	switch value {
	case "", "none", "minimal", "low", "medium", "high", "xhigh", "max":
		return true
	}
	return false
}

func cloneCloudModelParameters(input CloudRunModelParameters) CloudRunModelParameters {
	input.InputModalities = append([]string(nil), input.InputModalities...)
	return input
}

func cloudAllowsImage(input CloudRunModelParameters) bool {
	for _, modality := range input.InputModalities {
		if modality == "image" {
			return true
		}
	}
	return false
}

func cloudContainsImage(value any) bool {
	switch value := value.(type) {
	case json.RawMessage:
		var decoded any
		return json.Unmarshal(value, &decoded) == nil && cloudContainsImage(decoded)
	case []any:
		for _, part := range value {
			if cloudContainsImage(part) {
				return true
			}
		}
	case []map[string]any:
		for _, part := range value {
			if cloudContainsImage(part) {
				return true
			}
		}
	case map[string]any:
		if value["type"] == "image_url" {
			return true
		}
		for _, part := range value {
			if cloudContainsImage(part) {
				return true
			}
		}
	}
	return false
}

type cloudModelBudget struct {
	ContextWindow        int64  `json:"context_window"`
	EstimatedInputTokens int64  `json:"estimated_input_tokens"`
	ReservedOutputTokens int64  `json:"reserved_output_tokens"`
	ImageCount           int64  `json:"image_count"`
	Method               string `json:"method"`
}

// No universal exact tokenizer exists for the platform's mixed model families.
// This admission estimate uses UTF-8 JSON bytes / 3 and 4096 tokens per image;
// the provider remains authoritative. It never crops history or claims exact fit.
func estimateCloudModelBudget(parameters CloudRunModelParameters, messages []map[string]any, tools []map[string]any) cloudModelBudget {
	var images int64
	var visit func(any) any
	visit = func(value any) any {
		switch value := value.(type) {
		case []map[string]any:
			copy := make([]any, len(value))
			for index, part := range value {
				copy[index] = visit(part)
			}
			return copy
		case []any:
			copy := make([]any, len(value))
			for index, part := range value {
				copy[index] = visit(part)
			}
			return copy
		case json.RawMessage:
			var decoded any
			if json.Unmarshal(value, &decoded) == nil {
				return visit(decoded)
			}
		case map[string]any:
			if value["type"] == "image_url" {
				images++
				return map[string]any{"type": "image_url", "image_url": "[image bytes excluded from text estimate]"}
			}
			copy := make(map[string]any, len(value))
			for key, part := range value {
				copy[key] = visit(part)
			}
			return copy
		}
		return value
	}
	encoded, _ := json.Marshal(map[string]any{"messages": visit(messages), "tools": tools})
	return cloudModelBudget{ContextWindow: parameters.ContextWindow, EstimatedInputTokens: (int64(len(encoded))+2)/3 + images*4096 + int64(len(messages))*16, ReservedOutputTokens: parameters.MaxOutputTokens, ImageCount: images, Method: "utf8_bytes_div_3_plus_image_4096"}
}

func applyCloudModelParameters(payload map[string]any, parameters CloudRunModelParameters) {
	if parameters.MaxOutputTokens > 0 {
		payload["max_completion_tokens"] = parameters.MaxOutputTokens
	}
	if effectiveCloudCacheMode(parameters) == "none" {
		return
	}
	// ADR 0045: auto on Chat Completions only emits hints to official OpenAI or
	// OpenRouter hosts. USA is the fixed custom platform origin, so auto and none
	// both omit client hints. Its own server-side cache policy is independent.
}

func effectiveCloudCacheMode(parameters CloudRunModelParameters) string {
	if parameters.ModelCacheMode != "" {
		return parameters.ModelCacheMode
	}
	return parameters.ProviderCacheMode
}
