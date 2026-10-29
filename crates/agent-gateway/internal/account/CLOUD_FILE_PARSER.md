# Isolated CloudFile parsing

`Service.SetCloudExecutor(*cloudexecutor.Client)` configures the explicit internal
adapter client. Nil disables it. `StartCloudFileParser(ctx)` starts at most two
file tasks per Gateway with five-minute overall contexts; replacement is refused
until `CloseCloudFileParser` cancels/waits. The shared client remains available
through `CloudExecutor()` for other explicitly authorized CloudChat tools.
The application owns client creation, readiness and shutdown.

Only verified canonical originals in object storage enter this pipeline. PDF,
DOCX, XLSX and PPTX are parsed in independent per-file E2B VMs; desktop execution
and conversation workspaces are not reused. Other binary formats remain uploaded
and awaiting a supported isolated parser. Plain UTF-8 text retains its existing
bounded extraction path. Missing executor configuration never marks binary files
ready and does not cause allocations.

Before a new create operation is dispatched, its stable operation ID reserves
300 seconds in the same account/UTC-day budget as conversation workspaces
(default 3600 seconds). Concurrent allocations serialize on the shared counter;
same-ID retries and recovery do not reserve again, including across midnight.
Failed/unknown allocations are not refunded because the provider may already
have acted. Exhaustion records `allocation_limit`, retains the verified original
and never dispatches a create request.

`parser_task` and `parsed_segments` extend the existing CloudFile row. Public
metadata excludes both. Private facts bind file ID, original SHA256, owner scope,
workspace reference, task UUID, lease owner, phase, stable operation IDs/request
hashes and receipts. CAS row versions plus immutable deletion intent fence every
checkpoint and final publication. Restart takeover first queries already
dispatched operation IDs; missing/unknown receipts are not new submissions.
Completed steps replay durable receipts. An unknown effect remains explicitly
failed/`parse_unknown` for reconciliation and is never automatically reallocated.

Stages: creating sandbox, byte-only chunk upload, isolated parse, verified JSON
retrieval, atomic ready publication, VM termination. The original stays in object
storage regardless of VM lifetime. Upload uses <=1 MiB frames for <=32 MiB input;
the host stages/hashes bytes and does not parse an untrusted document. Derived
JSON is <=2 MiB, size/SHA checked by the client, then its scope, sandbox, source
hash, segment IDs, count, UTF-8/NUL limits and typed locators are validated before
ready. PDF page, DOCX body paragraph, XLSX sheet/cell and PPTX slide/paragraph
locators persist together with text and an explicit truncation indicator.

`GET /api/web-chat/files/{id}/segments?offset=0&limit=100` returns at most 100
segments/256 KiB for a ready owned file, its source hash, next offset, extraction
warnings and truncation. Existing bounded line excerpts remain available. Model
context/citation renderers can map segment IDs to these source locators; this
module does not invent model answers or run another Agent loop.

Deletion first persists the tombstone, cancels the active file task and waits for
its remote cancellation/VM cleanup, reloads the current version, then removes the
canonical object. Cleanup failure keeps the deletion intent for reconciliation;
late output cannot publish ready. Deletion clears canonical extracted text,
segments and content-bearing download receipts from its database facts. Object
deletion and VM termination are not distributed atomic effects: unknown cleanup
remains recorded rather than being falsely confirmed. The adapter's own private
receipt journal has a separately documented retention policy and still needs
deployment archival/erasure policy before production use.

VM cancellation may discard VM-local files. Originals and ready segments are
independent durable resources. A create response lost before its sandbox ID is
known triggers scoped E2B metadata reconciliation using the original create
operation ID, never a new allocation. At most 20 owned, isolated candidates are
accepted; their IDs persist before stable per-VM kill operations. Every observed
VM must be confirmed terminated before `vm_stopped`. Empty listings, invalid or
excess candidates and uncertain kills keep cleanup unresolved. Read-only queries
back off for 30 seconds and retain only the latest query fact; mutation IDs and
all accepted candidate IDs remain durable. The adapter's five-minute automatic
pause lifetime is not proof of termination. Persistently unresolved cases need
operator/provider reconciliation and production monitoring.

Each terminal SDK result is acknowledged only after its own Gateway fact has
committed. This compacts the adapter payload while retaining its immutable
ID/hash/scope tombstone; an acknowledged old operation cannot execute again.
Unknown/executing results are never acknowledged. ACK failure is best effort and
does not undo a committed file or cause a new execution. During restart, parser
steps use the durable local receipt (including bytes still needed by an active
task), not an already retired adapter payload. The workspace load helper has no
per-step durable receipts and deliberately does not acknowledge its transfer.

Tests exercise the actual local HTTP protocol with SDK/object-storage fixtures,
owner isolation, source corruption, result scope/locator/digest rejection,
delete/cancel/late-ready fencing, restart-with-missing-receipt and explicit
disabled lifecycle. PostgreSQL tests use only a supplied loopback test DSN and
fresh isolated schemas, verifying success and failure facts plus metadata pages.
The parser script itself has separate real Linux generated PDF/OOXML fixtures.
No E2B allocation, billing, real template, live network policy or remote kill has
been accepted by those tests.
