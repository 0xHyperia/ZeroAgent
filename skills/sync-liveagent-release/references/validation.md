# Release integration validation

Treat this as required coverage, selecting current repository commands after inspecting their actual
scope. Record unavailable checks with their cause; never replace a broad requirement with a narrow test.
Do not run commands that publish, tag, push, or deploy merely because a Make target includes them.

## Source and governance

- Verify GitHub published release, prerelease policy, peeled SHA, and local ref using `verify-release.mjs`.
- Verify old baseline ancestry, real target merge parent, no unresolved index entries/conflict markers,
  complete substantive-change classification, and ownership coverage.
- Run `node scripts/check-zeroagent-product-contract.mjs` and `git diff --check`.
- Review feature entrypoints/test paths against real new behavior, not just string presence.

## Application checks

- Frozen pnpm installation. GUI, WebUI, shared UI, and vendored virtual-core typechecks, relevant lint,
  full frontend suites, production builds, and UI boundary checks.
- Regenerate Gateway Go/TS and native Proto outputs; verify no stale generated changes after rerunning.
  Run protocol lint/breaking checks with the product compatibility baseline where supported.
- Gateway `go test ./...`, `go test -race ./...`, applicable lint/vet. Verify actual account isolation,
  OAuth callbacks/state, device leases, presence expiry/revoke, uploads and new image delegation.
- Tauri `cargo check --locked --tests`, formatting and applicable library tests on supported desktop
  platforms. Native process, terminal, sandbox, keychain, and signing behavior need platform evidence.
- Run deployment validation without changing production, image build/smoke and readiness dependency
  checks in an available environment. Preserve immutable digest deployment and dual-repository artifacts.

## v2 behavior and migration

- Exact locked K-brain and Computer binaries match per-platform digests; signed app includes them and
  the Gateway sidecar. Test startup failure, health/protocol mismatch, restart/port rotation, exit and
  update shutdown, cancellation, and child cleanup. Keep Android free of desktop-only executables.
- Model-to-tool run with a real locked backend and controlled provider fixture, then actual USA-Zero
  integration when authorized credentials are available. Cover supported provider protocols, managed
  model permissions, rotation, expired credentials, and protected key reveal/export paths.
- No duplicate execution after lost start ACK. SSE cursor resumes, stop-before-ACK, queued messages,
  busy command rejection, draft recovery and account/target switches use correct ownership.
- Migration fixtures include large/multisegment history, tools, images/files, branches, checkpoint,
  workspace routes, provider mapping, prompts, memory and automation. Verify repeated import, interruption,
  deterministic failures, failed item visibility, original preservation, and profile isolation.
- Validate rollback on copied test data. Verify how v2-created data survives or is exported during rollback;
  do not claim old-version readers support it without testing.
- Desktop works locally without the control WebUI; device WebUI routes through authenticated leases;
  Cloud Chat cannot execute local tools; Android OAuth/secure storage/update remain usable.
- Check desktop, narrow Pane and mobile layouts, history scrolling, settings/Provider/device navigation,
  context use, error recovery and release announcements. Use screenshots when validating rendered UI.

Historical upstream test counts do not validate ZeroAgent's adapted implementation. Keep pending native,
real-model, signing and production acceptance separate from verified source/unit/integration results.
