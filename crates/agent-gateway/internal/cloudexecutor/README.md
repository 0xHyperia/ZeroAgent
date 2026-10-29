# Cloud executor client

This package speaks the authenticated protocol in
`crates/cloud-executor/README.md`. It is an SDK-adapter client, not an Agent loop
or user authorization layer. The caller must authorize each owner/workspace,
check approvals/budgets, persist the stable tool operation ID and reserve a
workspace before calling it.

```go
client, err := cloudexecutor.New(cloudexecutor.Config{
    BaseURL: "http://127.0.0.1:17843",
    Token: internalServiceSecret,
})
// Handle err; close idle connections during Gateway shutdown.
receipt, err := client.Execute(ctx, cloudexecutor.Operation{
    OperationID: stableToolOperationID,
    OwnerScope: authorizedAccountID,
    WorkspaceRef: authorizedWorkspaceID,
    Action: "command.run",
    SandboxID: ownedSandboxID,
    Input: map[string]any{"command": "python3 analysis.py", "timeout_ms": 60000},
})
```

`Health`, `Submit`, `Get`, and `Cancel` expose the separate protocol operations.
`Execute` submits once and polls the original ID. Canceling its context sends an
explicit cancellation with a fresh, bounded cleanup context, then polls for a
terminal receipt. It does not merely abort a streaming HTTP request. If cancel
or status cannot be confirmed, it returns the last receipt marked `unknown` and
`*UnknownOutcomeError`; reconcile the original ID instead of submitting a new
one. A response lost after submission is handled the same way. API errors are
sanitized, and definitive 4xx rejection is not retried or canceled.

Recorded `failed` and `cancelled` receipts return nil transport error. Inspect
`receipt.State`, command `exit_code`, code execution `error`, and
`sandbox_terminated`. `unknown` always returns `UnknownOutcomeError`. Confirmed
VM termination proves execution stopped; it does not roll back earlier effects.

The client requires literal loopback IP, explicit port and a strong internal
token. It disables environment proxies, redirects, cookies and automatic POST
retries. Body/header sizes, request duration, polling and cleanup are bounded.
Tokens never appear in errors and exact token reflection is removed from JSON.

`NewTransferID`, `Upload`, `Download`, and `AbortUpload` implement <=32 MiB files
with <=1 MiB frames. Persist `TransferSpec` (scope, sandbox, opaque transfer ID,
path, byte count, digest) before use. Upload hashes the provided byte reader,
uses deterministic per-step operation IDs, and finalizes only after server-side
digest verification. Download checks frame offsets, size and complete digest;
publish its temporary destination only on success. Unknown stops immediately.
`AbortUpload` is explicit and never deletes a completed destination.

`Parse(ctx, ParseSpec)` invokes the isolated VM extractor and validates its small
receipt (`ParseResult`); get its JSON using a Download spec with the returned
path/size/SHA. Output is <=2 MiB, has opaque scope binding and locatable segments.
No real E2B credentials or paid calls are part of `go test`: tests use real local
HTTP protocol fixtures and explicitly do not constitute E2B acceptance.
`Client.ExtractArchive(ctx, ArchiveExtractSpec)` performs the scoped
`archive.extract` operation using the caller's stable `OperationID`, `Path`,
fresh `Destination`, and `SourceSHA256`. Derive the source SHA using `InspectFile`
or the verified load result, never a model-provided digest. The helper honors
`WithOperationRunner`, returns the original receipt on known/unknown failures,
and verifies sandbox/destination/source hash plus the complete bounded manifest.
It does not unzip on the host or automatically allocate, replay, acknowledge, or
clean up a VM. Guest limits are 128 entries/32 MiB expanded/8 MiB per file; paths
in `ArchiveExtractResult.Files` are full workspace-relative paths under the new
destination. Callers may present a bounded summary to the model while retaining
the complete receipt in their durable private tool facts.
