package cloudresearch

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"
)

type testResolver struct {
	mu      sync.Mutex
	answers [][]netip.Addr
	calls   int
	err     error
}

func (r *testResolver) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	if r.err != nil {
		return nil, r.err
	}
	if len(r.answers) == 0 {
		return nil, errors.New("synthetic DNS failure")
	}
	index := r.calls - 1
	if index >= len(r.answers) {
		index = len(r.answers) - 1
	}
	return append([]netip.Addr(nil), r.answers[index]...), nil
}
func (r *testResolver) count() int { r.mu.Lock(); defer r.mu.Unlock(); return r.calls }

type logicalConn struct {
	net.Conn
	peer net.Addr
}

func (c logicalConn) RemoteAddr() net.Addr { return c.peer }

func fetchFixture(t *testing.T, handler http.HandlerFunc, config FetchConfig) (*Fetcher, *testResolver, *atomic.Int64) {
	t.Helper()
	peer := httptest.NewServer(handler)
	t.Cleanup(peer.Close)
	u, _ := url.Parse(peer.URL)
	resolver := &testResolver{answers: [][]netip.Addr{{netip.MustParseAddr("93.184.216.34")}}}
	var calls atomic.Int64
	config.Network = Network{Resolver: resolver, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		calls.Add(1)
		host, port, err := net.SplitHostPort(address)
		if err != nil || !publicIP(netip.MustParseAddr(host)) || port != "80" {
			return nil, ErrUnsafeURL
		}
		conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", u.Host)
		if err != nil {
			return nil, err
		}
		return logicalConn{Conn: conn, peer: &net.TCPAddr{IP: net.ParseIP(host), Port: 80}}, nil
	}}
	fetcher, err := NewFetcher(config)
	if err != nil {
		t.Fatal(err)
	}
	return fetcher, resolver, &calls
}

func TestURLAndIPBoundaries(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "gopher://example.com", "http://user:secret@example.com/", "http://127.0.0.1/", "http://127.1/", "http://0177.0.0.1/", "http://2130706433/", "http://0x7f000001/", "http://[::ffff:127.0.0.1]/", "http://[::1]/", "http://169.254.169.254/latest/", "http://100.64.0.1/", "http://192.0.2.1/", "http://198.18.0.1/", "http://[2001:db8::1]/", "http://[64:ff9b::7f00:1]/", "http://[fe80::1%25eth0]/", "https://localhost/", "https://metadata.internal/", "https://example.com:22/", "https://example.com:/", "https://example.com\\@127.0.0.1/", "https://example.com/?access_token=synthetic", "https://example.com/?X-Amz-Signature=synthetic", "https://%31%32%37.0.0.1/", "https://example.com/\n"} {
		if _, err := NormalizeURL(raw); !errors.Is(err, ErrUnsafeURL) {
			t.Fatal("unsafe URL was accepted")
		}
	}
	for _, raw := range []string{"https://example.com:443/article#section", "http://8.8.8.8/news", "https://[2606:4700:4700::1111]/", "http://EXAMPLE.COM./news?q=test"} {
		if _, err := NormalizeURL(raw); err != nil {
			t.Fatalf("public candidate rejected: %v", err)
		}
	}
	for _, raw := range []string{"0.0.0.0", "10.1.2.3", "127.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "224.1.1.1", "255.255.255.255", "192.52.193.1", "198.51.100.1", "203.0.113.1", "::", "::1", "fc00::1", "fe80::1", "ff00::1", "2001::1", "2002:7f00:1::", "3fff::1"} {
		if publicIP(netip.MustParseAddr(raw)) {
			t.Fatal("reserved IP was accepted")
		}
	}
}

func TestFetchPinnedHTMLAndEvidence(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	body := `<html><head><title>研究 &amp; 结果</title><script>synthetic-script-secret</script><style>synthetic-style-secret</style></head><body><p>第一行 <b>内容</b></p><div>第二行 &lt;资料&gt;</div><template>hidden-template</template><iframe>hidden-frame</iframe><svg><text>hidden-svg</text></svg></body></html>`
	fetcher, resolver, dials := fetchFixture(t, func(w http.ResponseWriter, r *http.Request) {
		for _, header := range []string{"Authorization", "Cookie", "Proxy-Authorization", "Referer"} {
			if r.Header.Get(header) != "" {
				t.Error("page fetch forwarded a credential or referring URL")
			}
		}
		if r.Host != "public.example.com" {
			t.Error("URL hostname was replaced by the pinned IP in Host")
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		io.WriteString(w, body)
	}, FetchConfig{})
	doc, err := fetcher.Fetch(context.Background(), "http://public.example.com/article#part")
	if err != nil {
		t.Fatal(err)
	}
	if doc.Title != "研究 & 结果" || doc.Text != "第一行 内容\n第二行 <资料>" || len(doc.Lines) != 2 || doc.Lines[1].Number != 2 || !doc.Untrusted || doc.Truncated {
		t.Fatalf("unexpected normalized document: title=%q text=%q", doc.Title, doc.Text)
	}
	for _, hidden := range []string{"synthetic-script-secret", "synthetic-style-secret", "hidden-template", "hidden-frame", "hidden-svg"} {
		if strings.Contains(doc.Text, hidden) {
			t.Fatal("active or hidden container text escaped filtering")
		}
	}
	textHash := sha256.Sum256([]byte(doc.Text))
	bodyHash := sha256.Sum256([]byte(body))
	if doc.SHA256 != hex.EncodeToString(textHash[:]) || doc.BodySHA256 != hex.EncodeToString(bodyHash[:]) || doc.FinalURL != "http://public.example.com/article" || doc.FetchedAt.IsZero() {
		t.Fatal("source provenance did not match retained text/body")
	}
	if resolver.count() != 1 || dials.Load() != 1 {
		t.Fatal("dial performed another DNS lookup instead of pinning validation result")
	}
}

func TestFetchRejectsMixedAndReboundDNS(t *testing.T) {
	for _, mixed := range []bool{true, false} {
		t.Run(fmt.Sprint(mixed), func(t *testing.T) {
			var requests atomic.Int64
			fetcher, resolver, dials := fetchFixture(t, func(w http.ResponseWriter, r *http.Request) { requests.Add(1); http.Redirect(w, r, "/final", 302) }, FetchConfig{})
			if mixed {
				resolver.answers = [][]netip.Addr{{netip.MustParseAddr("93.184.216.34"), netip.MustParseAddr("127.0.0.1")}}
			} else {
				resolver.answers = append(resolver.answers, []netip.Addr{netip.MustParseAddr("169.254.169.254")})
			}
			doc, err := fetcher.Fetch(context.Background(), "http://public.example.com/start")
			if !errors.Is(err, ErrUnsafeURL) || doc.Text != "" {
				t.Fatal("mixed/rebound DNS reached a body")
			}
			if mixed && (dials.Load() != 0 || requests.Load() != 0) {
				t.Fatal("mixed DNS was filtered after opening a connection")
			}
			if !mixed && (resolver.count() != 2 || dials.Load() != 1 || requests.Load() != 1) {
				t.Fatal("redirect did not revalidate DNS before a second connection")
			}
		})
	}
}

func TestFetchRedirectsNeverForwardCredentialsAndAreBounded(t *testing.T) {
	var requests atomic.Int64
	fetcher, _, _ := fetchFixture(t, func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("Cookie") != "" || r.Header.Get("Referer") != "" {
			t.Error("redirect inherited browser state")
		}
		if r.URL.Path == "/start" {
			w.Header().Set("Set-Cookie", "private=synthetic; Path=/")
			http.Redirect(w, r, "/final", 302)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "public evidence")
	}, FetchConfig{})
	doc, err := fetcher.Fetch(context.Background(), "http://public.example.com/start")
	if err != nil || doc.FinalURL != "http://public.example.com/final" || requests.Load() != 2 {
		t.Fatal("safe redirect did not complete")
	}
	loop, _, loopDials := fetchFixture(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "/again", 302) }, FetchConfig{})
	if _, err = loop.Fetch(context.Background(), "http://public.example.com/start"); !errors.Is(err, ErrRedirectLimit) || loopDials.Load() != 4 {
		t.Fatal("redirect budget was not three hops")
	}
	unsafe, _, unsafeDials := fetchFixture(t, func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, "http://127.0.0.1/private", 302) }, FetchConfig{})
	if _, err = unsafe.Fetch(context.Background(), "http://public.example.com/start"); !errors.Is(err, ErrUnsafeURL) || unsafeDials.Load() != 1 {
		t.Fatal("private redirect was dialed")
	}
}

func TestFetchRejectsUnexpectedActualPeer(t *testing.T) {
	var requests atomic.Int64
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1) }))
	defer peer.Close()
	u, _ := url.Parse(peer.URL)
	fetcher, err := NewFetcher(FetchConfig{Network: Network{Resolver: &testResolver{answers: [][]netip.Addr{{netip.MustParseAddr("93.184.216.34")}}}, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "tcp", u.Host)
	}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = fetcher.Fetch(context.Background(), "http://public.example.com/"); !errors.Is(err, ErrUnsafeURL) || requests.Load() != 0 {
		t.Fatal("actual peer was not checked against pinned public IP")
	}
}

func TestFetchBodyContentAndParserLimits(t *testing.T) {
	var zipped bytes.Buffer
	gzipWriter := gzip.NewWriter(&zipped)
	gzipWriter.Write(bytes.Repeat([]byte("x"), 1024))
	gzipWriter.Close()
	for _, test := range []struct {
		name                  string
		body                  []byte
		contentType, encoding string
		limits                Limits
		expected              error
	}{
		{"wire", bytes.Repeat([]byte("x"), 65), "text/plain", "", Limits{MaxWireBytes: 64}, ErrTooLarge},
		{"decoded", zipped.Bytes(), "text/plain", "gzip", Limits{MaxResponseBytes: 64}, ErrTooLarge},
		{"badgzip", []byte("invalid gzip"), "text/plain", "gzip", Limits{}, ErrInvalidResponse},
		{"unsupportedencoding", []byte("text"), "text/plain", "br", Limits{}, ErrUnsupportedContent},
		{"binary", []byte("%PDF-1.7"), "application/pdf", "", Limits{}, ErrUnsupportedContent},
		{"invalidUTF8", []byte{0xff, 0xfe}, "text/plain", "", Limits{}, ErrUnsupportedContent},
		{"legacycharset", []byte("text"), "text/plain; charset=gb2312", "", Limits{}, ErrUnsupportedContent},
		{"tokenbuffer", []byte(`<p data-value="` + strings.Repeat("a", 256) + `">text</p>`), "text/html", "", Limits{MaxTokenBytes: 64}, ErrTooLarge},
		{"tokencount", []byte(strings.Repeat("<p>text</p>", 10)), "text/html", "", Limits{MaxHTMLTokens: 5}, ErrTooLarge},
		{"empty", []byte("<script>only script</script>"), "text/html", "", Limits{}, ErrNoContent},
	} {
		t.Run(test.name, func(t *testing.T) {
			fetcher, _, _ := fetchFixture(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", test.contentType)
				if test.encoding != "" {
					w.Header().Set("Content-Encoding", test.encoding)
				}
				w.Write(test.body)
			}, FetchConfig{Limits: test.limits})
			doc, err := fetcher.Fetch(context.Background(), "http://public.example.com/")
			if !errors.Is(err, test.expected) || doc.Text != "" {
				t.Fatalf("limit failure returned an alleged body: %v", err)
			}
		})
	}
	for _, chunked := range []bool{false, true} {
		t.Run("truncation"+strconv.FormatBool(chunked), func(t *testing.T) {
			fetcher, _, _ := fetchFixture(t, func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/plain")
				if chunked {
					w.(http.Flusher).Flush()
				}
				io.WriteString(w, "第一行\n第二行\n第三行")
			}, FetchConfig{Limits: Limits{MaxLines: 2, MaxTextBytes: 22}})
			doc, err := fetcher.Fetch(context.Background(), "http://public.example.com/")
			if err != nil || !doc.Truncated || !utf8.ValidString(doc.Text) || len(doc.Lines) > 2 || len(doc.Text) > 22 {
				t.Fatal("bounded UTF-8 truncation was not explicit")
			}
		})
	}
}

func TestFetchHeaderStatusReadAndTimeoutFailuresAreSafe(t *testing.T) {
	for _, mode := range []string{"headers", "status", "brokenbody", "timeout"} {
		t.Run(mode, func(t *testing.T) {
			fetcher, _, _ := fetchFixture(t, func(w http.ResponseWriter, r *http.Request) {
				switch mode {
				case "headers":
					w.Header().Set("X-Large", strings.Repeat("x", 65536))
					w.Header().Set("Content-Type", "text/plain")
					io.WriteString(w, "body")
				case "status":
					w.WriteHeader(503)
					io.WriteString(w, "synthetic-private-reflected-provider-detail")
				case "brokenbody":
					conn, _, _ := w.(http.Hijacker).Hijack()
					io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 20\r\n\r\nabc")
					conn.Close()
				case "timeout":
					<-r.Context().Done()
				}
			}, FetchConfig{})
			ctx := context.Background()
			var cancel context.CancelFunc
			if mode == "timeout" {
				ctx, cancel = context.WithTimeout(ctx, 20*time.Millisecond)
				defer cancel()
			}
			doc, err := fetcher.Fetch(ctx, "http://public.example.com/")
			if err == nil || doc.Text != "" || strings.Contains(err.Error(), "synthetic-private") {
				t.Fatal("failed fetch fabricated or reflected a body")
			}
			if mode == "timeout" && !errors.Is(err, context.DeadlineExceeded) {
				t.Fatal("request deadline was lost")
			}
		})
	}
}

func TestFetchConcurrencyAndCancellation(t *testing.T) {
	entered, release := make(chan struct{}), make(chan struct{})
	fetcher, _, _ := fetchFixture(t, func(w http.ResponseWriter, r *http.Request) {
		close(entered)
		<-release
		w.Header().Set("Content-Type", "text/plain")
		io.WriteString(w, "text")
	}, FetchConfig{Limits: Limits{MaxConcurrent: 1}})
	finished := make(chan error, 1)
	go func() { _, err := fetcher.Fetch(context.Background(), "http://public.example.com/"); finished <- err }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("fixture did not start")
	}
	if _, err := fetcher.Fetch(context.Background(), "http://public.example.com/"); !errors.Is(err, ErrBusy) {
		t.Fatal("concurrency was unbounded")
	}
	close(release)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := fetcher.Fetch(ctx, "http://public.example.com/"); !errors.Is(err, context.Canceled) {
		t.Fatal("cancelled fetch started")
	}
}

func TestFetchInfrastructureErrorsNeverReflectSensitiveDetails(t *testing.T) {
	const reflected = "synthetic-private-network-secret"
	for _, dns := range []bool{true, false} {
		t.Run(strconv.FormatBool(dns), func(t *testing.T) {
			resolver := &testResolver{answers: [][]netip.Addr{{netip.MustParseAddr("93.184.216.34")}}}
			if dns {
				resolver.err = errors.New(reflected)
			}
			fetcher, err := NewFetcher(FetchConfig{Network: Network{Resolver: resolver, DialContext: func(context.Context, string, string) (net.Conn, error) { return nil, errors.New(reflected) }}})
			if err != nil {
				t.Fatal(err)
			}
			doc, err := fetcher.Fetch(context.Background(), "http://public.example.com/")
			if !errors.Is(err, ErrUnavailable) || doc.Text != "" || strings.Contains(err.Error(), reflected) {
				t.Fatal("infrastructure error escaped sanitization")
			}
		})
	}
}
