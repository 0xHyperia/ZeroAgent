# Restore conditional-write acceptance, 2026-10-29

The backup client now verifies conditional writes before admitting a restore.
The actual Garage result is **unsupported and safely refused**, not a successful
real-Garage backup/restore certification. No vendor was changed, no ordinary PUT
fallback was introduced, and no paid/cloud API was called.

## Original incompatibility retained

The initial ignored Go overlay used the production `cloudbackup.NewS3` and
`PutIfAbsent` against official Garage v2.5.0 image
`sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5`.
Its first 34-byte object and metadata verified, but the conflicting write returned
nil instead of `ErrTargetNotEmpty`, so the test correctly failed immediately.
The post-conflict object was not inspected in that original test; do not infer
its later contents or claim that its restart phase ran.

Original evidence: `.codex-artifacts/garage-s3-5152bfa341c64c3c/` and
`.codex-artifacts/cloudchat-backup-conditional-garage-20261029/result.json`.

## Guard and local protocol verification

`ConditionalObjects` has a mandatory `CheckRestoreWriteSemantics(ctx)` method.
Restore invokes it after authorized local/empty-target checks and before
`pg_restore`, authentication invalidation or any formal object/journal/config
write, including for candidates with zero objects. Standalone `PutIfAbsent`
uses the same gate. New clients, backup creation and read-only verification do
not themselves mutate storage with a probe.

A correctly implementing local S3 protocol peer passes, permits one formal
conditional write, and leaves no canary. Other focused tests cover ignored
headers, a false 412 response after overwrite, unknown write replies, foreign
nonce/bytes, failed or falsely acknowledged deletion, pre-existing probe key,
leader/waiter cancellation and concurrent singleflight. Failure is sticky per
client, with unsupported and unconfirmed as distinct states. A failure code
never substitutes for checking its independent cleanup fields.

Actual Linux PostgreSQL 18.6, Redis 8.2.10 and Node 24.14.1 tests passed with no
skipped tests. Both one-object and zero-object candidates were refused for an
unsupported or unconfirmed S3 peer while the target database stayed empty,
the authentication canary remained byte-for-byte unchanged, formal PUT count
stayed zero and no journal/config was created. The previous full recovery drill
also passed using its compatible local S3 protocol peer. This is not a claim
that its positive S3 peer was Garage.

Evidence: `.codex-artifacts/cloudchat-backup-conditional-guard-20261029/`
contains the complete Linux log, before/after source hashes and result.
The temporary infrastructure was stopped by verified process handles after
checking idle clients; prior PG data was preserved and the four original Redis
files retained their hashes. See
`.codex-artifacts/cloudchat-backup-probe-infra-20261029/final-cleanup-evidence.json`.

## Real Garage safe-refusal verification

A separate ignored overlay reused the existing task-labelled internal-network
Garage runner, without changing the frozen integration-test source or rerunning
the 32 MiB scenario. A test-only direct socket Write seam counted only PUT and
`If-None-Match:*` headers, kept the actual signed Host, and recorded no
Authorization or raw URL/header values.

Before and after an actual process restart:

- Both canary PUTs carried the required header: 2 PUTs, 2 `*` headers.
- Garage accepted the conflicting canary replacement. Its exact known bytes,
  SHA, MIME and private nonce metadata were observed before owned cleanup.
- The gate returned `ErrConditionalWritesUnsupported`; its cleanup separately
  confirmed DELETE followed by HEAD-not-found.
- A direct formal `PutIfAbsent` returned that same sticky failure, made zero
  formal PUT requests and left the formal key absent. No new probe was retried.

This closes the SDK-header ambiguity and proves safe client refusal. It does
not make Garage's conditional-write behavior conformant. It is also not an
end-to-end real Garage database/object/journal recovery run; real-PG preflight
ordering and real-Garage provider refusal are the distinct checks above.

Evidence: `.codex-artifacts/garage-s3-0c9dd03f80d740ea/{prepare,verify}.json` and
`.codex-artifacts/cloudchat-backup-conditional-guard-garage-20261029/`.
The runner's generic `passed` means this safe-refusal overlay passed;
`provider_conditional_write_support` is explicitly false. Exact task-label
checks confirmed container, volume and network cleanup; synthetic credentials
were retired. Unknown or unowned real probe objects would instead be retained
with a precise key and cleanup diagnostic, never blindly deleted.

The Gateway runtime does not import `internal/cloudbackup` (`go list -deps
./cmd/gateway` checked). This change requires a new independent backup CLI build;
it does not by itself change the already verified Gateway runtime image. Source
observation hashes naturally differ for the backup CLI/package/test files.
