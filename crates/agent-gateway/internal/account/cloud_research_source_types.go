package account

import (
	"errors"
	"time"
)

const (
	CloudResearchSearchSnippet         = "search_snippet"
	CloudResearchPage                  = "page"
	CloudResearchSourceMaxText         = 1 << 20
	CloudResearchSourceMaxBatch        = 10
	CloudResearchSourceMaxCount        = 5000
	CloudResearchSourceMaxAccountBytes = 128 << 20
	CloudResearchMaxDailySearches      = 1000
)

var (
	ErrCloudResearchSourceInvalid  = errors.New("invalid cloud research source")
	ErrCloudResearchSourceConflict = errors.New("cloud research source publication changed")
	ErrCloudResearchSourceQuota    = errors.New("cloud research source limit reached")
)

type CloudResearchSourceInput struct {
	Kind                                                    string
	URL, FinalURL, Title, Snippet, Text, SHA256, BodySHA256 string
	ObservedAt                                              time.Time
	Truncated                                               bool
}

// A source snapshot is account-owned independently of its original Run and
// conversation. Public metadata never includes full page bodies or tool input.
type CloudResearchSource struct {
	ID              string     `json:"id"`
	UserID          int64      `json:"-"`
	RunID           string     `json:"run_id"`
	ConversationID  string     `json:"conversation_id"`
	ToolOperationID string     `json:"-"`
	Ordinal         int        `json:"-"`
	Kind            string     `json:"kind"`
	URL             string     `json:"url"`
	FinalURL        string     `json:"final_url,omitempty"`
	Title           string     `json:"title"`
	Snippet         string     `json:"snippet,omitempty"`
	Text            string     `json:"-"`
	SHA256          string     `json:"sha256"`
	BodySHA256      string     `json:"body_sha256,omitempty"`
	ObservedAt      time.Time  `json:"observed_at"`
	Truncated       bool       `json:"truncated"`
	TextBytes       int        `json:"text_bytes"`
	LineCount       int        `json:"line_count"`
	Version         int64      `json:"version"`
	CreatedAt       time.Time  `json:"created_at"`
	DeletedAt       *time.Time `json:"-"`
}

type cloudResearchPublication struct {
	UserID      int64
	RunID, Hash string
	IDs         []string
}
type cloudResearchSearchReservation struct {
	UserID     int64
	RunID, Day string
}
