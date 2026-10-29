package account

import (
	"net/http"
	"sync"
)

// Live viewers consume sockets, replay bytes and DB polling independently of
// worker concurrency. Scope limits by account, so another login cookie cannot
// multiply its allowance. Releasing a viewer never cancels the durable Run.
func (s *Service) acquireCloudRunViewer(userID int64) (func(), error) {
	config := s.CloudRuntimeConfig()
	s.cloudViewerMu.Lock()
	defer s.cloudViewerMu.Unlock()
	if s.cloudViewerCount >= config.MaxEventStreams || s.cloudViewers[userID] >= config.MaxEventStreamsPerAccount {
		return nil, &APIError{Status: http.StatusTooManyRequests, Reason: "cloud_stream_limit", Message: "打开的实时页面已达上限，请关闭其他窗口后重试；任务会继续运行。"}
	}
	if s.cloudViewers == nil {
		s.cloudViewers = make(map[int64]int)
	}
	s.cloudViewers[userID]++
	s.cloudViewerCount++
	var once sync.Once
	return func() {
		once.Do(func() {
			s.cloudViewerMu.Lock()
			defer s.cloudViewerMu.Unlock()
			s.cloudViewers[userID]--
			s.cloudViewerCount--
			if s.cloudViewers[userID] == 0 {
				delete(s.cloudViewers, userID)
			}
		})
	}, nil
}
