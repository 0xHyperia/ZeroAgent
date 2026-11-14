package account

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/liveagent/agent-gateway/internal/cloudresearch"
)

type cloudResearchRoundTrip func(*http.Request) (*http.Response, error)

func (f cloudResearchRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type cloudResearchPublicResolver struct{}
type cloudResearchLogicalConn struct{ net.Conn }

func (c cloudResearchLogicalConn) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.ParseIP("93.184.216.34"), Port: 80}
}

func (cloudResearchPublicResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
}

type cloudResearchHTTPFixture struct {
	server          *httptest.Server
	searches, pages atomic.Int64
	drop            atomic.Bool
}

func (f *cloudHTTPFixture) createResearch(t *testing.T, id, text, topic string) (*CloudRun, string) {
	t.Helper()
	body := string(cloudJSON(CreateCloudRunInput{ConversationID: f.conversation.ID, ClientRequestID: id, Model: "test-model", ProviderKeyID: 41, Content: cloudJSON(text), PublicResearch: &CloudRunPublicResearch{Topic: topic}}))
	status, data := f.request(t, http.MethodPost, "/api/web-chat/runs", "synthetic-browser-cookie", body)
	var result struct {
		Run *CloudRun `json:"run"`
	}
	if status != http.StatusAccepted || json.Unmarshal([]byte(data), &result) != nil || result.Run == nil {
		t.Fatalf("authorized research acceptance status=%d", status)
	}
	return result.Run, body
}

func configureCloudResearchFixture(t *testing.T, f *cloudHTTPFixture) *cloudResearchHTTPFixture {
	t.Helper()
	fixture := &cloudResearchHTTPFixture{}
	fixture.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/search" {
			fixture.searches.Add(1)
			if r.Header.Get("Authorization") != "Bearer fixture-search-api-key" {
				t.Error("search credential not bound to fixed provider")
			}
			if fixture.drop.Load() {
				connection, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					_ = connection.Close()
				}
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"results":[{"url":"http://example.com/page","title":"Synthetic evidence","content":"Search summary only","score":1}]}`)
			return
		}
		fixture.pages.Add(1)
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get("Origin") != "" {
			t.Error("account/provider credentials reached page reader")
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, `<html><head><title>Synthetic page</title></head><body><p>retained confidential line</p><p>second evidence line</p></body></html>`)
	}))
	t.Cleanup(fixture.server.Close)
	target, err := url.Parse(fixture.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{Proxy: nil}
	t.Cleanup(transport.CloseIdleConnections)
	search, err := cloudresearch.NewTavilyWithTransport(cloudresearch.TavilyConfig{APIKey: "fixture-search-api-key"}, cloudResearchRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://api.tavily.com/search" {
			t.Error("search provider endpoint was caller-selected")
		}
		copy := r.Clone(r.Context())
		u := *r.URL
		u.Scheme, u.Host = target.Scheme, target.Host
		copy.URL = &u
		return transport.RoundTrip(copy)
	}))
	if err != nil {
		t.Fatal(err)
	}
	fetch, err := cloudresearch.NewFetcher(cloudresearch.FetchConfig{Network: cloudresearch.Network{Resolver: cloudResearchPublicResolver{}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, target.Host)
		if err != nil {
			return nil, err
		}
		return cloudResearchLogicalConn{Conn: conn}, nil
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = f.service.SetCloudResearch(search, fetch); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func lastResearchToolResult(t *testing.T, r *http.Request) map[string]any {
	t.Helper()
	var body struct {
		Messages []struct {
			Role    string          `json:"role"`
			Content json.RawMessage `json:"content"`
		} `json:"messages"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		t.Error("invalid model request")
		return nil
	}
	for index := len(body.Messages) - 1; index >= 0; index-- {
		message := body.Messages[index]
		if message.Role != "tool" {
			continue
		}
		var content string
		if json.Unmarshal(message.Content, &content) != nil {
			t.Error("tool message was not text JSON")
			return nil
		}
		var result map[string]any
		if json.Unmarshal([]byte(content), &result) != nil {
			t.Error("invalid research tool result")
		}
		return result
	}
	t.Error("no research tool result in followup")
	return nil
}

func TestCloudRunResearchPersistsSnippetThenPageBeforeCitations(t *testing.T) {
	var rounds atomic.Int32
	var pageID atomic.Value
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch rounds.Add(1) {
		case 1:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			schemas := string(cloudJSON(body["tools"]))
			if !strings.Contains(schemas, "web_search") || strings.Contains(schemas, "execute_code") {
				t.Error("research capability improperly depended on E2B")
			}
			emitToolCalls(w, map[string]any{"index": 0, "id": "search", "type": "function", "function": map[string]any{"name": "web_search", "arguments": `{"query":"synthetic research"}`}})
			emitModelFinish(w, "tool_calls", 1)
		case 2:
			result := lastResearchToolResult(t, r)
			sources := result["sources"].([]any)
			source := sources[0].(map[string]any)
			if source["kind"] != CloudResearchSearchSnippet || source["page_fetched"] != false || source["snippet"] != "Search summary only" {
				t.Error("search snippet claimed a fetched page")
			}
			emitToolCalls(w, map[string]any{"index": 0, "id": "page", "type": "function", "function": map[string]any{"name": "fetch_page", "arguments": `{"url":"http://example.com/page"}`}})
			emitModelFinish(w, "tool_calls", 1)
		default:
			result := lastResearchToolResult(t, r)
			source := result["sources"].([]any)[0].(map[string]any)
			id := source["source_id"].(string)
			pageID.Store(id)
			if source["page_fetched"] != true || source["sha256"] == "" || len(source["lines"].([]any)) < 1 {
				t.Error("page lacked durable evidence")
			}
			emitCloudDelta(w, "参考已保存网页【来源:"+id+"】")
			emitModelFinish(w, "stop", 1)
		}
	})
	research := configureCloudResearchFixture(t, f)
	run, _ := f.createResearch(t, "research-chain", "查资料并列出依据", "synthetic research")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	id, _ := pageID.Load().(string)
	if finished.State != CloudRunCompleted || id == "" || research.searches.Load() != 1 || research.pages.Load() != 1 || rounds.Load() != 4 {
		t.Fatalf("research run state=%s code=%s requests=%d/%d", finished.State, finished.ErrorCode, research.searches.Load(), research.pages.Load())
	}
	source, err := f.store.GetCloudResearchSource(context.Background(), 1, id)
	if err != nil || source.Kind != CloudResearchPage || !strings.Contains(source.Text, "retained confidential line") {
		t.Fatal("citation was published before persistent evidence")
	}
	if available, _ := f.store.CloudResearchSourceAvailable(context.Background(), 2, id); available {
		t.Fatal("source escaped account scope")
	}
}

type deletingCloudSourceStore struct{ *MemoryStore }

func (s deletingCloudSourceStore) PersistCloudResearchSources(ctx context.Context, userID int64, runID, owner string, attempt int64, operationID string, inputs []CloudResearchSourceInput) ([]CloudResearchSource, error) {
	sources, err := s.MemoryStore.PersistCloudResearchSources(ctx, userID, runID, owner, attempt, operationID, inputs)
	if err != nil {
		return nil, err
	}
	for _, source := range sources {
		if err = s.DeleteCloudResearchSource(ctx, userID, source.ID, source.Version); err != nil {
			return nil, err
		}
	}
	return sources, nil
}

func TestCloudRunDeletedResearchSourceDoesNotReenterNextModelContext(t *testing.T) {
	var rounds atomic.Int32
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		if rounds.Add(1) == 1 {
			emitToolCalls(w, map[string]any{"index": 0, "id": "page", "type": "function", "function": map[string]any{"name": "fetch_page", "arguments": `{"url":"http://example.com/page"}`}})
			emitModelFinish(w, "tool_calls", 1)
			return
		}
		result := lastResearchToolResult(t, r)
		data := string(cloudJSON(result))
		if strings.Contains(data, "retained confidential line") || !strings.Contains(data, "unavailable_source_ids") {
			t.Error("deleted evidence recovered from private tool cache")
		}
		emitCloudDelta(w, "来源已删除，无法继续引用。")
		emitModelFinish(w, "stop", 1)
	})
	f.service.store = deletingCloudSourceStore{f.store}
	configureCloudResearchFixture(t, f)
	run, _ := f.createResearch(t, "deleted-research", "读取网页", "synthetic public page")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunFailed || finished.ErrorCode != "cloud_research_source_unavailable" || f.calls.Load() != 1 {
		t.Fatalf("source deletion state=%s code=%s", finished.State, finished.ErrorCode)
	}
}

func TestCloudRunUnknownSearchNeverRepeatsPaidPost(t *testing.T) {
	f := newCloudHTTPFixture(t, func(w http.ResponseWriter, r *http.Request) {
		emitToolCalls(w, map[string]any{"index": 0, "id": "search", "type": "function", "function": map[string]any{"name": "web_search", "arguments": `{"query":"exactly once"}`}})
		emitModelFinish(w, "tool_calls", 1)
	})
	research := configureCloudResearchFixture(t, f)
	research.drop.Store(true)
	run, _ := f.createResearch(t, "unknown-search", "搜索资料", "exactly once")
	finished := f.wait(t, run.ID, func(run *CloudRun) bool { return run.Terminal() })
	if finished.State != CloudRunInterrupted || finished.ErrorCode != "cloud_research_outcome_unknown" || research.searches.Load() != 1 || f.calls.Load() != 1 {
		t.Fatalf("unknown search retried: state=%s code=%s count=%d", finished.State, finished.ErrorCode, research.searches.Load())
	}
}
