package account

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"io"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

const cloudModelMaxCalls = 8
const cloudModelMaxArguments = 64 << 10

type cloudModelStreamError struct{ Code string }

func (e *cloudModelStreamError) Error() string { return e.Code }

type cloudModelToolCall struct {
	Index               int
	ID, Name, Arguments string
}
type cloudModelRound struct {
	Reasoning    string
	Text         string
	ToolCalls    []cloudModelToolCall
	FinishReason string
	Usage        json.RawMessage
}
type cloudModelStreamUpdate struct {
	ReasoningDelta string
	Delta          string
	Usage          json.RawMessage
}
type cloudModelPendingCall struct {
	cloudModelToolCall
	kind      string
	arguments strings.Builder
}

// This parser never executes or publishes partial tool calls. IDs are stable
// complete fields in normalized CC; only names and arguments are fragments.
type cloudModelStream struct {
	reasoningFilter   *cloudSecretFilter
	reasoning         strings.Builder
	rawReasoningBytes int
	filter            *cloudSecretFilter
	secrets           []string
	text              strings.Builder
	rawTextBytes      int
	calls             map[int]*cloudModelPendingCall
	usage             map[string]int64
	finish            string
	done, finalized   bool
	sticky            *cloudModelStreamError
}

func (s *cloudModelStream) String() string   { return "cloudModelStream(redacted)" }
func (s *cloudModelStream) GoString() string { return "cloudModelStream(redacted)" }

func newCloudModelStream(secrets []string) *cloudModelStream {
	private := make([]string, 0, len(secrets)*3)
	seen := make(map[string]bool)
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		for _, encoded := range []string{secret, base64.StdEncoding.EncodeToString([]byte(secret)), base64.RawURLEncoding.EncodeToString([]byte(secret))} {
			if encoded != "" && !seen[encoded] {
				private = append(private, encoded)
				seen[encoded] = true
			}
		}
	}
	return &cloudModelStream{reasoningFilter: newCloudSecretFilter(private...), filter: newCloudSecretFilter(private...), secrets: private, calls: make(map[int]*cloudModelPendingCall), usage: make(map[string]int64)}
}

func (s *cloudModelStream) fail(code string) error {
	if s.sticky == nil {
		s.sticky = &cloudModelStreamError{Code: code}
	}
	return s.sticky
}
func (s *cloudModelStream) hasSecret(value string) bool {
	for _, secret := range s.secrets {
		if strings.Contains(value, secret) {
			return true
		}
	}
	return false
}

func (s *cloudModelStream) appendSafe(value string) (string, error) {
	if s.text.Len()+len(value) > CloudRunMaxOutputBytes {
		return "", s.fail("model_output_limit")
	}
	s.text.WriteString(value)
	return value, nil
}
func (s *cloudModelStream) finishText() (string, error) { return s.appendSafe(s.filter.finish()) }

func (s *cloudModelStream) FeedSSE(data []byte) (cloudModelStreamUpdate, error) {
	var update cloudModelStreamUpdate
	if s == nil {
		return update, &cloudModelStreamError{Code: "invalid_model_stream"}
	}
	if s.sticky != nil {
		return update, s.sticky
	}
	if s.done || s.finalized {
		return update, s.fail("invalid_model_stream")
	}
	if len(data) == 0 || len(data) > CloudRunMaxEventBytes || !utf8.Valid(data) || !validCloudModelSurrogates(data) {
		return update, s.fail("invalid_model_stream")
	}
	if bytes.Equal(bytes.TrimSpace(data), []byte("[DONE]")) {
		s.done = true
		var err error
		update.Delta, err = s.finishText()
		if err == nil {
			update.ReasoningDelta, err = s.finishReasoning()
		}
		return update, err
	}
	var chunk struct {
		Choices []struct {
			Index *int `json:"index"`
			Delta struct {
				Content          *string         `json:"content"`
				ReasoningContent json.RawMessage `json:"reasoning_content"`
				Reasoning        json.RawMessage `json:"reasoning"`
				ToolCalls        json.RawMessage `json:"tool_calls"`
				FunctionCall     json.RawMessage `json:"function_call"`
			} `json:"delta"`
			FinishReason *string `json:"finish_reason"`
		} `json:"choices"`
		Usage json.RawMessage `json:"usage"`
		Error json.RawMessage `json:"error"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	if decoder.Decode(&chunk) != nil {
		return update, s.fail("invalid_model_stream")
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return update, s.fail("invalid_model_stream")
	}
	if len(chunk.Error) > 0 && string(chunk.Error) != "null" {
		return update, s.fail("model_request_failed")
	}
	if len(chunk.Choices) > 1 {
		return update, s.fail("invalid_model_stream")
	}
	// Usage is a numeric allowlist. Unknown fields, including reflected strings,
	// never survive into public events, storage or the next model round.
	if len(chunk.Usage) > 0 && string(chunk.Usage) != "null" {
		var raw map[string]json.RawMessage
		if json.Unmarshal(chunk.Usage, &raw) == nil {
			changed := false
			for _, key := range []string{"prompt_tokens", "completion_tokens", "total_tokens", "input_tokens", "output_tokens"} {
				var value int64
				if part, exists := raw[key]; exists && json.Unmarshal(part, &value) == nil && value >= 0 {
					s.usage[key] = value
					changed = true
				}
			}
			if changed {
				update.Usage, _ = json.Marshal(s.usage)
			}
		}
	}
	for _, choice := range chunk.Choices {
		if choice.Index != nil && *choice.Index != 0 {
			return update, s.fail("invalid_model_stream")
		}
		toolData := choice.Delta.ToolCalls
		hasTools := len(toolData) > 0 && string(toolData) != "null" && string(toolData) != "[]"
		hasLegacy := len(choice.Delta.FunctionCall) > 0 && string(choice.Delta.FunctionCall) != "null"
		if hasLegacy {
			return update, s.fail("model_tool_invalid")
		}
		// Only explicit text is a public display field. Providers may also send
		// structured reasoning metadata; ignore that without breaking content.
		rawReasoning := choice.Delta.ReasoningContent
		if len(rawReasoning) == 0 || string(rawReasoning) == "null" {
			rawReasoning = choice.Delta.Reasoning
		}
		var reasoning *string
		var reasoningText string
		if len(rawReasoning) > 0 && string(rawReasoning) != "null" && json.Unmarshal(rawReasoning, &reasoningText) == nil {
			reasoning = &reasoningText
		}
		if s.finish != "" && (reasoning != nil && *reasoning != "" || choice.Delta.Content != nil && *choice.Delta.Content != "" || hasTools || choice.FinishReason != nil && *choice.FinishReason != "") {
			return update, s.fail("invalid_model_stream")
		}
		if choice.Delta.Content != nil {
			text := *choice.Delta.Content
			if !utf8.ValidString(text) || s.rawTextBytes+len(text) > CloudRunMaxOutputBytes {
				return update, s.fail("model_output_limit")
			}
			s.rawTextBytes += len(text)
			delta, err := s.appendSafe(s.filter.write(text))
			update.Delta += delta
			if err != nil {
				return update, err
			}
		}
		if reasoning != nil {
			if !utf8.ValidString(*reasoning) || s.rawReasoningBytes+len(*reasoning) > cloudModelMaxReasoningBytes {
				return update, s.fail("model_output_limit")
			}
			s.rawReasoningBytes += len(*reasoning)
			delta, err := s.appendReasoning(s.reasoningFilter.write(*reasoning))
			update.ReasoningDelta += delta
			if err != nil {
				return update, err
			}
		}
		if hasTools {
			if err := s.consumeTools(toolData); err != nil {
				return update, err
			}
		}
		if choice.FinishReason != nil && *choice.FinishReason != "" {
			switch *choice.FinishReason {
			case "stop", "tool_calls", "length", "content_filter":
				s.finish = *choice.FinishReason
			default:
				return update, s.fail("invalid_model_stream")
			}
			delta, err := s.finishText()
			update.Delta += delta
			if err != nil {
				return update, err
			}
			reasoningDelta, err := s.finishReasoning()
			update.ReasoningDelta += reasoningDelta
			if err != nil {
				return update, err
			}
		}
	}
	return update, nil
}

func (s *cloudModelStream) consumeTools(raw json.RawMessage) error {
	var fragments []struct {
		Index    *int    `json:"index"`
		ID       *string `json:"id"`
		Type     *string `json:"type"`
		Function *struct {
			Name      *string `json:"name"`
			Arguments *string `json:"arguments"`
		} `json:"function"`
	}
	if json.Unmarshal(raw, &fragments) != nil || len(fragments) > cloudModelMaxCalls {
		return s.fail("model_tool_invalid")
	}
	seen := make(map[int]bool)
	for _, fragment := range fragments {
		if fragment.Index == nil || *fragment.Index < 0 || *fragment.Index >= cloudModelMaxCalls || seen[*fragment.Index] {
			return s.fail("model_tool_invalid")
		}
		index := *fragment.Index
		seen[index] = true
		call := s.calls[index]
		if call == nil {
			if len(s.calls) >= cloudModelMaxCalls {
				return s.fail("model_tool_invalid")
			}
			call = &cloudModelPendingCall{cloudModelToolCall: cloudModelToolCall{Index: index}}
			s.calls[index] = call
		}
		if fragment.ID != nil && *fragment.ID != "" {
			if len(*fragment.ID) > 200 || call.ID != "" && call.ID != *fragment.ID {
				return s.fail("model_tool_invalid")
			}
			call.ID = *fragment.ID
		}
		if fragment.Type != nil && *fragment.Type != "" {
			if *fragment.Type != "function" || call.kind != "" && call.kind != *fragment.Type {
				return s.fail("model_tool_invalid")
			}
			call.kind = *fragment.Type
		}
		if fragment.Function != nil {
			if fragment.Function.Name != nil {
				if len(call.Name)+len(*fragment.Function.Name) > 64 {
					return s.fail("model_tool_invalid")
				}
				call.Name += *fragment.Function.Name
			}
			if fragment.Function.Arguments != nil {
				if call.arguments.Len()+len(*fragment.Function.Arguments) > cloudModelMaxArguments {
					return s.fail("model_tool_invalid")
				}
				call.arguments.WriteString(*fragment.Function.Arguments)
			}
		}
		if s.hasSecret(call.ID) || s.hasSecret(call.Name) {
			return s.fail("model_secret_reflection")
		}
	}
	return nil
}

// Finish is idempotent. Even errors return safe text/usage for the runtime to
// flush. EOF can finish a round only after an explicit known finish reason;
// [DONE] is transport framing, never permission to infer stop or execute tools.
func (s *cloudModelStream) Finish() (*cloudModelRound, error) {
	if s == nil {
		return nil, &cloudModelStreamError{Code: "invalid_model_stream"}
	}
	if !s.finalized {
		s.finalized = true
		if _, err := s.finishText(); err != nil {
			return s.safeRound(), err
		}
		if _, err := s.finishReasoning(); err != nil {
			return s.safeRound(), err
		}
	}
	round := s.safeRound()
	if s.sticky != nil {
		return round, s.sticky
	}
	switch s.finish {
	case "length":
		return round, s.fail("model_output_limit")
	case "content_filter":
		return round, s.fail("model_content_filtered")
	case "stop":
		if len(s.calls) != 0 {
			return round, s.fail("model_tool_invalid")
		}
		return round, nil
	case "tool_calls":
		if len(s.calls) == 0 {
			return round, s.fail("model_tool_invalid")
		}
	default:
		if len(s.calls) > 0 {
			return round, s.fail("model_tool_invalid")
		}
		return round, s.fail("invalid_model_stream")
	}
	ids := make(map[string]bool)
	calls := make([]cloudModelToolCall, 0, len(s.calls))
	indexes := make([]int, 0, len(s.calls))
	for index := range s.calls {
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	for position, index := range indexes {
		call := s.calls[index]
		call.Arguments = call.arguments.String()
		if index != position || call.kind != "function" || !cloudModelIdentifier(call.ID, 200, true) || !cloudModelIdentifier(call.Name, 64, false) || ids[call.ID] {
			return round, s.fail("model_tool_invalid")
		}
		ids[call.ID] = true
		if s.hasSecret(call.ID) || s.hasSecret(call.Name) || s.hasSecret(call.Arguments) {
			return round, s.fail("model_secret_reflection")
		}
		if code := validateCloudModelArguments(call.Arguments, s.hasSecret); code != "" {
			return round, s.fail(code)
		}
		calls = append(calls, call.cloudModelToolCall)
	}
	round.ToolCalls = calls
	return round, nil
}

func (s *cloudModelStream) safeRound() *cloudModelRound {
	var usage json.RawMessage
	if len(s.usage) > 0 {
		usage, _ = json.Marshal(s.usage)
	}
	return &cloudModelRound{Reasoning: s.reasoning.String(), Text: s.text.String(), FinishReason: s.finish, Usage: usage}
}
func cloudModelIdentifier(value string, max int, id bool) bool {
	if value == "" || len(value) > max || !utf8.ValidString(value) {
		return false
	}
	for _, char := range value {
		if char == '-' || char == '_' || char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || id && (char == '.' || char == ':') {
			continue
		}
		return false
	}
	return true
}

func validateCloudModelArguments(arguments string, secret func(string) bool) string {
	if len(arguments) == 0 || len(arguments) > cloudModelMaxArguments || !utf8.ValidString(arguments) || !validCloudModelSurrogates([]byte(arguments)) {
		return "model_tool_invalid"
	}
	decoder := json.NewDecoder(strings.NewReader(arguments))
	decoder.UseNumber()
	first, err := decoder.Token()
	if err != nil || first != json.Delim('{') {
		return "model_tool_invalid"
	}
	var walk func(json.Token, int) string
	walk = func(token json.Token, depth int) string {
		if depth > 32 {
			return "model_tool_invalid"
		}
		switch value := token.(type) {
		case json.Delim:
			if value != '{' && value != '[' {
				return "model_tool_invalid"
			}
			keys := make(map[string]bool)
			for decoder.More() {
				if value == '{' {
					keyToken, keyErr := decoder.Token()
					key, ok := keyToken.(string)
					if keyErr != nil || !ok || keys[key] {
						return "model_tool_invalid"
					}
					if secret(key) {
						return "model_secret_reflection"
					}
					keys[key] = true
				}
				next, nextErr := decoder.Token()
				if nextErr != nil {
					return "model_tool_invalid"
				}
				if code := walk(next, depth+1); code != "" {
					return code
				}
			}
			end, endErr := decoder.Token()
			expected := json.Delim('}')
			if value == '[' {
				expected = ']'
			}
			if endErr != nil || end != expected {
				return "model_tool_invalid"
			}
		case string:
			if secret(value) {
				return "model_secret_reflection"
			}
		case json.Number:
			if secret(value.String()) {
				return "model_secret_reflection"
			}
		}
		return ""
	}
	if code := walk(first, 0); code != "" {
		return code
	}
	if _, err = decoder.Token(); err != io.EOF {
		return "model_tool_invalid"
	}
	return ""
}

func validCloudModelSurrogates(raw []byte) bool {
	for index := 0; index < len(raw); index++ {
		if raw[index] != '\\' {
			continue
		}
		index++
		if index >= len(raw) {
			return false
		}
		if raw[index] != 'u' {
			continue
		}
		if index+4 >= len(raw) {
			return false
		}
		value, err := strconv.ParseUint(string(raw[index+1:index+5]), 16, 16)
		if err != nil {
			return false
		}
		index += 4
		if value >= 0xdc00 && value <= 0xdfff {
			return false
		}
		if value < 0xd800 || value > 0xdbff {
			continue
		}
		if index+6 >= len(raw) || raw[index+1] != '\\' || raw[index+2] != 'u' {
			return false
		}
		low, err := strconv.ParseUint(string(raw[index+3:index+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return false
		}
		index += 6
	}
	return true
}

func (s *cloudModelStream) appendReasoning(value string) (string, error) {
	if s.reasoning.Len()+len(value) > cloudModelMaxReasoningBytes {
		return "", s.fail("model_output_limit")
	}
	s.reasoning.WriteString(value)
	return value, nil
}
func (s *cloudModelStream) finishReasoning() (string, error) {
	return s.appendReasoning(s.reasoningFilter.finish())
}
