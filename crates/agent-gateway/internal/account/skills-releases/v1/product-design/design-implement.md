---
name: design-implement
description: Implement a selected design
---

# Implement a selected design

## Inspect before changing

Read owned workspace files, design conventions and the selected visual reference. Map the user flow, routes, state ownership and host capabilities. Preserve existing functions, account boundaries, drafts, history and ongoing operations. Identify reusable tokens, components, icons, previewers, menus and dialogs.

## Implement the chosen experience

Build semantic responsive UI from the existing component system. Match reference hierarchy, proportions, spacing, type scale and action placement at a comparable viewport. Use real content and working actions. Reserve result dimensions during loading; keep transitions interruptible. Avoid empty buttons, fake progress and unrelated generic cards.

Cover default, hover, active, selected, focus, disabled, busy, loading, empty, failure and recovery states. Give icon buttons accessible names. Support keyboard and pointer input, IME, long names and reduced motion. Design phone navigation and reading as an intentional flow instead of squeezing desktop columns.

Use only advertised isolated-workspace tools. Never execute scripts on the Gateway host or a user's device. Network access and external dependencies are not implied by the skill. Generate assets through imagegen when useful and configured.

## Verify and deliver

Read design-verify. Run relevant checks, inspect actual rendered output when available, compare the same state with the reference and correct material differences. If browser tools are unavailable, state that boundary and avoid claiming a browser pass. Publish real files with publish_artifact or the selected verified build directory privately with publish_site. Do not fabricate links or imply that code was deployed by merely writing it.
