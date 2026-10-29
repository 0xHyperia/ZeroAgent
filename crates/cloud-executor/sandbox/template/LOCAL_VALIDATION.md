# Local evidence, 2026-10-29

No E2B API key, template build, sandbox allocation, publication or paid API was used. Official Docker/PyPI downloads and local Docker execution were the only external/local infrastructure operations.

The base image was pulled by linux/amd64 digest `sha256:dda149a59c28e320ac2821d22242b8698fe5d41db4727cb7dcbfbba415f45d2d`; actual non-root package inventory and a separate root-only read of the official startup script are retained under `.codex-artifacts/cloudchat-template-20261029/official-base-*.json`. The startup SHA256 and required package versions match `base.lock.json`. Python is 3.13.18. A separate read-only/deny-network check verified `/home/user/zeroagent-workspace` owner 1000:1000 and mode 0700 in the built image.

Initial candidate plan (before the Chinese default-font correction below): `dd9b435e825ec6071eb869e00291e4c03cf148db9226da16884c34924bc5fecc`.

Initial local image: Docker image ID/index `sha256:c352fd34b24307a559acd02ee9836f1c6b987f0beceb462ea6f1d60e56d6fc18`. This is a local Docker image, not an E2B template/build ID. The local tag now points to the Chinese-capable candidate below; nothing was pushed.

Actual local acceptance task `96c093a0-ff44-4c7e-ab20-af7a389639cb` passed with 1000:1000, read-only root, `network=none`, no-new-privileges, dropped capabilities, CPU/memory/PID limits, no ports and no extra swap. Packaged source hashes matched the plan. Current parser helper SHA256: `0e167a74d81b279b1aa4668b971f9089d57d40dcea7bfdcf8ced2a95cd05a225`.

| Check | Actual result |
| --- | --- |
| pandas CSV total | 124.75 |
| Matplotlib PNG | 600×400, Pillow verify succeeded |
| PDF | pypdf reopened 1 page and recovered total |
| DOCX | ZIP integrity and python-docx table/paragraph/image readback |
| XLSX | openpyxl recovered cached total 124.75 and `SUM(B2:B4)` formula; chart present |
| PPTX | python-pptx reopened native chart, total 124.75 |
| Existing isolated parser | PDF 1 / DOCX 10 / XLSX 10 / PPTX 1 segments with page/paragraph/cell/slide locators |
| Transfer/result facts | Output sizes, SHA256 and synthetic scope verified |
| Offline guard tests | 5 passed, zero skipped; default/check forbidden-fetch, exact pins, approval limits, one submission, unknown/no retry |

Evidence: `.codex-artifacts/cloudchat-template-20261029/plan-workspace-final.json`, `local-build-workspace-final.log`, `workspace.json`, and `local-acceptance-final/{manifest.json,report.json,container.log,outputs/}`. Every generated synthetic output is kept with its measured size/SHA. These paths are ignored local evidence, not required application state. The random acceptance container was removed after ID/label checks; no test volumes were created and no existing Docker resource was removed. Existing supervised PostgreSQL/Redis processes were left running.

After adding explicit assertions for CPU, PID, swap, port and no-new-privileges configuration, task `36eed5da-dc7b-4868-b5f9-2f697f633aeb` reran the same frozen image and passed. Its independent receipts/outputs are in `local-boundary-final/`. A separate `xlsx-chart.json` verifies the generated workbook actually contains its chart part. The task-label container listing was empty after cleanup. The five offline guard tests also passed again with zero skips.

This does not establish Microsoft Office visual quality, OCR, real envd >=0.5.2, E2B digest import/startup, remote stdin/cancellation/network policy, real S3 persistence or cost. Those remain the explicitly authorized live acceptance gate in `README.md`.

## Chinese default-font correction

The ASCII-only original check missed a user-visible defect. An actual offline default-font probe selected DejaVu Sans, lacked all six glyphs in `销售金额统计`, emitted six missing-glyph warnings and drew six empty squares. `chinese-font-before/` retains its PNG/PDF, warning/codepoint JSON and PDF rendering. The base's Noto CFF TTC renders the title but Type 42 PDF output produces a Poppler font-type mismatch; a diagnostic Type 3 change loses extractable Chinese text. That intermediate failure and screenshot are retained in `local-chinese-acceptance/` and were not accepted as a production result.

The official unmodified Noto Sans SC variable **glyf TrueType** asset was separately verified against its fixed Sans2.004 commit, 17,773,132-byte length and SHA256 `d68bafcb48a2707749396aa12bbbd833cb70401f3a9a689fd2902c7e0d295964`. FontTools confirms glyf present/CFF and CFF2 absent; its actual internal family is `Noto Sans SC`, and all six required glyphs exist. The matching fixed SIL license is installed alongside it. Asset URLs, bytes and hashes are in `font-assets.lock.json`; the binary itself is downloaded only during build, remains unmodified and is not in Git.

Latest plan: `490abf999242d0b847263f1addcae660cab707b248c0ebe74339e95d6cd739b4`.

Latest local tag `zeroagent-cloudchat-template:local-20261029` image ID/index: `sha256:891aca05e4d67c6e3c638c60e89e7cd0e8c8943ee8ca858da78e67367d8a5f40`.

The final actual build downloaded and hash-checked the font/license, verified glyf, and configured both command and official Jupyter defaults without duplicate/comment parsing warnings. No Python dependency was added. Actual task `d0860b54-6d65-48cf-b7c3-850a43af1f8f` passed the full deny-network/read-only/non-root Office/chart/parser matrix using **no per-plot font override**. Its report confirms six required glyphs, zero missing glyphs/warnings, full Chinese PDF text and total 124.75. Poppler rendered the final PDF with **zero bytes on stderr**, eliminating the prior font-type mismatch. Both final PNG and rendered PDF were visually inspected and show the complete Chinese title. The five offline build/approval tests passed again with zero skips.

Latest evidence: `.codex-artifacts/cloudchat-template-20261029/{plan-truetype.json,local-build-truetype.log}` and `local-truetype-acceptance/{manifest.json,report.json,container.log,pdf-render.png,poppler.stderr.log,outputs/}`. The test container was removed after ownership checks and the final task-label query was empty. This is local synthetic acceptance, not a real E2B build/allocation or a complete locale/font audit.
