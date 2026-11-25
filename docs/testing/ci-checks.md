# CI performance and code-rule checks

Run these checks locally to inspect bundle health, performance and code hygiene.
The JSON files under `scripts/budgets/` contain the reference values. The
bundle baselines come from ZeroAgent production builds. GUI and WebUI CI each
run both browser engines and enforce the corresponding bundle budget. GUI CI
also runs the calibrated transcript micro-benchmarks. Source file size,
design tokens and knip retain their local checks while the product baselines
are reconciled.

| Check | Local command |
| --- | --- |
| Production bundle smoke in Chromium and WebKit | `pnpm smoke:bundle --app gui\|webui --browser all` |
| Bundle size | `pnpm check:bundle-size` |
| Source file size | `pnpm check:file-size` |
| Design tokens | `pnpm check:design-tokens` |
| Unused code (knip) | `pnpm check:knip` |
| Micro-benchmarks | `pnpm check:perf-micro` |
| Transcript browser scenarios | `pnpm perf:scenarios` |

The Transcript Performance workflow also runs on demand and reports the browser
measurements in the job summary.

## Linux native startup

The native CI job builds a debug Tauri application with the production GUI
assets and reviewed K-brain binaries built from source. It launches the
application through `tauri-driver` and `WebKitWebDriver` under Xvfb. The
signed-out check uses a temporary home, an isolated D-Bus session and platform
vault, and a loopback account origin. It checks the visible account form and
verifies that the app requested public settings from the fixture. The test
requires neither account credentials nor a model key.

## Bundle smoke

`scripts/smoke-frontend-bundle.mjs` serves a production `dist/` over loopback,
boots it in a real browser engine, then imports every emitted chunk. It fails
on uncaught page errors, error boundaries and console errors. This catches
release-only chunking bugs (CommonJS interop, ESM cycles) that `vite dev`
never shows.

- `--app gui` boots the desktop frontend against a fake K-brain endpoint.
- `--app webui` boots the Gateway WebUI. Its same-origin API answers 401, so
  the run waits for the login screen. The lazy chat and workbench chunks are
  still evaluated by the import pass.

Run it locally:

```sh
pnpm --filter zeroagent exec vite build            # or pnpm build:gui (adds typecheck)
pnpm --filter @liveagent/gateway-webui exec vite build
# Playwright is not a workspace dependency; install it outside the repo:
PW=$(mktemp -d)
mkdir -p "$PW" && echo '{"private":true}' > "$PW/package.json"
npm i --no-save --prefix "$PW" playwright-core@1.64.1
node "$PW/node_modules/playwright-core/cli.js" install chromium webkit
export PLAYWRIGHT_CORE=$PW/node_modules/playwright-core/index.mjs
pnpm smoke:bundle --app gui --browser all
pnpm smoke:bundle --app webui --browser all
```

The Transcript Performance workflow uses `.github/actions/setup-playwright`
to install the pinned `playwright-core` version in `$RUNNER_TEMP`. To update
Playwright, change the action's `version` default.

## Bundle size budget

`scripts/check-bundle-size.mjs` measures each app's `dist/` and compares it
with `scripts/budgets/bundle-size.json`. The measured values are:

- **Startup JS:** the entry chunk from `index.html` plus every chunk it
  imports statically, transitively, both raw and gzip. This is what the
  browser must fetch and evaluate before the first render.
- **Startup CSS** (gzip).
- **Total dist size.** The desktop total includes its independently mounted
  remote-device workbench, workers and bundled preview assets. The WebUI total
  includes its own workers and preview assets.

These fail when they exceed the budget by more than `tolerance` (3%). The
startup file count and total JS are informational only. The table goes to
stdout and the job summary.

```sh
pnpm build:gui && pnpm build:webui
pnpm check:bundle-size                 # both apps; --app gui|webui for one
pnpm check:bundle-size --update        # rewrite the budget from this build
```

When it fails, first check whether a new static import pulled a heavy module
into startup. A dynamic `import()` usually fixes that. If the growth is
intended, run `--update` after a production build and commit
`scripts/budgets/bundle-size.json` with a note on why. Metrics that drop well
below budget are shown as "under budget, consider --update". Lowering the
budget locks in the gain.

## Source file size limit

`scripts/check-file-size.mjs` checks every tracked `.ts`, `.tsx`, `.rs` and
`.go` file under `crates/` against a 1500-line limit. Generated files are
exempt: `*.pb.go`, `proto/gen/`, `*.generated.ts`, `*.d.ts`.

Files that were already over the limit are listed in
`scripts/budgets/file-size-allowlist.json` with their line count. A listed
file must not grow. The list only shrinks:

- A new file over the limit fails. Split it into focused modules.
- A listed file that grows past its recorded count fails.
- A listed file that got shorter, dropped under the limit or was deleted
  fails too, asking you to lock in the gain.

```sh
pnpm check:file-size
pnpm check:file-size --update   # lowers counts / drops entries; never adds or raises
```

Adding an entry or raising a count is a manual edit of the allowlist and needs
a justification in review.

## Design tokens

`scripts/check-design-tokens.mjs` scans tracked `.ts`, `.tsx` and `.css` files
under `crates/agent-ui/src`, `crates/agent-gui/src` and
`crates/agent-gateway/web/src` for styles that bypass the design tokens: color
literals, raw Tailwind palette colors, arbitrary color values and arbitrary
font size, radius, shadow, z-index or spacing values. Tests, `.d.ts`,
generated files, the token files themselves and the brand logos are exempt;
comments are ignored. The tokens and primitives to use instead are listed in
[../design-system.md](../design-system.md).

Files that already had such styles are recorded per rule in
`scripts/budgets/design-token-baseline.json`. It works like the file size
allowlist:

- A new file with a hard-coded style fails.
- A listed file whose count for a rule grows fails.
- A listed file that got cleaner fails too, asking you to lock in the gain.

```sh
pnpm check:design-tokens
pnpm check:design-tokens --update   # lowers counts / drops entries; never adds or raises
```

## Unused code (knip)

`knip.config.ts` configures [knip](https://knip.dev) for the pnpm workspace.
Some references are invisible to the import graph, and the config handles
them as follows:

- Tests load TypeScript sources by path string
  (`const { a } = loader.loadModule("src/lib/...")`). A knip compiler for
  `.mjs` files (`scripts/knip-loader-imports.mjs`) appends the equivalent
  `import { a } from ".../src/lib/..."` to each test, so only the exports a
  test actually reads count as used. When it cannot tell (the module object
  is passed around or spread), every export of that module counts as used.
  Other path strings in tests, such as source assertions through
  `readFileSync`, make the file an entry. Keys of a loader's `mocks` map do
  not, since a mock replaces the module.
- Shared UI code imports `@liveagent/app/*` and `@liveagent/adapters/*`.
  tsconfig resolves these to the desktop app, while the WebUI's Vite config
  points them at its own `src/`. The WebUI targets are listed as entries.
- `@liveagent/ui` exports `./*`, which would make every shared UI file a
  public entry whose exports are never reported. The package is internal,
  so the config sets `includeEntryExports` for it.
- Generated protobuf bindings (`proto/gen/`) are ignored.

`scripts/check-knip.mjs` runs knip and compares the findings with
`scripts/budgets/knip-baseline.json`. Findings are keyed by type, file and
name, not line, so unrelated edits do not churn the baseline. Only findings
that are not in the baseline fail. Baselined findings that disappeared are
listed so they can be dropped.

```sh
pnpm check:knip
pnpm check:knip --update     # rewrite the baseline from the current findings
pnpm exec knip               # knip's own full report
```

When it flags something new, delete the unused file, export or dependency, or
stop exporting what is only used locally. If knip is wrong because the code is
loaded dynamically, by a test through a path string, by Tauri, or by the e2e or
perf harness, teach `knip.config.ts` about that entry point rather than
baselining it. Use `--update` only to accept findings deliberately, and say so
in the commit.

## Micro-benchmark gate

`scripts/check-perf-micro.mjs` runs the node benchmarks in
`crates/agent-gui/perf`:

- `sse-bench`: SSE record splitting.
- `projection-bench`: transcript projection.
- `store-bench`: WebUI transcript store.
- `lru-bench`: measurement LRU.

CI timings are noisy, and they differ by engine and memory bandwidth in ways
a CPU calibration does not capture. The first CI run (Node 22, ubuntu)
measured the SSE split about 4× slower, after normalization, than the Node 26
machine that recorded the baseline. So the gate does not rest on wall-clock
thresholds:

- **Scaling ratios are the primary gate.** They have fixed limits, need no
  baseline, and are the same on any machine or engine. They catch the
  regressions that matter, which is work that grows quadratically with event
  or conversation size.

  | Ratio | Linear work | Limit | Quadratic regression |
  | --- | --- | --- | --- |
  | SSE split, 16 MB / 2 MB event | 5-13 (idle or all cores busy) | 30 | ~115 (re-join per chunk) |
  | Store event, 2000 / 200 turns | 0.8-1.8 | 5 | ~11 (copy every turn per event) |
  | Re-projection / fresh projection | 0.03-0.08 | 0.5 | - |

  The SSE sizes stay small on purpose. Past about 16 MB, the cost per MB
  itself rises when the machine is busy: 32 MB / 8 MB went from 7 to 12 with
  every core loaded.
- **Every benchmark runs in 5 fresh processes**, and the gate uses the
  median. For the SSE split it is the median of each process's fastest run,
  because interference only adds time and hits the longer run more.
- **Timings are only a backstop against gross slowdowns.** They are
  normalized by a calibration workload measured in the same job, and fail
  only beyond `max(baseline × factor, baseline + floor)`. The factor is 10×
  for the SSE split and 5-6× for the rest, compared with the up to 4× seen
  on CI.
- **Deterministic outputs** (persisted snapshot bytes) are compared with
  `scripts/budgets/perf-micro-baseline.json` within a 5% tolerance.

```sh
pnpm check:perf-micro
pnpm check:perf-micro --update   # rewrite the baseline from this machine
```

If it fails, re-run it locally and profile the benchmark it names. A failed
ratio means the work stopped being linear, which is a real regression on any
machine. If a slowdown is intended, update the baseline and explain it in the
commit. Only the backstop timings and the snapshot size come from the
baseline, so it can be recorded on any machine.

## Transcript browser scenarios (report only)

`crates/agent-gui/perf/run.mjs` drives the transcript harness in headless
Chromium. The scenarios cover streaming, find, scroll, edit and git diffs, and
projection. Select a profile when dispatching `.github/workflows/perf.yml`.

- **quick** uses 1× CPU and a 6k-character stream.
- **full** uses 1× and 4× CPU and the default 24k-character stream.

`scripts/report-perf-scenarios.mjs` writes a table to the job summary,
compared with the newest results of the same profile saved by a main run (an
`actions/cache` entry). Changes that are more than 25% and more than 5 units
slower get a :warning:. The job never fails on the numbers, and a failed run
only produces a note. Raw results are uploaded as the
`perf-scenarios-<profile>-<run>` artifact.

```sh
# Chromium from a Playwright install, or any Chrome build:
CHROME_PATH=/path/to/chrome pnpm perf:scenarios --scenarios=stream,find --throttle=1 --chars=6000 --out=results.json
node scripts/report-perf-scenarios.mjs --current results.json [--baseline main-results.json]
```

## Tests for the checks

The comparison logic of all of the above is covered by
`scripts/check-code-rules.test.mjs`, which is part of
`pnpm check:script-tests`.
