# ZeroAgent Cloud executor

This internal service adapts the official E2B JavaScript SDK (`e2b` 2.62.0 and
`@e2b/code-interpreter` 2.9.0). Go owns the Agent loop, user authorization, durable
Run/tool facts, approvals and budgets. This package has no model provider, Agent
loop, browser API, local desktop capabilities or user-profile discovery.

## Configuration and startup

Node 24.14.1 or newer is required. From the repository:

```text
pnpm --filter @zeroagent/cloud-executor typecheck
pnpm --filter @zeroagent/cloud-executor test
pnpm --filter @zeroagent/cloud-executor start
```

Supply these to the dedicated service process through the deployment secret
manager. Do not put real values in shell examples, source files or logs.

| Variable | Meaning |
| --- | --- |
| `ZEROAGENT_CLOUD_EXECUTOR_TOKEN` | Required, random secret of at least 32 bytes. Used only by the trusted Gateway and this adapter. |
| `ZEROAGENT_CLOUD_EXECUTOR_SCOPE_KEY` | Stable random HMAC key, at least 32 bytes. Defaults to internal token; configure separately before rotating the token. |
| `ZEROAGENT_CLOUD_EXECUTOR_DATA_DIR` | Required absolute, dedicated private directory. POSIX files/directories use 0600/0700. Set an equivalent private service-account ACL on Windows. |
| `ZEROAGENT_CLOUD_EXECUTOR_HOST` | `127.0.0.1` (default) or `::1` only. No public bind. |
| `ZEROAGENT_CLOUD_EXECUTOR_PORT` | Default 17843. Zero selects a random test port. |
| `ZEROAGENT_CLOUD_EXECUTOR_NAMESPACE` | Stable deployment identifier, default `zeroagent-cloudchat-v1`. |
| `ZEROAGENT_CLOUD_EXECUTOR_MAX_RECEIPTS` | Initial operation-identity limit, default 1,000,000; configurable 1..10,000,000. Identities are retained after results are acknowledged. |
| `ZEROAGENT_CLOUD_EXECUTOR_MAX_JOURNAL_BYTES` | Initial logical serialized-receipt budget, default 1 GiB; configurable 2,000,000 bytes..64 GiB. Already active operations can persist their bounded outcomes above admission budget. |
| `ZEROAGENT_E2B_API_KEY` | Explicit E2B management key. Missing means disabled; health explains why and submission returns 503. |
| `ZEROAGENT_E2B_TEMPLATE` | Required when E2B is enabled. Administrator-configured template, never a caller-selected template. Must contain Python 3, envd >=0.5.2 (stdin close), the `user` account and the E2B code-interpreter service for `code.run`. |

Legacy `E2B_*` environment values are removed from this service process and its
interpreter worker before SDK use. The E2B endpoint/domain/debug mode, management
key and retry policy are explicit. SDK request retries are zero. Management
credentials are not included in VM environment, operation records or responses.
Provision the configured template without bundled secrets. No deployment, E2B
allocation or paid call is performed by package install, startup or tests.
The adapter checks the provider-reported stable envd version before initializing
or executing in a workspace; versions older than 0.5.2, missing versions and
prerelease/invalid values fail closed. Terminating an owned VM remains possible
after version or network-policy drift. The pinned local template candidate and
offline acceptance are in `sandbox/template/`; they do not prove provider envd
or a successful remote E2B build.

## Internal protocol v1

Every endpoint requires `Authorization: Bearer <internal-token>`. Every mutation
uses JSON. Browser `Origin` requests are rejected and no CORS headers are served.
Only a trusted, owner-authorizing Gateway may reach this listener. The internal
token grants service authority: browser/user input must never choose an owner.

`GET /v1/health` returns `{service,protocol:1,enabled,disabled_reason?,limits,journal}`.
Journal counters report records, logical serialized receipt bytes and admission
availability. Capacity exhaustion or a failed durable write stops new dispatch;
it never removes old identities to make a duplicate operation appear new.

## Receipt storage and acknowledgement

The private SDK journal uses the pinned Node runtime's built-in SQLite, with
WAL/FULL durability and an 8 MiB page-cache target. It reads receipts by ID and
does not keep every result in JavaScript memory. A separate SQLite exclusive
transaction holds process ownership; OS lock release after process death does
not depend on container hostnames or PID-file stealing. Use a local durable
volume with working SQLite file locking, not shared network storage. Only one
executor owns that volume; the Gateway/sidecar pair is the current routing unit.
Horizontal replicas must each retain a distinct stable route and journal, or
use a separately designed shared authority before being enabled.

`POST /v1/operations/{id}/acknowledge`, with the owned scope as JSON, confirms
that the trusted Gateway has durably recorded the terminal fact. Only succeeded,
failed and cancelled outcomes are reclaimable. Unknown or executing operations
return 409. Acknowledgement removes the large result while retaining the
operation ID, request hash, scope, action and outcome. It is idempotent. Subsequent
GET or duplicate same-payload POST returns 410 `operation_result_retired`; a
changed payload still returns 409 and a foreign scope returns 404. A retired ID
never executes again, including after restart or an old Gateway backup restore.
Go maps 410 to a possibly executed outcome, never permission to retry the effect.
Late adapter checkpoints are ignored after the operation settles, so partial
progress cannot overwrite a terminal result before or after acknowledgement.
The journal also binds a one-way fingerprint of namespace and stable scope key;
an authority mismatch refuses startup. Rotating the separate internal token does
not change that authority.

Logical bytes shrink after acknowledgement and SQLite reuses free pages; this
does not promise immediate filesystem shrink or secure physical erasure. Back
up the journal using a consistent SQLite snapshot or while the sidecar is cleanly
stopped. Do not copy only a live main DB while ignoring its WAL. Existing JSON
journal directories are refused without deleting or migrating dispatch facts;
the unreleased candidate uses an explicitly new dedicated directory.

The exact Node 24.14.1 runtime used here marks `node:sqlite` experimental. Keep
the runtime pinned and run journal crash/durability tests on runtime upgrades;
the API is isolated to this module. See the [official Node SQLite contract](https://nodejs.org/download/release/v24.14.1/docs/api/sqlite.html).

`POST /v1/operations` accepts:

```json
{
  "operation_id": "stable-tool-operation-id",
  "owner_scope": "authorized-account-id",
  "workspace_ref": "authorized-workspace-id",
  "action": "command.run",
  "sandbox_id": "previously-created-sandbox-id",
  "input": {"command": "python3 analysis.py", "timeout_ms": 60000}
}
```

Identifiers use ASCII letters, numbers, `_ . : -`, start with a letter/number and
are at most 128 characters. All unknown fields are rejected.

| action | sandbox_id | input |
| --- | --- | --- |
| `sandbox.create` | absent | `{}`; administrator template, five-minute lifetime, automatic pause, automatic resume off |
| `sandbox.info` | required | `{}`; inspect without resume |
| `sandbox.connect` | required | `{}`; only if currently running |
| `sandbox.pause` | required | `{}`; full VM pause |
| `sandbox.resume` | required | `{}`; explicit SDK connect/resume |
| `sandbox.kill` | required | `{}`; terminate an owned VM, including one with policy drift |
| `sandbox.reconcile` | absent | `{"create_operation_id":"original-id"}`; list at most 20 exact scoped metadata matches; never creates or retries |
| `command.run` | required | `{"command":"...","cwd":"optional/relative/path","timeout_ms":60000}` |
| `code.run` | required | `{"code":"...","language":"python","timeout_ms":60000}`; language also supports javascript/typescript/bash/r/java if present in template |
| `file.read` | required | `{"path":"relative/path"}`; returns `data_base64` and `bytes` |
| `file.write` | required | `{"path":"relative/path","data_base64":"..."}`; returns `bytes` |
| `file.upload.begin` | required | `{"transfer_id":"32-to-64-lower-hex","path":"...","total_bytes":33554432,"sha256":"64-lower-hex"}` |
| `file.upload.chunk` | required | `{"transfer_id":"...","offset":0,"total_bytes":33554432,"sha256":"...","data_base64":"..."}`; at most 1 MiB per frame |
| `file.upload.finalize` | required | Same input as begin; whole-file SHA256 verification followed by atomic rename |
| `file.upload.abort` | required | `{"transfer_id":"...","total_bytes":33554432,"sha256":"..."}`; unfinished staging only |
| `file.download.chunk` | required | `{"path":"...","offset":0,"max_bytes":1048576,"expected_sha256":"..."}`; response includes offset/total/sha256/data_base64/bytes/eof |
| `file.parse` | required | `{"path":"...","output_path":"derived/file.json","format":"pdf","source_sha256":"..."}`; supported formats pdf/docx/xlsx/pptx |

Submission returns 202 while running or 200 for an existing finished operation.
The receipt is:

```json
{
  "operation_id": "stable-tool-operation-id",
  "action": "command.run",
  "state": "executing",
  "created_at": "2026-10-29T00:00:00.000Z",
  "updated_at": "2026-10-29T00:00:00.000Z",
  "result": {"sandbox_id":"optional-checkpoint"},
  "error": {"code":"optional-machine-code","message":"sanitized-message"}
}
```

`GET /v1/operations/{operation_id}?owner_scope=...&workspace_ref=...` polls the
durable receipt. `POST /v1/operations/{operation_id}/cancel` with
`{"owner_scope":"...","workspace_ref":"..."}` requests remote cancellation;
poll until terminal. Closing HTTP never cancels accepted work. Repeated cancel
is harmless. A different owner/workspace sees 404.

Terminal states: `succeeded`, `failed`, `cancelled`, `unknown`. `succeeded` means
the SDK operation returned a recorded result, not that a user command exited 0
or a code cell had no language error. Inspect `exit_code` and code `error`.
`unknown` means reconcile before deciding what to do; never generate a new
operation ID automatically to repeat the effect. An SDK timeout/error may occur
after an external effect. `sandbox_terminated: true` confirms execution stopped,
and does not prove that earlier effects did not happen.

Same ID and same canonical request returns the existing receipt (or 410 after
acknowledgement), including after restart. A changed request returns 409. IDs are unique across this adapter;
reuse by a different scope is hidden with 404. The service flushes a write-ahead
receipt before calling E2B. Restart changes unfinished `executing` receipts to
`unknown` and never resubmits them. Create writes opaque HMAC scope/create
metadata to E2B, then checkpoints its sandbox ID before initialization. Unknown
creates can be inspected with `sandbox.reconcile`; an empty result is not proof
that an eventually-consistent provider will never expose the allocation.

## Isolation and limits

All existing sandbox operations fetch provider metadata and verify deployment,
owner and workspace before proceeding. Execution requires the recorded network
policy: deny all egress, empty outbound allowance, public traffic disabled and
automatic resume disabled. No caller network policies, credentials, custom
templates, root user, E2B URLs or traffic/access tokens are returned. The SDK
connect API itself resumes paused VMs, so the adapter checks state first and only
allows explicit `sandbox.resume` for an observed paused VM. A provider state
transition between inspection and connect remains a provider-level race.

There are four active operations globally and one per owner/workspace, 64 HTTP
connections, 15-second HTTP body timeout and 8 KiB request headers. Commands/code
accept 64 KiB source, at most 120 seconds and 256 KiB combined output. Simple file
operations/individual transfer frames are at most 1 MiB; chunked files are at most
32 MiB. JSON bodies are at most 1,500,000 bytes. Receipts are at most
2,000,000 bytes each with configurable identity/logical-byte limits. Capacity exhaustion rejects new
work; it does not erase old idempotency records. A data directory is exclusive
to one live adapter process. This bounded local journal is not the canonical
CloudChat database. Plan an audited archival/reconciliation policy and Gateway
instance affinity or shared operation ownership before scaling horizontally.

Command output uses SDK `retainOutput:false` with bounded callbacks. Interpreter
execution uses a separate worker (128 MiB old/32 MiB young heap), bounds raw
response bytes before SDK NDJSON parsing, and bounds parsed logs/results. Each
code operation uses a new interpreter context with the workspace working
directory, then removes it; files survive and interpreter variables do not.
Artifacts larger than output limits must use bounded files/object storage.

The current SDK has no reliable external interpreter interruption API. Cancel,
timeout, excess output or broken execution transport therefore kills the whole
owned sandbox, including descendants, and records whether that was confirmed.
This discards its live environment and VM filesystem. Go must persist required
files to object storage before exposing them as durable deliverables. Failed
termination is `unknown`, and may leave a VM until its provider timeout/pause;
the caller must reconcile and explicitly kill. SIGTERM/SIGINT request remote
cancellation for active work before releasing the journal lock.

File transfer uses SDK commands running an encoded Python broker inside the VM,
not host paths. Payloads use SDK stdin in 32 KiB pieces and EOF, avoiding Linux's
single-argument limit even for a 1 MiB frame. Directory file descriptors, `O_NOFOLLOW`, regular-file and
hardlink checks prevent symlink/hardlink/FIFO escape and oversized reads. Writes
are atomic, descriptor-relative replacements. Paths are relative to
`/home/user/zeroagent-workspace`. Commands/code can access their whole VM;
this directory rule is a file-transfer boundary, not a second sandbox within E2B.

Chunk manifests bind opaque transfer ID, HMAC scope, owned sandbox, path, exact
size and SHA256. Sequential offsets advance with positional writes/fsync and an
atomic manifest; repeated identical bytes at already-written offsets return
progress, while overlap conflicts and out-of-order offsets reject. Finalize
rehashes before atomic destination replacement and can reconcile a crash after
rename. Manifest/staging symlinks and hardlinks are refused. There are at most
8 unfinished transfers and 128 manifests per VM; unfinished transfers expire
after one hour and remain inspectable/explicitly abortable. An explicit abort
does not remove a finalized destination. A VM's lifetime/pause retention is not
automatic staging cleanup: the Gateway owns explicit VM termination and must
reconcile unknown cleanup. This package never silently deletes completed files.

`file.parse` executes the packaged fixed script with Python isolated mode in the
VM, never a Gateway-host parser. The input hash is checked before parsing and
the <=2 MiB output JSON binds the same scope/sandbox/source hash. The result has
`segments: [{id,locator,text}]`, `truncated`, and warnings; locators are PDF page,
DOCX body paragraph, XLSX sheet/cell, or PPTX slide/paragraph. Output is a VM file;
the small receipt gives path/bytes/SHA256/segment_count for verified chunked
retrieval. No XML external relationships, embedded code, formulas or macros run.
Scanned PDFs require a later OCR capability and are reported as lacking text.
Text extraction is not exact layout, image or table reconstruction.

Template provisioning must install `sandbox/requirements.txt` using
`python3 -m pip install --require-hashes -r requirements.txt` at image build time.
Its pypdf 6.21.4/defusedxml 0.7.1 wheel hashes were checked against official PyPI.
Execution does not install dependencies or enable outbound network. Parser
limits: 512 MiB virtual memory, 30 CPU seconds/45 wall seconds, 64 descriptors,
32 MiB original, 2,048 ZIP entries, 8 MiB per expanded part, 64 MiB total expanded,
100:1 compression ratio, 128 XML depth/200,000 nodes, 200 PDF/PPTX pages, 64
worksheets/100,000 cells, 10,000 paragraphs, 1 MiB extracted text, 5,000 segments,
2 MiB JSON. Hitting text/segment limits explicitly marks partial output; structural
limits reject. The adapter enforces a separate 60-second remote command timeout.

## ZIP code uploads

`archive.extract` accepts only `{path,destination,source_sha256}` with the owned
`sandbox_id` and scope on the operation. The Gateway derives the digest through
`InspectFile` or a verified upload; model arguments cannot choose owner, sandbox,
hash or extraction limits. The fixed `sandbox/archive_extract.py` script reads a
regular, single-link `O_NOFOLLOW` source FD into a bounded snapshot, rechecks its
SHA256, and extracts data inside the VM. It never imports or executes ZIP code
and never recursively expands a nested archive. There is no Gateway-host unzip.

The destination parent must already exist; the destination itself must be fresh.
Entries are validated before writing a private sibling staging directory. Files
are newly created 0600 and directories 0700; source UID/mode/link attributes are
not applied. Final publication requires Linux `renameat2(RENAME_NOREPLACE)` and
refuses even an existing empty directory. Supported methods are stored/deflate.
Absolute paths, `..`/`.`/empty components, backslashes, colons (including Windows
drive/ADS paths), NUL/control characters, non-NFC names, duplicate paths,
file/directory collisions, encryption, links/devices/special files and unsupported
extra metadata reject the whole archive. No `extractall` call is used.

Fixed limits: 32 MiB ZIP, 128 total entries including directory entries, 8 MiB
per file, 32 MiB total expanded, 100:1 per-entry and aggregate ratio, 32 path
components, 1024 UTF-8 bytes per full path, 64 KiB cumulative path bytes, 512 MiB
address space, 15 CPU seconds, 30 wall seconds, 64 FDs and 192 KiB receipt output.
The SDK command deadline is 35 seconds and cancellation terminates the owned VM,
including children. The result is
`{sandbox_id,source_sha256,destination,files:[{path,size,sha256}],file_count,total_bytes}`;
file paths are complete workspace-relative paths under `destination`. The SDK
manifest is complete or the operation fails; a model-facing tool may separately
summarize its display while retaining this private complete receipt.

Known extraction errors clean only the fresh staging directory using directory
FDs without following links; no existing destination/source is deleted. Cleanup
failure is `archive_cleanup_unknown`, not a claimed rollback. Process death,
command stream loss, or a result lost after publication remains unknown; inspect
the original durable operation ID and terminate/reconcile its owned VM. Do not
retry under a new ID or infer that a destination is safe to reuse. Staging left
by process death is confined to that VM's explicit lifecycle.

`test/archive-fixture.py` creates its own synthetic `code-task.zip` and hostile
fixtures (traversal, Windows paths, symlink/hardlink/device, duplicate, collision,
encrypted, bomb, CRC failure, boundaries and cleanup). `node --test
test/archive.test.ts` runs this against real Linux Python (WSL on Windows), with
SDK boundary/receipt behavior covered by the adapter/service tests. This is
offline local validation, never evidence of a real E2B allocation or remote kill.

## Validation and remaining acceptance

`pnpm test` tests the HTTP protocol, journal restart/idempotency, strong token and
owner isolation, limits, cancellation, SDK option/ownership/termination boundaries
using injected adapters/SDK stubs. Raw interpreter wire limits are tested before
parsing. A real local Linux Python test (WSL Ubuntu on Windows) verifies the file
broker against symlinks, hardlinks, FIFOs and oversized files; it is explicitly
skipped if no Linux Python runtime is available. Parser fixtures additionally need
the exact pinned dependencies in that Linux runtime; a dedicated test dependency
directory can be passed with `ZEROAGENT_PARSER_TEST_DEPS_DIR` (Linux path). They
cover real generated PDF/OOXML, locators, ZIP/XXE/page limits and partial output.
These are not real E2B tests.

`sandbox.reconcile` reports only exact HMAC-scoped original-allocation matches
and marks them `cleanup_only:true`. Network/version drift does not hide these
identities from cleanup; observations report actual policy rather than asserting
that an unsafe VM is isolated. Gateway may terminate these candidates, never
resume or execute from a reconciliation result. Every execution still checks
current ownership, network policy and the provider's compatible envd version.

No real E2B credentials, allocation, network policy, pause/resume, code-interpreter
template compatibility, provider billing or live remote-kill behavior has been
accepted. A paid smoke test requires explicit authorization and a dedicated test
key/template, allocation budget and cleanup. Production release additionally
requires deployment service account/ACLs, secret distribution, operational
retention/monitoring, and real provider tests. Gateway authorization, bounded
allocation, reconciliation and durable results are integrated and covered by
isolated Go/HTTP/PostgreSQL tests; they are not evidence of remote E2B execution.

Official SDK/network contracts checked for this implementation:
[internet access](https://docs.e2b.dev/network/internet-access),
[SDK source](https://github.com/e2b-dev/E2B/tree/main/packages/js-sdk),
[code interpreter source](https://github.com/e2b-dev/code-interpreter/tree/main/js).
Installed fixed-version declarations/source were inspected for command kill,
retained output, interpreter timeouts, lifecycle and connection retry behavior.
