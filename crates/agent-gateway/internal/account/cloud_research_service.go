package account

import (
	"errors"

	"github.com/liveagent/agent-gateway/internal/cloudresearch"
)

type cloudResearchService struct {
	search *cloudresearch.Tavily
	fetch  *cloudresearch.Fetcher
}

// Configure only at startup. Neither construction nor this setter makes a
// search/page request. A model cannot choose endpoints, credentials or a dialer.
func (s *Service) SetCloudResearch(search *cloudresearch.Tavily, fetch *cloudresearch.Fetcher) error {
	s.cloudRuntimeMu.Lock()
	defer s.cloudRuntimeMu.Unlock()
	if s.cloudRuntime != nil {
		return errors.New("cloud research must be configured before task workers start")
	}
	s.cloudResearchMu.Lock()
	defer s.cloudResearchMu.Unlock()
	if search != nil && !search.Status().Enabled {
		search = nil
	}
	if search == nil && fetch == nil {
		s.cloudResearch = nil
		return nil
	}
	s.cloudResearch = &cloudResearchService{search: search, fetch: fetch}
	return nil
}

func (s *Service) CloudResearch() (*cloudresearch.Tavily, *cloudresearch.Fetcher) {
	s.cloudResearchMu.RLock()
	defer s.cloudResearchMu.RUnlock()
	if s.cloudResearch == nil {
		return nil, nil
	}
	return s.cloudResearch.search, s.cloudResearch.fetch
}
