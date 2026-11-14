package cloudresearch

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

const tavilyEndpoint = "https://api.tavily.com/search"

type TavilyConfig struct {
	APIKey     string `json:"-"`
	MaxResults int
	Timeout    time.Duration
}

func (TavilyConfig) String() string   { return "cloudresearch.TavilyConfig(redacted)" }
func (TavilyConfig) GoString() string { return "cloudresearch.TavilyConfig(redacted)" }

func TavilyConfigFromEnv(getenv func(string) string) (TavilyConfig, error) {
	if getenv == nil {
		return TavilyConfig{}, ErrInvalidConfig
	}
	return TavilyConfig{APIKey: getenv("ZEROAGENT_TAVILY_API_KEY")}, nil
}

type Tavily struct {
	config    TavilyConfig
	status    Status
	limits    Limits
	gate      chan struct{}
	now       func() time.Time
	newClient func(context.Context, *url.URL) (*http.Client, func(), error)
}

func (t *Tavily) String() string   { return "cloudresearch.Tavily" }
func (t *Tavily) GoString() string { return "cloudresearch.Tavily" }

// NewTavily reads no ambient environment/profile and never performs a request.
// Only the official HTTPS origin is supported; redirects are never followed.
func NewTavily(config TavilyConfig) (*Tavily, error) {
	if config.MaxResults == 0 {
		config.MaxResults = 5
	}
	if config.MaxResults < 1 || config.MaxResults > 10 {
		return nil, ErrInvalidConfig
	}
	limits, err := normalizedLimits(Limits{Timeout: config.Timeout, MaxWireBytes: 1 << 20, MaxResponseBytes: 1 << 20})
	if err != nil {
		return nil, err
	}
	t := &Tavily{config: config, limits: limits, gate: make(chan struct{}, 4), now: time.Now}
	if config.APIKey == "" {
		t.status = Status{Reason: "missing_configuration", Missing: []string{"ZEROAGENT_TAVILY_API_KEY"}}
		return t, nil
	}
	if len(config.APIKey) < 8 || len(config.APIKey) > 512 {
		return nil, ErrInvalidConfig
	}
	for _, char := range config.APIKey {
		if char != '-' && char != '_' && (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') {
			return nil, ErrInvalidConfig
		}
	}
	t.status.Enabled = true
	t.newClient = func(ctx context.Context, u *url.URL) (*http.Client, func(), error) {
		return pinnedClient(ctx, u, normalizedNetwork(Network{}), limits)
	}
	return t, nil
}

// NewTavilyWithTransport is a trusted Go construction seam for isolated
// protocol peers. The request URL remains the fixed official origin and client
// redirects remain disabled. Never bind this to HTTP/model/operator endpoint
// input; the injected RoundTripper must itself avoid proxies and ambient state.
func NewTavilyWithTransport(config TavilyConfig, transport http.RoundTripper) (*Tavily, error) {
	if transport == nil {
		return nil, ErrInvalidConfig
	}
	client, err := NewTavily(config)
	if err != nil {
		return nil, err
	}
	client.newClient = func(context.Context, *url.URL) (*http.Client, func(), error) {
		return &http.Client{Transport: transport, Timeout: client.limits.Timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, func() {}, nil
	}
	return client, nil
}

func (t *Tavily) Status() Status {
	if t == nil {
		return Status{Reason: "missing_configuration", Missing: []string{"ZEROAGENT_TAVILY_API_KEY"}}
	}
	status := t.status
	status.Missing = append([]string(nil), status.Missing...)
	return status
}

func (t *Tavily) Search(parent context.Context, query string) (SearchResult, error) {
	if t == nil || !t.status.Enabled {
		return SearchResult{}, ErrDisabled
	}
	if !utf8.ValidString(query) || strings.TrimSpace(query) == "" || len(query) > 2048 || utf8.RuneCountInString(query) > 400 || strings.ContainsRune(query, 0) {
		return SearchResult{}, ErrInvalidInput
	}
	if containsSecret(query, t.config.APIKey) {
		return SearchResult{}, ErrInvalidInput
	}
	if err := acquire(parent, t.gate); err != nil {
		return SearchResult{}, err
	}
	defer func() { <-t.gate }()
	ctx, cancel := context.WithTimeout(parent, t.limits.Timeout)
	defer cancel()
	u, _ := url.Parse(tavilyEndpoint)
	client, closeTransport, err := t.newClient(ctx, u)
	if err != nil {
		return SearchResult{}, safeError(ctx, err)
	}
	defer closeTransport()
	input := struct {
		Query             string `json:"query"`
		Depth             string `json:"search_depth"`
		Topic             string `json:"topic"`
		MaxResults        int    `json:"max_results"`
		IncludeAnswer     bool   `json:"include_answer"`
		IncludeRawContent bool   `json:"include_raw_content"`
		IncludeImages     bool   `json:"include_images"`
		AutoParameters    bool   `json:"auto_parameters"`
	}{Query: query, Depth: "basic", Topic: "general", MaxResults: t.config.MaxResults}
	body, _ := json.Marshal(input)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, tavilyEndpoint, bytes.NewReader(body))
	if err != nil {
		return SearchResult{}, ErrInvalidInput
	}
	request.Header.Set("Authorization", "Bearer "+t.config.APIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "gzip")
	request.Header.Set("User-Agent", "ZeroAgent-CloudResearch/1")
	response, err := client.Do(request)
	if err != nil {
		return SearchResult{}, safeError(ctx, err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		return SearchResult{}, responseError(response.StatusCode)
	}
	raw, err := readBody(ctx, response, t.limits)
	if err != nil {
		return SearchResult{}, safeError(ctx, err)
	}
	if !utf8.Valid(raw) || containsSecret(string(raw), t.config.APIKey) {
		return SearchResult{}, ErrInvalidResponse
	}
	var output struct {
		Results *[]struct{ URL, Title, Content string } `json:"results"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err = decoder.Decode(&output); err != nil {
		return SearchResult{}, ErrInvalidResponse
	}
	if err = decoder.Decode(&struct{}{}); err != io.EOF || output.Results == nil || len(*output.Results) > 20 {
		return SearchResult{}, ErrInvalidResponse
	}
	result := SearchResult{Provider: "tavily", Untrusted: true, SearchedAt: t.now().UTC(), Sources: make([]SearchSource, 0)}
	seen := make(map[string]bool)
	for _, source := range *output.Results {
		if containsSecret(source.URL+source.Title+source.Content, t.config.APIKey) {
			return SearchResult{}, ErrInvalidResponse
		}
		parsed, parseErr := NormalizeURL(source.URL)
		if parseErr != nil {
			continue
		}
		canonical := parsed.String()
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		title, titleTruncated := singleLine(source.Title, 512)
		snippet, snippetTruncated := singleLine(source.Content, 4096)
		result.Sources = append(result.Sources, SearchSource{Rank: len(result.Sources) + 1, URL: canonical, Title: title, Snippet: snippet, Truncated: titleTruncated || snippetTruncated})
		if len(result.Sources) >= t.config.MaxResults {
			break
		}
	}
	return result, nil
}

func containsSecret(text, secret string) bool {
	for _, value := range []string{secret, url.QueryEscape(secret), url.PathEscape(secret), base64.StdEncoding.EncodeToString([]byte(secret)), base64.RawURLEncoding.EncodeToString([]byte(secret))} {
		if value != "" && strings.Contains(text, value) {
			return true
		}
	}
	return false
}

func singleLine(value string, maxBytes int) (string, bool) {
	limits, _ := normalizedLimits(Limits{MaxTextBytes: maxBytes, MaxTextRunes: maxBytes, MaxLines: 1})
	sink := newTextSink(limits)
	sink.write(value, false)
	return sink.text(), sink.truncated
}

var _ Searcher = (*Tavily)(nil)
