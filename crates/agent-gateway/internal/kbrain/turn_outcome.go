package kbrain

import (
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

var failureMessages = map[string]string{
	"invalid_api_key": "The model provider rejected authentication.",
	"rate_limited":    "The model provider limited requests.",
	"server_error":    "The model provider could not complete the request.",
	"connection_lost": "Connection to the model was interrupted.",
	"unreachable":     "Could not connect to the model provider.",
	"timeout":         "The model request timed out.",
	"context_limit":   "The model's context limit was reached.",
	"bad_request":     "The model provider rejected the request.",
	"not_found":       "The requested model or endpoint was not found.",
	"provider_error":  "The model provider returned an error.",
	"unknown":         "The model request failed.",
}

var legacyFailureStatus = regexp.MustCompile(`(?i)^\s*(?:http\s+)?([45]\d\d)\b|\bstatus(?:[ _]?code)?["']?\s*[:=]?\s*([45]\d\d)\b`)
var legacyConnectionFailure = regexp.MustCompile(`(?i)unexpected eof|connection (?:reset|refused|closed|lost)|econnreset|socket hang up|broken pipe|network error|failed to fetch|stream ended|ended without a terminal event`)
var legacyAuthFailure = regexp.MustCompile(`(?i)invalid[_ ]api[_ ]key|incorrect api key|unauthori[sz]ed|authentication`)
var legacyRateFailure = regexp.MustCompile(`(?i)rate[_ ]limit|too many requests|quota exceeded`)
var legacyServerFailure = regexp.MustCompile(`(?i)server[_ ]error|internal server error|bad gateway|service unavailable|overloaded`)

func normalizedFailureKind(kind string, status int, raw string) string {
	if _, ok := failureMessages[kind]; ok {
		return kind
	}
	switch {
	case status == 401 || status == 403:
		return "invalid_api_key"
	case status == 404:
		return "not_found"
	case status == 408:
		return "timeout"
	case status == 429:
		return "rate_limited"
	case status >= 500:
		return "server_error"
	case status >= 400:
		return "bad_request"
	case legacyConnectionFailure.MatchString(raw):
		return "connection_lost"
	case legacyAuthFailure.MatchString(raw):
		return "invalid_api_key"
	case legacyRateFailure.MatchString(raw):
		return "rate_limited"
	case legacyServerFailure.MatchString(raw):
		return "server_error"
	default:
		return "unknown"
	}
}

// addFailureOutcome shares only a stable kind, HTTP status and fixed copy. Both
// raw engine diagnostics and provider messages can contain private values.
func addFailureOutcome(out map[string]any, detail *ErrorDetail, raw string) string {
	var kind string
	var status int
	if detail != nil {
		kind, status = detail.Kind, detail.UpstreamStatus
	}
	if status < 400 || status > 599 {
		status = 0
		if match := legacyFailureStatus.FindStringSubmatch(raw); match != nil {
			status, _ = strconv.Atoi(match[1] + match[2])
		}
	}
	kind = normalizedFailureKind(kind, status, raw)
	publicDetail := map[string]any{"kind": kind}
	if status != 0 {
		publicDetail["upstreamStatus"] = status
	}
	message := failureMessages[kind]
	out["stopReason"], out["errorMessage"], out["errorDetail"] = "error", message, publicDetail
	return message
}

func isFailureMarker(id string) bool {
	return strings.HasPrefix(id, "assistant-error-")
}

func decodeRunOutcome(data []byte) (Message, error) {
	var outcome Message
	if len(data) > 0 {
		if err := json.Unmarshal(data, &outcome); err != nil {
			return outcome, err
		}
	}
	return outcome, nil
}
