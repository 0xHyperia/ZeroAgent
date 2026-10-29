package cloudchat_test

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strings"
	"testing"

	"github.com/liveagent/agent-gateway/internal/account"
	"github.com/liveagent/agent-gateway/internal/cloudresearch"
)

type browserResearchTransport func(*http.Request) (*http.Response, error)

func (f browserResearchTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

type browserPublicResolver struct{}

func (browserPublicResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("93.184.216.34")}, nil
}

type browserLogicalPublicConnection struct{ net.Conn }

func (browserLogicalPublicConnection) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.ParseIP("93.184.216.34"), Port: 80}
}

// Only this test injects a logical public peer. Production's real DNS/socket
// checks remain intact. No Tavily or Internet request occurs in this fixture.
func configureBrowserResearch(t *testing.T, service *account.Service) {
	t.Helper()
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/search" {
			if r.Header.Get("Authorization") != "Bearer browser-fixture-search-only" {
				http.Error(w, "wrong fixture search authority", 403)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"results":[{"url":"http://example.com/cloudchat-fixture","title":"CloudChat 合成资料","content":"这是合成搜索摘要，不能冒充已读取网页。","score":1}]}`)
			return
		}
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			http.Error(w, "credential boundary failed", 403)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(w, `<html><head><title>CloudChat 来源验收</title></head><body><p>本页面是合成资料，用于检查浏览器引用。</p><p>结论：正式成果应独立于临时沙箱保存。</p></body></html>`)
	}))
	t.Cleanup(peer.Close)
	target, err := url.Parse(peer.URL)
	if err != nil {
		t.Fatal(err)
	}
	transport := &http.Transport{Proxy: nil}
	t.Cleanup(transport.CloseIdleConnections)
	search, err := cloudresearch.NewTavilyWithTransport(cloudresearch.TavilyConfig{APIKey: "browser-fixture-search-only"}, browserResearchTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://api.tavily.com/search" {
			return nil, fmt.Errorf("unexpected search endpoint")
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
	reader, err := cloudresearch.NewFetcher(cloudresearch.FetchConfig{Network: cloudresearch.Network{Resolver: browserPublicResolver{}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, target.Host)
		if err != nil {
			return nil, err
		}
		return browserLogicalPublicConnection{conn}, nil
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = service.SetCloudResearch(search, reader); err != nil {
		t.Fatal(err)
	}
}

func respondBrowserResearch(w http.ResponseWriter, round int, lastResult map[string]any) bool {
	name, args := "web_search", map[string]any{"query": "CloudChat 合成资料验收"}
	if round == 1 {
		name, args = "fetch_page", map[string]any{"url": "http://example.com/cloudchat-fixture"}
	}
	if round >= 2 {
		sources, _ := lastResult["sources"].([]any)
		if len(sources) == 0 {
			http.Error(w, "missing synthetic source", 502)
			return true
		}
		source, _ := sources[0].(map[string]any)
		id, _ := source["source_id"].(string)
		if id == "" || source["page_fetched"] != true {
			http.Error(w, "synthetic page was not persisted", 502)
			return true
		}
		text := "本地合成研究已完成：正式成果应独立于临时沙箱保存。【来源:" + id + ":L1-L2】\n\n这仅验证引用流程，不代表真实联网研究质量。"
		_, _ = fmt.Fprintf(w, "data: %s\n\n", browserJSON(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"content": text}}}}))
		browserModelFinish(w, "stop")
		return true
	}
	call := map[string]any{"index": 0, "id": fmt.Sprintf("browser_research_%d", round), "type": "function", "function": map[string]any{"name": name, "arguments": string(browserJSON(args))}}
	_, _ = fmt.Fprintf(w, "data: %s\n\n", browserJSON(map[string]any{"choices": []any{map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{call}}}}}))
	browserModelFinish(w, "tool_calls")
	return true
}

func TestBrowserSyntheticResearchPublicThenPrivateReplay(t *testing.T) {
	workflow := newBrowserToolFixture(t)
	sourceID := "82000000-0000-4000-8000-000000000091"
	public := []any{map[string]any{"role": "user", "content": "联网研究验收"}}
	for round, expected := range []string{"web_search", "fetch_page", "【来源:" + sourceID + ":L1-L2】"} {
		response := httptest.NewRecorder()
		if !workflow.respondModel(response, browserJSON(map[string]any{"messages": public})) || response.Code != 200 || !strings.Contains(response.Body.String(), expected) {
			t.Fatalf("synthetic public research round %d failed", round)
		}
		if round < 2 {
			output := map[string]any{"sources": []any{map[string]any{"source_id": sourceID, "page_fetched": round == 1}}, "untrusted": true}
			public = append(public, map[string]any{"role": "assistant", "content": "synthetic public plan"}, map[string]any{"role": "tool", "content": string(browserJSON(output))})
		}
	}
	// The real loop attaches the public assistant/tool chain after the original
	// private user request. The fixture must summarize, not launch search again.
	private := []any{map[string]any{"role": "system", "content": "synthetic private context"}, map[string]any{"role": "user", "content": "联网研究验收，请结合私有资料作答。"}}
	private = append(private, public[1:]...)
	response := httptest.NewRecorder()
	if !workflow.respondModel(response, browserJSON(map[string]any{"messages": private})) || response.Code != 200 || !strings.Contains(response.Body.String(), "【来源:"+sourceID+":L1-L2】") || strings.Contains(response.Body.String(), `"tool_calls"`) {
		t.Fatal("synthetic private synthesis did not preserve completed research without further tools")
	}
}
