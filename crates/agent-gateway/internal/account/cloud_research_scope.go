package account

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"unicode/utf8"
)

const CloudPublicResearchMaxTopicBytes = 8 << 10

// Presence is the authenticated user's explicit decision to use exactly this
// text as a public research topic. It is an immutable Run request snapshot,
// never inferred from natural-language instructions or inherited preferences.
type CloudRunPublicResearch struct {
	Topic string `json:"topic"`
}

func normalizeCloudPublicResearch(input *CloudRunPublicResearch) (*CloudRunPublicResearch, error) {
	if input == nil {
		return nil, nil
	}
	topic := strings.TrimSpace(input.Topic)
	if topic == "" || len(topic) > CloudPublicResearchMaxTopicBytes || !utf8.ValidString(topic) || strings.ContainsRune(topic, '\x00') {
		return nil, cloudParameterError("public_research_topic_invalid", "请确认要公开检索的主题，长度不能超过 8 KiB。")
	}
	return &CloudRunPublicResearch{Topic: topic}, nil
}

// This authority exists only inside the trusted Go execution process. Its
// pointer is never serialized or accepted as a tool/request argument. The
// context capability binds one public-only model phase to its exact execution,
// owner and lease attempt; closing that phase cancels every derived request.
type cloudRunResearchScope struct {
	execution *cloudRunToolExecution
	userID    int64
	runID     string
	owner     string
	attempt   int64
	topic     string
	cancel    context.CancelFunc
	closed    atomic.Bool
	mu        sync.Mutex
	prior     []map[string]any
}

func (*cloudRunResearchScope) String() string   { return "cloudRunResearchScope(private)" }
func (*cloudRunResearchScope) GoString() string { return "cloudRunResearchScope(private)" }

type cloudResearchScopeContextKey struct{}
