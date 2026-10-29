package cloudresearch

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func tavilyFixture(t *testing.T, handler http.HandlerFunc) *Tavily {
	t.Helper()
	peer := httptest.NewServer(handler)
	t.Cleanup(peer.Close)
	u, _ := url.Parse(peer.URL)
	client, err := NewTavily(TavilyConfig{APIKey: "synthetic-search-key"})
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{Proxy: nil, DisableCompression: true}
	t.Cleanup(transport.CloseIdleConnections)
	client.newClient = func(ctx context.Context, target *url.URL) (*http.Client, func(), error) {
		if target.String() != tavilyEndpoint {
			t.Error("search destination changed from official origin")
		}
		return &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.String() != tavilyEndpoint {
				t.Error("public API attempted another search endpoint")
			}
			clone := request.Clone(request.Context())
			copied := *request.URL
			copied.Scheme = u.Scheme
			copied.Host = u.Host
			clone.URL = &copied
			clone.Host = "api.tavily.com"
			return transport.RoundTrip(clone)
		}), CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, func() {}, nil
	}
	return client
}

func TestTavilyExplicitDisabledConfiguration(t *testing.T) {
	var names []string
	config, err := TavilyConfigFromEnv(func(name string) string { names = append(names, name); return "" })
	if err != nil {
		t.Fatal(err)
	}
	client, err := NewTavily(config)
	if err != nil || client.Status().Enabled || len(names) != 1 || names[0] != "ZEROAGENT_TAVILY_API_KEY" {
		t.Fatal("configuration read ambient credentials or was implicitly enabled")
	}
	if _, err = client.Search(context.Background(), "query"); !errors.Is(err, ErrDisabled) {
		t.Fatal("unconfigured provider made a request")
	}
	secret := TavilyConfig{APIKey: "synthetic-search-key"}
	if strings.Contains(fmt.Sprintf("%v %#v", secret, secret), secret.APIKey) {
		t.Fatal("config formatting leaked key")
	}
	if _, err = NewTavily(TavilyConfig{APIKey: "bad\nkey"}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatal("unsafe bearer value accepted")
	}
	if _, err = NewTavily(TavilyConfig{APIKey: secret.APIKey, MaxResults: 11}); !errors.Is(err, ErrInvalidConfig) {
		t.Fatal("unbounded search fanout")
	}
}

func TestTavilyOfficialRequestAndOrderedUntrustedSources(t *testing.T) {
	client := tavilyFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.Host != "api.tavily.com" || r.URL.Path != "/search" || r.Header.Get("Authorization") != "Bearer synthetic-search-key" || r.Header.Get("Cookie") != "" {
			t.Error("search request boundary changed")
		}
		var input map[string]any
		if json.NewDecoder(r.Body).Decode(&input) != nil {
			t.Error("search JSON invalid")
		}
		if input["search_depth"] != "basic" || input["topic"] != "general" || input["max_results"] != float64(5) || input["auto_parameters"] != false || input["include_raw_content"] != false || input["include_answer"] != false || input["api_key"] != nil {
			t.Error("explicit bounded search flags changed")
		}
		io.WriteString(w, `{"results":[{"url":"https://example.com/a#part","title":"First","content":"first snippet"},{"url":"http://127.0.0.1/private","title":"private","content":"not a source"},{"url":"https://example.com/b","title":"Second","content":"second snippet"},{"url":"https://example.com/a","title":"duplicate","content":"duplicate"}]}`)
	})
	result, err := client.Search(context.Background(), "合成查询")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Untrusted || result.Provider != "tavily" || result.SearchedAt.IsZero() || len(result.Sources) != 2 || result.Sources[0].Title != "First" || result.Sources[1].Title != "Second" || result.Sources[1].Rank != 2 {
		t.Fatal("ranked sources were fabricated, reordered or not bounded")
	}
}

func TestTavilyRejectsSecretReflectionAndSanitizesFailures(t *testing.T) {
	for _, encoded := range []string{"synthetic-search-key", `synthetic-search-k\u0065y`, base64.StdEncoding.EncodeToString([]byte("synthetic-search-key"))} {
		t.Run(fmt.Sprint(len(encoded)), func(t *testing.T) {
			client := tavilyFixture(t, func(w http.ResponseWriter, r *http.Request) {
				io.WriteString(w, `{"results":[{"url":"https://example.com/a","title":"`+encoded+`","content":"snippet"}]}`)
			})
			result, err := client.Search(context.Background(), "query")
			if err == nil || len(result.Sources) != 0 || strings.Contains(err.Error(), "synthetic-search-key") {
				t.Fatal("provider reflected key into evidence or error")
			}
		})
	}
	for _, status := range []int{401, 403, 429, 503, 302} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var calls atomic.Int64
			client := tavilyFixture(t, func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Location", "http://127.0.0.1/private")
				w.WriteHeader(status)
				io.WriteString(w, "synthetic-search-key reflected failure")
			})
			_, err := client.Search(context.Background(), "query")
			if err == nil || strings.Contains(err.Error(), "synthetic-search-key") || calls.Load() != 1 {
				t.Fatal("provider error was retried, redirected or reflected")
			}
		})
	}
}

func TestTavilyQueryAndResponseBounds(t *testing.T) {
	var calls atomic.Int64
	client := tavilyFixture(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		io.WriteString(w, `{"results":[{"url":"https://example.com/a","title":"`+strings.Repeat("x", 600)+`","content":"`+strings.Repeat("a", 5000)+`"}]}`)
	})
	for _, query := range []string{"", strings.Repeat("中", 401), "query\x00", "synthetic-search-key"} {
		if _, err := client.Search(context.Background(), query); !errors.Is(err, ErrInvalidInput) {
			t.Fatal("invalid/secret query reached provider")
		}
	}
	if calls.Load() != 0 {
		t.Fatal("invalid query made a remote request")
	}
	result, err := client.Search(context.Background(), "query")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Sources) != 1 || !result.Sources[0].Truncated || len(result.Sources[0].Title) > 512 || len(result.Sources[0].Snippet) > 4096 {
		t.Fatal("search snippets were not bounded")
	}
}
