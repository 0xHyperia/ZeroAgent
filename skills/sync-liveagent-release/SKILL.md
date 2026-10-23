---
name: sync-liveagent-release
description: Evaluate and synchronize published Stack-Cairn/LiveAgent releases into ZeroAgent, adapting upstream architecture while preserving product contracts, migration safety, platform support, and Git ancestry.
---

# Sync a LiveAgent Release into ZeroAgent

Use this workflow for release assessment, local integration, conflict resolution, and validation. A request
to synchronize authorizes local integration work; pushing, merging a remote PR, tagging, publishing, and
deployment require authorization for those actions. Preserve authorization already given in the session.

## Establish the product and source boundaries

Read the repository's `AGENTS.md`, then its ordered prerequisites: product contract, feature catalog,
ownership rules, applicable ADRs, current upstream-sync metadata, and applicable sync reports. Prefer the
current product outcomes over obsolete local implementation. Never drop a feature just to resolve a
conflict or make a test pass. Record a product decision before changing an invariant.

Pin the exact published GitHub Release and its peeled commit. Do not integrate `upstream/main` or
silently replace the user's target with a newer release. A draft or unpublished tag is not a release.
A published prerelease may be assessed; integrate it only when the user selected that prerelease or
otherwise authorized preview integration. Keep preview status explicit in metadata and update channels.

Fetch into a separate namespace so upstream tags do not become ZeroAgent product tags:

```powershell
git fetch --no-tags https://github.com/Stack-Cairn/LiveAgent.git refs/tags/vX.Y.Z:refs/upstream/releases/vX.Y.Z
node skills/sync-liveagent-release/scripts/verify-release.mjs --repo . --tag vX.Y.Z
```

For an authorized preview, add `--allow-prerelease`. The verifier compares GitHub's release/tag object
with the local peeled ref. It does not fetch, modify files, or prove application compatibility.

## Integrate with evidence

1. Inspect local changes and existing worktrees. Preserve user work; create an isolated integration
   branch/worktree when a large merge would disrupt the existing checkout. Use the `codex/` prefix.
2. Confirm the recorded upstream commit is an ancestor of the product baseline and the target release.
   Record the actual merge base, both pinned SHAs, changed paths, and `git merge-tree` conflict paths.
3. Inventory substantive changes, including changes that merge without conflict. Use ownership rules to
   identify direct and indirect product impacts. Classify every substantive change as `adopt`, `adapt`,
   `replace`, `partial`, `reject`, or `defer` in `docs/upstream/<tag>.md`. Do not mark pending evidence complete.
4. Perform a real Git merge with the exact pinned release as a parent. Resolve semantic boundaries
   before regenerating Proto and dependency locks. Do not substitute a squash or a cherry-pick-only
   history. Keep local checkpoints reviewable; do not claim a conflicted merge is validated.
5. Adapt the new upstream implementation to ZeroAgent's contracts. Prefer shared upstream code and
   narrow adapters over retaining a parallel legacy runtime. Remove old code after its replacement has
   evidence for the same outcomes. Follow existing ADRs; write migration/security/platform decisions
   when the implementation boundary changes.
6. Update `features.yaml`, ownership rules, sync metadata, and contract checks to describe the actual new
   entrypoints and tests. Keep behavioral guarantees; do not delete checks merely because paths changed.

## ZeroAgent boundaries that need semantic review

- USA-Zero OAuth is the account boundary. Preserve account-scoped devices, history, files, workspaces,
  leases, presence expiry, and revocation. An execution backend token is not an OAuth/device credential.
- Cloud Chat cannot gain desktop tools. Device execution requires explicit authenticated selection.
  Android remains a supported WebUI shell with platform secure storage and its own update flow.
- Managed Provider keys remain masked; reveal/copy needs recent USA-Zero secondary authentication.
  Enforce this below the UI, including new secret, export, backup, import, and provider-edit endpoints.
- Backend data roots, caches, migrations, subscriptions, queues, and assets need stable account/profile
  scope. Preserve installation identity across sign-in changes. Do not import another product's data by default.
- Preserve ZeroAgent branding, application ID, managed Provider navigation, release signing/update
  identity, dual-repository distribution, immutable Gateway image deployment, and dependency readiness.

For v2, additionally trace sidecar ownership, pinned K-brain/Computer artifacts, HTTP/SSE recovery,
ACK idempotency, provider configuration, canonical history, and local Gateway coexistence. Keep model
execution in the new backend; adapters must not recreate a second frontend Agent loop.

## Validate and report

Read [references/validation.md](references/validation.md) before declaring integration validated. Run
checks appropriate to each changed domain and the complete required matrix before proposing completion.
Distinguish tests run locally, tests run in another environment, historical upstream results, and pending
native/credential-dependent acceptance. Environment failures are not passes; continue other useful work.

Record exact commands, result counts where meaningful, limitations, migration and rollback evidence,
unresolved decisions, and the final parent SHAs in the sync report. Update upstream-sync metadata only
when the source is actually in the integration history. A successful local merge does not authorize an
external release. Keep the goal active while required functionality or verification remains incomplete.
