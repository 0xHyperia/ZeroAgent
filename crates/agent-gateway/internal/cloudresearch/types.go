// Package cloudresearch provides bounded, untrusted web evidence. It owns no
// account, Run, citation database or agent loop; callers must authorize each use.
package cloudresearch

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"time"
)

var (
	ErrDisabled           = errors.New("cloud research search is disabled")
	ErrInvalidConfig      = errors.New("invalid cloud research configuration")
	ErrInvalidInput       = errors.New("invalid cloud research input")
	ErrUnsafeURL          = errors.New("cloud research URL is not public or permitted")
	ErrUnavailable        = errors.New("cloud research service is unavailable")
	ErrTooLarge           = errors.New("cloud research resource limit exceeded")
	ErrInvalidResponse    = errors.New("invalid cloud research response")
	ErrUnsupportedContent = errors.New("unsupported cloud research content type or encoding")
	ErrNoContent          = errors.New("cloud research resource contains no readable text")
	ErrAccessDenied       = errors.New("cloud research request was denied")
	ErrThrottled          = errors.New("cloud research request was throttled")
	ErrBusy               = errors.New("cloud research concurrency limit reached")
	ErrRedirectLimit      = errors.New("cloud research redirect limit exceeded")
)

type SearchSource struct {
	Rank      int    `json:"rank"`
	URL       string `json:"url"`
	Title     string `json:"title"`
	Snippet   string `json:"snippet"`
	Truncated bool   `json:"truncated"`
}
type SearchResult struct {
	Sources    []SearchSource `json:"sources"`
	SearchedAt time.Time      `json:"searched_at"`
	Provider   string         `json:"provider"`
	Untrusted  bool           `json:"untrusted"`
}
type Line struct {
	Number int    `json:"number"`
	Text   string `json:"text"`
}
type Document struct {
	RequestedURL string    `json:"requested_url"`
	FinalURL     string    `json:"final_url"`
	Title        string    `json:"title"`
	Text         string    `json:"text"`
	Lines        []Line    `json:"lines"`
	SHA256       string    `json:"sha256"`
	BodySHA256   string    `json:"body_sha256"`
	FetchedAt    time.Time `json:"fetched_at"`
	Truncated    bool      `json:"truncated"`
	Untrusted    bool      `json:"untrusted"`
}
type Status struct {
	Enabled bool     `json:"enabled"`
	Reason  string   `json:"reason,omitempty"`
	Missing []string `json:"missing,omitempty"`
}
type Searcher interface {
	Search(context.Context, string) (SearchResult, error)
}

type Resolver interface {
	LookupNetIP(context.Context, string, string) ([]netip.Addr, error)
}
type Network struct {
	// Trusted construction seams for isolation tests, never client-supplied.
	Resolver    Resolver                                                `json:"-"`
	DialContext func(context.Context, string, string) (net.Conn, error) `json:"-"`
}

func normalizedNetwork(input Network) Network {
	if input.Resolver == nil {
		input.Resolver = net.DefaultResolver
	}
	if input.DialContext == nil {
		input.DialContext = (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: -1}).DialContext
	}
	return input
}

type Limits struct {
	Timeout          time.Duration
	MaxWireBytes     int
	MaxResponseBytes int
	MaxTextBytes     int
	MaxTextRunes     int
	MaxLines         int
	MaxHTMLTokens    int
	MaxTokenBytes    int
	MaxHeaderBytes   int
	MaxConcurrent    int
}

func normalizedLimits(input Limits) (Limits, error) {
	if input.Timeout == 0 {
		input.Timeout = 15 * time.Second
	}
	if input.Timeout < time.Second || input.Timeout > time.Minute {
		return Limits{}, ErrInvalidConfig
	}
	for _, limit := range []struct {
		value           *int
		normal, maximum int
	}{
		{&input.MaxWireBytes, 2 << 20, 8 << 20}, {&input.MaxResponseBytes, 2 << 20, 8 << 20},
		{&input.MaxTextBytes, 256 << 10, 1 << 20}, {&input.MaxTextRunes, 65536, 262144},
		{&input.MaxLines, 2000, 10000}, {&input.MaxHTMLTokens, 100000, 500000},
		{&input.MaxTokenBytes, 64 << 10, 256 << 10}, {&input.MaxHeaderBytes, 32 << 10, 64 << 10},
		{&input.MaxConcurrent, 4, 16},
	} {
		if *limit.value == 0 {
			*limit.value = limit.normal
		}
		if *limit.value < 1 || *limit.value > limit.maximum {
			return Limits{}, ErrInvalidConfig
		}
	}
	return input, nil
}

func safeError(ctx context.Context, err error) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	for _, known := range []error{ErrDisabled, ErrInvalidConfig, ErrInvalidInput, ErrUnsafeURL, ErrUnavailable, ErrTooLarge, ErrInvalidResponse, ErrUnsupportedContent, ErrNoContent, ErrAccessDenied, ErrThrottled, ErrBusy, ErrRedirectLimit} {
		if errors.Is(err, known) {
			return known
		}
	}
	// Do not preserve URL/DNS/HTTP/provider errors which may reflect credentials,
	// raw pages, private destination names or the user's full research query.
	return ErrUnavailable
}

func acquire(ctx context.Context, gate chan struct{}) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	select {
	case gate <- struct{}{}:
		return nil
	default:
		return ErrBusy
	}
}
