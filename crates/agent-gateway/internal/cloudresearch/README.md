# Cloud research evidence adapters

This package provides search candidates and bounded page evidence. It does not
register an HTTP route, persist a citation, choose a model/tool, or run an agent
loop. The Gateway caller owns account/Run authorization, cancellation, budgets,
durable operations, source IDs, citations, and persistence. Keep long-lived
adapter instances so their concurrency gates apply across calls.

## Search

`TavilyConfigFromEnv(os.Getenv)` reads only `ZEROAGENT_TAVILY_API_KEY`.
`NewTavily(config)` does no I/O. An absent key yields a disabled adapter with a
safe `Status()` diagnostic; no ambient Tavily/AWS profile or alternative endpoint
is consulted. Config formatting redacts the key.

`Search(ctx, query) (SearchResult, error)` uses only
`POST https://api.tavily.com/search`, with Bearer authentication, basic search,
general topic, five results by default (configurable 1–10), and explicit false
values for generated answers, raw pages, images and automatic parameters. The
query is bounded to 400 Unicode runes / 2 KiB. No request is automatically retried:
a failed POST may already have consumed a provider credit. A caller must reserve
its own search budget before calling the adapter.

Only ordered URL/title/snippet candidates leave the adapter. Duplicates and
syntactically unsafe/literal-private URLs are excluded. Titles and snippets are
normalized to one line and bounded to 512 / 4096 UTF-8 bytes. `Truncated` records
clipping. Candidate URLs have **not** been fetched or DNS-validated; call `Fetch`
to establish retrievable public evidence. Search failure is distinct from a
successful response with no sources. Provider errors/bodies and key reflections
are never exposed as evidence or wrapped into errors.

The fixed provider origin also uses validated public DNS and literal-IP dialing,
normal TLS verification, no environment proxy, cookies or redirects. Search
responses are bounded to 1 MiB compressed and decompressed. It accepts no browser
headers or user-selected API origin. Default total timeout is 15 seconds;
configuration allows 1–60 seconds. Four concurrent searches are admitted.

`NewTavilyWithTransport` is a trusted Go-only seam for account/runtime protocol
tests against isolated HTTP peers. It keeps the outgoing request URL fixed and
disables client redirects. It is never an HTTP/model-configurable endpoint; its
trusted RoundTripper must use one bounded request without environment proxies,
cookies or its own redirect loop. Normal construction uses the pinned transport.

## Public page fetch

`NewFetcher(FetchConfig{})` and `Fetch(ctx, publicURL) (Document, error)` provide
plain, untrusted evidence. This operation is separately authorized by its caller;
a missing search-provider key does not authorize page fetching automatically.

`NormalizeURL` is a syntax/literal-address check, **not** the SSRF authorization
step. Fetch performs that step for every request and redirect:

1. Accept only absolute HTTP port 80 or HTTPS port 443. Reject userinfo, controls,
   backslashes, non-ASCII host labels, IP zones, ambiguous numeric addresses and
   credential-bearing query keys. Fragments/default ports are removed.
2. Resolve all A/AAAA results. Reject the entire set if any result is private,
   loopback, link-local, multicast, reserved/special-purpose or otherwise outside
   generic public unicast. Conservative IANA special-purpose blocks are excluded
   even when a particular anycast service is globally reachable.
3. Connect only to a validated literal IP and verify the actual socket peer
   matches that IP/port. The original hostname remains in Host and TLS SNI.
   No second DNS lookup can change the dial destination.
4. Follow at most three redirects manually, revalidating DNS and rebuilding a
   fresh connection at every hop. Cookies, credentials and Referer never cross
   hops. HTTP environment proxies and pooled/coalesced connections are disabled.

`Network.Resolver` / `DialContext` are trusted construction seams for isolated
protocol tests; never populate them from client or model input. Tests bridge a
logical vetted public address to a local fixture and explicitly represent its
logical peer. A plain mismatched loopback peer is rejected.

Default limits (configurable up to enforced hard bounds):

| Resource | Default | Hard maximum |
| --- | ---: | ---: |
| Total deadline, including redirects | 15 s | 60 s |
| Response headers | 32 KiB | 64 KiB |
| Wire bytes | 2 MiB | 8 MiB |
| Decompressed bytes | 2 MiB | 8 MiB |
| Retained UTF-8 text | 256 KiB | 1 MiB |
| Retained Unicode runes | 65,536 | 262,144 |
| Retained normalized lines | 2,000 | 10,000 |
| HTML tokenizer tokens | 100,000 | 500,000 |
| HTML tokenizer buffer per token | 64 KiB | 256 KiB |
| Concurrent fetches per instance | 4 | 16 |

Only identity/gzip content coding and UTF-8/ASCII textual media are accepted.
Wire and decoded limits are independent. HTML uses the existing `x/net/html`
tokenizer with an explicit buffer cap, token count and blocked-container depth.
Scripts, styles, templates, frames, SVG/MathML and other active containers are
excluded. The parser never executes scripts, follows subresources, accepts
browser cookies, or interprets a page as tool instructions. This is bounded text
extraction, not browser rendering, paywall access or semantic article ranking.

`Text` is whitespace-normalized retained text. `Lines` numbers that exact text
from one. `SHA256` hashes that UTF-8 text; `BodySHA256` hashes the complete bounded
decompressed response body before text extraction. `FinalURL` and `FetchedAt`
record provenance. Text/line/rune clipping is a successful partial extraction
with `Truncated=true`. Transport, decompression, byte/tokenizer or encoding
failures return **no document**, never a synthetic success paragraph. References
must point only to retained lines after the caller persists this snapshot.

All results have `Untrusted=true`: source text, titles, snippets and links are
external data. The caller must isolate them from system/tool instructions and
check ownership again when serving a persisted source. Hashes describe observed
bytes, not truth or permanent remote availability.

## Evidence and references

`go test ./internal/cloudresearch` and `go vet ./internal/cloudresearch` use
injected DNS/dialing and real isolated HTTP peers for rebinding, mixed DNS,
redirects, peer pinning, credentials/proxy isolation, compressed/decoded bounds,
HTML limits, cancellation, concurrency and safe provider errors/reflections.
No real Tavily key, search, webpage crawl, subscription or paid request was used.
Real provider acceptance and production egress/throughput remain unverified.

Read-only LibreChat references: `api/server/services/Tools/search.js` for ordered
source maps and resumable source attachments, and
`packages/api/src/tools/registry/definitions.ts` for bounded search arguments.
ZeroAgent retains its Go service/runtime and its own account-bound resource API.

Official references reviewed:

- [Tavily Search endpoint](https://docs.tavily.com/documentation/api-reference/endpoint/search)
- [Tavily credit model](https://docs.tavily.com/documentation/api-credits)
- [Go HTML tokenizer and buffer limits](https://pkg.go.dev/golang.org/x/net/html)
- [IANA IPv4 special-purpose registry](https://www.iana.org/assignments/iana-ipv4-special-registry/)
- [IANA IPv6 special-purpose registry](https://www.iana.org/assignments/iana-ipv6-special-registry/)
