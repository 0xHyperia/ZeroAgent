package account

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/liveagent/agent-gateway/internal/cloudresearch"
)

type CloudResearchSourceStore interface {
	PersistCloudResearchSources(context.Context, int64, string, string, int64, string, []CloudResearchSourceInput) ([]CloudResearchSource, error)
	GetCloudResearchSourcesForOperation(context.Context, int64, string) ([]CloudResearchSource, error)
	GetCloudResearchSource(context.Context, int64, string) (*CloudResearchSource, error)
	CloudResearchSourceAvailable(context.Context, int64, string) (bool, error)
	ListCloudResearchSources(context.Context, int64, string, string, int) ([]CloudResearchSource, error)
	DeleteCloudResearchSource(context.Context, int64, string, int64) error
	ReserveCloudResearchSearch(context.Context, int64, string, string, int64, string, int64) (bool, error)
}

func (s *Service) PersistCloudResearchSources(ctx context.Context, userID int64, runID, owner string, attempt int64, operationID string, inputs []CloudResearchSourceInput, secrets ...string) ([]CloudResearchSource, error) {
	store, ok := s.store.(CloudResearchSourceStore)
	if !ok {
		return nil, ErrCloudResearchSourceInvalid
	}
	for _, input := range inputs {
		for _, value := range []string{input.URL, input.FinalURL, input.Title, input.Snippet, input.Text} {
			if cloudResearchSourceHasSecret(value, secrets) {
				return nil, &cloudModelStreamError{Code: "model_secret_reflection"}
			}
		}
	}
	return store.PersistCloudResearchSources(ctx, userID, runID, owner, attempt, operationID, inputs)
}
func (s *Service) ReserveCloudResearchSearch(ctx context.Context, userID int64, runID, owner string, attempt int64, operationID string, limit int64) (bool, error) {
	store, ok := s.store.(CloudResearchSourceStore)
	if !ok {
		return false, ErrCloudResearchSourceInvalid
	}
	return store.ReserveCloudResearchSearch(ctx, userID, runID, owner, attempt, operationID, limit)
}
func (s *Service) GetCloudResearchSourcesForOperation(ctx context.Context, userID int64, operationID string) ([]CloudResearchSource, error) {
	store, ok := s.store.(CloudResearchSourceStore)
	if !ok {
		return nil, ErrCloudResearchSourceInvalid
	}
	return store.GetCloudResearchSourcesForOperation(ctx, userID, operationID)
}

func (s *Service) CloudResearchSourceAvailable(ctx context.Context, userID int64, id string) (bool, error) {
	store, ok := s.store.(CloudResearchSourceStore)
	if !ok {
		return false, ErrCloudResearchSourceInvalid
	}
	return store.CloudResearchSourceAvailable(ctx, userID, id)
}

func cloudResearchSourceHasSecret(value string, secrets []string) bool {
	decoded, _ := url.QueryUnescape(value)
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		for _, form := range []string{secret, base64.StdEncoding.EncodeToString([]byte(secret)), base64.RawURLEncoding.EncodeToString([]byte(secret))} {
			if strings.Contains(value, form) || strings.Contains(decoded, form) {
				return true
			}
		}
	}
	return false
}
func cloudResearchDigest(value string) string {
	hash := sha256.Sum256([]byte(value))
	return hex.EncodeToString(hash[:])
}
func cloudResearchHash(value string) bool {
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == 32 && strings.ToLower(value) == value
}

func prepareCloudResearchInputs(inputs []CloudResearchSourceInput, now time.Time) ([]CloudResearchSourceInput, string, error) {
	if len(inputs) > CloudResearchSourceMaxBatch {
		return nil, "", ErrCloudResearchSourceInvalid
	}
	prepared := make([]CloudResearchSourceInput, len(inputs))
	for i, input := range inputs {
		if !utf8.ValidString(input.Title) || len(input.Title) > 512 || strings.ContainsRune(input.Title, 0) || !utf8.ValidString(input.Snippet) || len(input.Snippet) > 4096 || strings.ContainsRune(input.Snippet, 0) || input.ObservedAt.IsZero() || input.ObservedAt.After(now.Add(5*time.Minute)) {
			return nil, "", ErrCloudResearchSourceInvalid
		}
		u, err := cloudresearch.NormalizeURL(input.URL)
		if err != nil {
			return nil, "", ErrCloudResearchSourceInvalid
		}
		input.URL = u.String()
		input.ObservedAt = input.ObservedAt.UTC()
		switch input.Kind {
		case CloudResearchSearchSnippet:
			if input.Text != "" || input.FinalURL != "" || input.BodySHA256 != "" {
				return nil, "", ErrCloudResearchSourceInvalid
			}
			digest := cloudResearchDigest(input.Snippet)
			if input.SHA256 != "" && input.SHA256 != digest {
				return nil, "", ErrCloudResearchSourceInvalid
			}
			input.SHA256 = digest
		case CloudResearchPage:
			final, err := cloudresearch.NormalizeURL(input.FinalURL)
			if err != nil {
				return nil, "", ErrCloudResearchSourceInvalid
			}
			input.FinalURL = final.String()
			if strings.TrimSpace(input.Text) == "" || !utf8.ValidString(input.Text) || strings.ContainsRune(input.Text, 0) || len(input.Text) > CloudResearchSourceMaxText || strings.Count(input.Text, "\n") >= 10000 || !cloudResearchHash(input.BodySHA256) {
				return nil, "", ErrCloudResearchSourceInvalid
			}
			digest := cloudResearchDigest(input.Text)
			if input.SHA256 != "" && input.SHA256 != digest {
				return nil, "", ErrCloudResearchSourceInvalid
			}
			input.SHA256 = digest
		default:
			return nil, "", ErrCloudResearchSourceInvalid
		}
		prepared[i] = input
	}
	data, _ := json.Marshal(prepared)
	return prepared, cloudResearchDigest(string(data)), nil
}

func newCloudResearchSource(input CloudResearchSourceInput, run *CloudRun, operationID string, ordinal int, now time.Time) CloudResearchSource {
	lines := 0
	if input.Kind == CloudResearchPage {
		lines = strings.Count(input.Text, "\n") + 1
	}
	return CloudResearchSource{ID: uuid.NewString(), UserID: run.UserID, RunID: run.ID, ConversationID: run.ConversationID, ToolOperationID: operationID, Ordinal: ordinal, Kind: input.Kind, URL: input.URL, FinalURL: input.FinalURL, Title: input.Title, Snippet: input.Snippet, Text: input.Text, SHA256: input.SHA256, BodySHA256: input.BodySHA256, ObservedAt: input.ObservedAt, Truncated: input.Truncated, TextBytes: len(input.Text), LineCount: lines, Version: 1, CreatedAt: now.UTC()}
}

func cloneCloudResearchSource(source CloudResearchSource) CloudResearchSource {
	if source.DeletedAt != nil {
		value := *source.DeletedAt
		source.DeletedAt = &value
	}
	return source
}
