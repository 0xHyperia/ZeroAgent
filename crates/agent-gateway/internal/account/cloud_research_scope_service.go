package account

import (
	"context"

	"github.com/liveagent/agent-gateway/internal/cloudresearch"
)

// Keep the capability check adjacent to the actual effect as well as at tool
// dispatch. A configured provider is availability, never user authorization.
func (s *Service) searchCloudPublicResearch(ctx context.Context, execution *cloudRunToolExecution, query string) (cloudresearch.SearchResult, error) {
	if execution == nil || execution.runtime == nil || execution.runtime.service != s {
		return cloudresearch.SearchResult{}, cloudResearchAuthorizationRequired()
	}
	if _, err := execution.authorizedResearchScope(ctx); err != nil {
		return cloudresearch.SearchResult{}, err
	}
	search, _ := s.CloudResearch()
	if search == nil {
		return cloudresearch.SearchResult{}, cloudresearch.ErrDisabled
	}
	return search.Search(ctx, query)
}

func (s *Service) fetchCloudPublicResearch(ctx context.Context, execution *cloudRunToolExecution, rawURL string) (cloudresearch.Document, error) {
	if execution == nil || execution.runtime == nil || execution.runtime.service != s {
		return cloudresearch.Document{}, cloudResearchAuthorizationRequired()
	}
	if _, err := execution.authorizedResearchScope(ctx); err != nil {
		return cloudresearch.Document{}, err
	}
	_, fetch := s.CloudResearch()
	if fetch == nil {
		return cloudresearch.Document{}, cloudresearch.ErrDisabled
	}
	return fetch.Fetch(ctx, rawURL)
}
