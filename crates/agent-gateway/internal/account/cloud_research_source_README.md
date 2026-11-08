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

- `GET /api/web-chat/sources/{id}` returns the owned source's ID, title, and
  original link metadata. Responses are private, non-cacheable JSON.

Web uses `createCloudChatSourcesClient(accountFetch,captureAccountRequestGuard)`
from `web/src/lib/cloudChatSources.ts` with bounded parsing. `CloudChatSourceLinkDialog`
shows the title and host within the current chat or task. The citation syntax is
`【来源:UUID】`. Opening the original HTTP(S) page is an explicit
`noopener noreferrer` browser link.

Memory and real isolated PostgreSQL contracts cover publication fencing,
deduplication/conflict, concurrent account budget reservation, empty receipts,
ownership, branch retention and explicit deletion. HTTP and Web client tests cover private-body exclusion, ownership, bounded
metadata parsing, safe errors and explicit external navigation. Synthetic protocol data is test
evidence only. Real Tavily, public-web/provider deployment and paid usage remain
unverified.
