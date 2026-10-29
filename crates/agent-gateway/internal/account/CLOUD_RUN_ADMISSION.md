# Account admission and fair Run scheduling

Initial defaults are one executing Run and twenty queued Runs per account.
These are conservative starting limits, not measured production capacity.
Calibrate them with queue age, per-account completion/claim latency, model/tool
latency, worker saturation, cancellation and database lock metrics before raising
them. Supported operator ranges are execution 1–8 and queued 1–200.

Only queued rows consume queue capacity. All running and cancelling rows consume
execution capacity, including expired leases until durable interruption commits.
The existing recovery worker fences expired Runs before claiming new work; it
never replays a lost worker's unknown external effects. Cancellation of queued
work frees a queue slot immediately, while running cancellation frees execution
only at its terminal commit. Lowering limits leaves existing work intact and
blocks new admission/claims until counts fit again.

`CloudRunAdmissionStore.ConfigureCloudRunAdmission(ctx, limits)` is an explicit
operator configuration path. PostgreSQL persists one policy shared by all
replicas, its initial defaults and revision history. Configuration transactions
lock this row; acceptance/claim transactions hold a shared lock, so changes do
not mix limits within an in-flight transaction. Startup without explicit
admission settings must preserve the database policy. Browser/model requests
cannot select limits. MemoryStore keeps the same policy and algorithm for local
testing, without cross-process persistence.
The optional operator environment settings are
`ZEROAGENT_CLOUD_ACCOUNT_MAX_EXECUTING` and
`ZEROAGENT_CLOUD_ACCOUNT_MAX_QUEUED`. Explicit settings apply a complete policy
snapshot at runtime startup; replicas should share one intended deployment
configuration. Omitted settings do not reset an existing database policy.

Create serializes the request key, then the account scheduling row, then the
conversation. It resolves accepted request replays before checking capacity.
Same ID/body returns the original Run without a new history write; conflicting
reuse stays a conflict. A full account queue rejects with
`ErrCloudRunQueueFull`, HTTP 429 and `reason:account_queue_full` before creating
any Run, event or user message. There is no guessed Retry-After time. Clients may
retain the original ID/body and let the user explicitly retry after waiting or
cancelling existing work. Other 429 responses do not prove non-acceptance.

Each account has a durable `last_claim_order`, advanced from a PostgreSQL
sequence only in the transaction that successfully starts a Run. Eligible
accounts are ordered least recently served, then oldest queued request, then
account ID. Within the selected account, requests remain FIFO by creation time
and ID. New accounts that have never received a turn get an initial turn; a
single account's older backlog cannot indefinitely precede another account.
This provides turn fairness, not a promise of equal execution duration or a
fixed response-time SLA.

PostgreSQL claims lock the account row with `FOR UPDATE SKIP LOCKED`, recheck the
execution count in a fresh statement, then lock conversation and Run in the
established order. Concurrent workers cannot both bypass the per-account cap.
Unrelated accounts do not share one global dispatch mutex. Busy conversation
locks or a concurrent committed claim can cause an empty poll; the runtime
retries its bounded polling loop rather than spinning or holding a global lock.
The account order and policy survive process restarts; rolled-back sequence gaps
are harmless. Counts are derived from canonical Run states, so deletes,
cancellation and lease recovery cannot leave a stale cached semaphore counter.

Memory and real isolated PostgreSQL tests cover concurrent queue admission,
request replay while full, sixteen simultaneous claimers across two accounts,
turn rotation ahead of older backlog, policy changes across store instances,
cancellation, crash/lease interruption, and HTTP rejection with a subsequent
explicit same-request retry. Tests use synthetic accounts and isolated schemas;
they do not establish production throughput or call paid model/E2B services.
