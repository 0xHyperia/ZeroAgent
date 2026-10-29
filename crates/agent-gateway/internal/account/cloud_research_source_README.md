# Account-owned research snapshots

`CloudResearchSourceStore` adds three independent tables through
`CloudResearchSourceSchema`: source snapshots, publication receipts, and search
reservations. None cascades from conversation/Run deletion. Existing v2 history
is untouched. The account source library retains evidence until explicit source
deletion; a branch's immutable source IDs still work after the original
conversation is deleted.

The Gateway runtime, not the browser, publishes sources:

1. Prepare and start an owned `web_search` / `fetch_page` tool operation.
2. For search, call `ReserveCloudResearchSearch(ctx,userID,runID,owner,attempt,
   toolOperationID,dailyLimit)` before the provider POST. Exactly one caller gets
   `true`. `false` is **not** permission to retry a possibly billed search: use
   `GetCloudResearchSourcesForOperation`, or preserve an unknown outcome.
3. After real SDK results, call `Service.PersistCloudResearchSources` with the
   same fenced identifiers, source inputs, and known model/session secrets as
   the optional variadic arguments. It rejects known plain/URL/base64 credential
   reflection before storage. Tavily separately guards its private provider key.
4. Persist tool success only after source publication succeeds. Model/tool
   private results and public source metadata are distinct. Nothing in this
   module executes external requests or creates an agent loop.

Publication and reservation check authenticated owner, current Run lease owner,
execution attempt, running state and the exact executing tool in one Memory lock
or PostgreSQL transaction. A prepared/cancelled/stale tool cannot publish.
Publication is an immutable whole-batch receipt keyed by tool operation ID and
canonical content hash; retries return the original server-generated UUIDs and
ordinal order. Empty search results also have a receipt. Changed input conflicts.
Deleted snapshots are never recreated by replaying a receipt.

Search reservations remain charged to the account's UTC day after unknown
outcomes, cancellation, or history deletion. A caller chooses a policy limit
within the current safety maximum of 1,000/day; no default billing entitlement is
inferred here. Source storage is bounded to 10 items/operation, 5,000 active
items/account and 128 MiB retained text/summary per account. Current bounds are
operational defaults, not a final product tier design.

`CloudResearchSourceInput.Kind` distinguishes:

- `search_snippet`: URL/title/summary observed by the search provider. It has no
  fetched body, final redirect URL or webpage lines. Its SHA hashes the retained
  summary. The source viewer explicitly labels it as a search summary.
- `page`: the real fetcher's requested/final URL, UTF-8 text, text SHA, full
  bounded decoded-body SHA, observed time and truncation flag. The stored text
  is capped at 1 MiB / 10,000 lines. Its exact retained text defines line numbers;
  callers must not add invented page text when a fetch failed.

Full page text, tool IDs, owner IDs and publication fingerprints do not appear in
source metadata JSON. The metadata list never loads full bodies. Explicit delete
requires a matching version, clears body/summary and retains a tombstone and
receipt. It invalidates future source viewing and use; already-used material may
still appear in the conversation/model result and in private tool audit facts.
Deleting a source is not a claim to erase third-party websites or prior model
context.

## HTTP and Web integration

Root registers `registerCloudResearchSources(mux)`:

- `GET /api/web-chat/sources?conversation_id=&before=&limit=` returns
  `{sources,next_cursor}`. No conversation filter means the account library.
  A conversation filter verifies its current owner; deleted origins remain
  available through the independent account library and direct source ID.
- `GET /api/web-chat/sources/{id}` returns `{source}` metadata.
- `GET /api/web-chat/sources/{id}/content?from_line=&to_line=` returns exact
  numbered retained lines, at most 200 lines / 256 KiB. Search-only sources
  return 409, never alleged webpage lines.
- `DELETE /api/web-chat/sources/{id}`, `If-Match: "version"`, deletes only an
  owned snapshot. Repeat deletion is idempotent. All responses are private,
  non-cacheable, account-authenticated JSON; there is no public publication API
  or redirect-to-website endpoint.

Web uses `createCloudChatSourcesClient(accountFetch,captureAccountRequestGuard)`
from `web/src/lib/cloudChatSources.ts`. Parsing and immediate UI use remain tied
to the original account generation and bounded response size.
`CloudChatSourcesPanel` props are `client`, `initialSourceId?`, `fromLine?`,
`toLine?`, `isCurrent`, `onClose`, optional `onDeleted` / `onError`. Key the panel
to the account/conversation view and close it on view retirement.

`linkCloudSourceCitations(text)` maps `【来源:UUID】` and
`【来源:UUID:Lx-Ly】` into controlled `cloud-sources/UUID#Lx-Ly` links. Root's
transcript callback opens the panel, never a host file. A page citation must name
retained lines; search summaries have no page-line citation. The panel shows the
observed time, exact original host, summary/page distinction and truncation.
Opening the original HTTP(S) website is an explicit `noopener noreferrer`
browser link; the panel does not automatically fetch/embed any external page.

Memory and real isolated PostgreSQL contracts cover publication fencing,
deduplication/conflict, concurrent account budget reservation, empty receipts,
ownership, branch retention and explicit deletion. HTTP and Web/client tests
cover private-body exclusion, source excerpts, search-only honesty, retired
accounts, safe errors and explicit deletion. Synthetic protocol data is test
evidence only. Real Tavily, public-web/provider deployment and paid usage remain
unverified.
