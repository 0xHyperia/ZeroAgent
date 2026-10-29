# CloudChat E2B template candidate

The current candidate extends the official public interpreter **immutable build** `nlhz8vlwyupq845jsdg9:696af675-2a44-45ce-a889-7e09c65eb749`. Default `plan`/`check` serializes the installed SDK and reads local files with zero API calls. Remote build/allocation remains an explicit, approved operation; no candidate is silently configured for production.

## Base identity and inventory

`base.lock.json` format 2 records the exact template ID and ready build UUID returned by the official public `code-interpreter-v1` metadata on 2026-10-29 (envd metadata 0.10.0, 2 vCPU/2048 MiB). The spec uses `fromTemplate` with **ID:build UUID**, not the moving alias. The [official tag documentation](https://docs.e2b.dev/template/tags) describes specific build selectors. The [official runtime resolver at fixed commit b9941e251c126641bd2dd5b7c15099dc5c00a898](https://github.com/e2b-dev/runtime/tree/b9941e251c126641bd2dd5b7c15099dc5c00a898) resolves `fromTemplate` through the same ID/tag parser and ready-build query, accepting an exact build UUID and passing its resolved BuildID to the builder; UUID-shaped ordinary tag creation is rejected. The [custom interpreter guide](https://docs.e2b.dev/code-interpreting/customize-template) documents extending the official interpreter.

The first public-base candidate (`5786bd45...`, build `de0e2410-3ccf-429b-abf0-5fcede010725`) successfully inherited this exact base and then failed closed on Python 3.13.16 versus the old local expectation 3.13.18. Its inventory also established that the Docker-only startup script was absent. This terminal failure and plan are retained; no dependency installation or VM allocation occurred for that build.

An explicitly approved **single inventory VM**, at most 60 seconds, then used the same exact public build selector with deny-all outbound/public access off/auto-resume off and task HMAC metadata. It ran for 4.8 seconds, confirmed envd 0.10.0, Python 3.13.16, user 1000:1000/home `/home/user`, all nine required inherited packages, active Jupyter/interpreter services and the real SDK code endpoint. Both systemd units and the private Jupyter healthcheck exactly matched the fixed official interpreter source commit `7c895a1eb24107039186650682d8f1942ec94784`. Kill was acknowledged and GET confirmed absence. The lock now records **this observed base inventory**, with exact version and three startup file hashes. It does not claim the final customized candidate is accepted.

The derived spec deliberately omits start/ready overrides, inheriting the immutable base's original context. The fixed runtime source's `TestTemplateBuildFromTemplateBaseCommandsInheritance` verifies this behavior. The official production source uses systemd; `/root/.jupyter/start-up.sh` is only its Docker path. Build first emits a bounded non-secret inventory and verifies exact package/user/startup-file hashes before installation; any drift fails closed. No check is removed merely to make the new base pass.

The previous plan `490abf999242d0b847263f1addcae660cab707b248c0ebe74339e95d6cd739b4` used `e2bdev/code-interpreter@sha256:dda149a59c28e320ac2821d22242b8698fe5d41db4727cb7dcbfbba415f45d2d`. That image was genuinely inspected/accepted locally, but E2B's builder rejected pulling it with access denied. Its exact template `i5ofbyqlugb0d5ad4i74` / build `c2a9db0d-6682-48fe-8bc9-cc7fbdccac2d` is terminal failed at base stage. The old plan, inventory, receipt, upload/trigger history and failure are retained separately; no VM was allocated for that attempt. Local Docker access did not establish provider pull access. The current candidate changes base route and has its own plan/source hashes and exclusive receipt.

## Dependency and output contract

| Capability | Strict inherited expectation | Build-time additions |
| --- | --- | --- |
| CSV/data analysis | pandas 2.2.3, numpy 2.3.5 | None |
| Static charts/images | matplotlib 3.10.9, Pillow 12.3.0 | None |
| DOCX/XLSX | python-docx 1.1.2, openpyxl 3.1.5 | XlsxWriter 3.2.9 |
| PPTX | lxml 6.1.3, typing_extensions 4.16.0, Pillow | python-pptx 1.0.2 |
| PDF/OOXML parser | defusedxml 0.7.1 | pypdf 6.21.4 |
| Chinese plots/PDF | No inherited font compatibility assumption | Unmodified fixed-commit/SHA Noto Sans SC TrueType font + SIL license |

All additional official PyPI wheels have exact version/SHA256 in `requirements.lock.txt`; parser pins must match `../requirements.txt`. `pip --require-hashes --only-binary=:all: --no-deps` avoids dependency upgrades/source builds. Required inherited versions are verified before installation and the combined set afterward. The template makes no browser, OCR, macro, LibreOffice rendering, audio/video or external-network capability claim. OOXML readback is not Microsoft Office visual acceptance.

Build-time installation alone uses the public PyPI index and fixed font/license URLs. Runtime installs nothing. No keys, profiles, signed URLs or user files enter the eight explicit COPY sources. Executor helpers are delivered by the existing bounded command protocol; no second Agent loop exists here.

`font-assets.lock.json` pins unmodified [Noto Sans SC TrueType](https://github.com/notofonts/noto-cjk/blob/523d033d6cb47f4a80c58a35753646f5c3608a78/Sans/Variable/TTF/Subset/NotoSansSC-VF.ttf) and [SIL OFL 1.1](https://github.com/google/fonts/blob/9862abc066c9b83bf84c3e8ed1fc2d8d48f9bbf0/ofl/notosanssc/OFL.txt). Installation verifies exact size/SHA. `configure_fonts.py` verifies glyf/no CFF, internal family and the six glyphs in `销售金额统计`, then sets default Matplotlib family and PDF font type 42, preserving unrelated settings. The prior local candidate passed Chinese PNG/PDF readback and Poppler without font-type mismatch; this does not substitute for checking the new provider base.

## Offline plan/check

```powershell
node crates/cloud-executor/sandbox/template/build.mjs check
node --test crates/cloud-executor/sandbox/template/build.test.mjs
```

The plan includes actual pinned e2b 2.62.0 SDK serialization, eight content hashes, base inventory flag, resources and plan SHA. `@e2b/code-interpreter` remains 2.9.0. Tests block fetch on default/check, even with an ambient legacy key, and assert start/ready are omitted. SDK `fromTemplate` cannot be exported to a Dockerfile: plan records `dockerfile: null`, and `--dockerfile` explicitly refuses. The earlier local OCI image/acceptance is historical evidence, not a reproducible local image for this new public base. `local-check.mjs` rejects stale packaged file hashes rather than accepting the old image as current.

The optional API logger is deliberately omitted: the pinned SDK logger returns an undici Response incompatible with openapi-fetch's global Response check. The regression reproduces this entirely in memory. The production executor already omits the logger; this CLI fix does not change its image.

`acceptance.py` checks a three-row CSV total 124.75; creates a Chinese-title PNG/PDF, DOCX, XLSX formula/chart and PPTX; reopens formats, runs the isolated parser, and verifies hashes/scope/page/paragraph/cell/slide locators. Prior offline runs establish dependency/output compatibility for the old OCI inventory only. The current real VM must independently pass the same tests and bounded ZIP fixture.

## Explicit approved remote execution

Copy `private-config.example.json` into a new ignored owner-only file (Windows owner ACL or POSIX 0600), fill an approved exact current plan, new versioned alias, finite approval expiry (at most 24 hours), traceable budget reference, `max_build_requests: 1`, and a new absolute receipt path.

```powershell
node crates/cloud-executor/sandbox/template/build.mjs --execute --private-config D:/PRIVATE/template-build.private.json
```

Execution requires all markers. It never reads dotenv, profiles or ambient `E2B_API_KEY`. Fixed official API URLs, debug off, zero SDK retries, and bounded request/signal timeouts are used. One SDK invocation may perform multiple upload/control requests; the build count is not a dollar cap. Provider work can outlive a local timeout. The current human authorization is free credits only, no plan upgrade/payment card; operator evidence and resources are kept outside the Git tree.

An exclusive fsynced receipt precedes submission. Reusing it is refused after success/crash. The only success here is `submitted_not_verified`. A lost/invalid reply remains unknown with no automatic retry/new alias. Reconcile exact original template/build/alias before any later action. Preserve prior failure evidence and never overwrite its receipt. No template is automatically deleted or enabled.

## Live acceptance gate

Before setting the runtime template:

1. Exact template/build match the approved receipt, strict package/startup/user checks pass, interpreter health succeeds, and actual provider envd is >=0.5.2 (metadata alone is insufficient).
2. Initial owned VM has at most 300 seconds, deny-all outbound/public access off, auto-resume off, task owner/workspace metadata, no management credentials inside it. Unknown create is reconciled by the same operation metadata, never allocated again blindly.
3. Actual executor bounded transfer and Python synthetic CSV/Office/PDF/Chinese/ZIP checks succeed; execution installs nothing. Additional cancellation, 32 MiB boundaries and persisted S3 continuation are separate documented acceptance, not implied by this one VM.
4. Exact owned VM is killed and absence confirmed; unknown cleanup blocks acceptance. Record allocation/build duration and provider usage truthfully; zero VMs is not a zero-cost claim.

Do not downgrade envd/network policy or fall back to a moving alias when this fails. Review actual inventory/errors and create a separately approved candidate only after the preceding attempt is terminal or reconciled.

## 2026-10-29 authorized live candidate result

Plan `501b2ae4b0f0d35d823fb669a4e8281ea6d845274525e3d19831148993a0f165` was submitted once after both earlier builds were terminal. Exact customized build **`i5ofbyqlugb0d5ad4i74:2d181dad-575e-477e-b17a-cf785d52e277`** became ready with envd 0.10.0. The provider reused the same template ID across candidate tags; production/test configuration must retain the **build UUID selector**, not the bare template ID or named tag.

One real candidate VM (300-second lifetime, 69.665 seconds of acceptance wall time) passed the actual executor adapter and SQLite durable operation receipts: strict dependencies, CSV total 124.75, DOCX/XLSX/PPTX/PDF parser/readback, default Chinese PNG/PDF glyphs and pypdf text, 43 real ZIP cases, actual `archive.extract`, scoped `file.parse`, five size/SHA-verified result downloads, and a 262181-byte transfer with a 196613-byte stdin frame. The final started command had a real PID; cancellation confirmed remote termination. Explicit cleanup then acknowledged the stopped VM and a provider GET confirmed absence. The downloaded PDF also rendered locally through Poppler without font-type mismatch; local pdftotext was unavailable and no Poppler text-extraction claim is made.

Identity is explicit: `command.run` used UID/GID 1000 and the broker workspace was 1000:1000/mode 0700; the **official Python code kernel ran as root inside the VM**, creating a root-owned 0644 synthetic file. VM root is not host root. Management key/token environment presence checks were false. This is not a claim that every user-code process runs as UID 1000. No management credentials, object-store URLs or user originals were sent to the VM.

Evidence is retained in the ignored local task directory `.codex-artifacts/cloudchat-external-20261029/e2b-readiness/`: the two failed builds, base inventory VM/confirmed cleanup, `public-systemd-build/`, `candidate-vm/` and `configured-template.json`. An initial local PDF evidence command continued after missing pdftotext; its invalid attempt is preserved and explicitly superseded by corrected render-only evidence plus the actual VM pypdf result. Only the dedicated owner-private test resource JSON was explicitly updated with the immutable selector and acceptance metadata; unrelated fields/ACL were preserved. The production executor image remains the separately accepted `61ff3364...` runtime image; template CLI/source changes do not enter it. This VM does **not** establish 32 MiB live-transfer boundaries, full S3 persistence/continuation, Web workflows or final provider billing; those remain separately scoped acceptance facts. Free-credit/no-card authorization did not change plan or payment settings.
