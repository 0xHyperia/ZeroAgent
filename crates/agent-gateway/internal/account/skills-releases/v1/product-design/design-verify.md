---
name: design-verify
description: Verify a product implementation
---

# Verify a product implementation

## Compare the same state

Start from the selected reference and the actual implementation. Use matching viewport, zoom, data and UI state where possible. Inspect the full layout and focused details together: hierarchy, proportions, widths, alignment, spacing, typography, icons, assets, menus, tooltips and scrollbars.

## Follow the complete task

Verify entry, the primary action, success, returning, failure and recovery. Check keyboard focus, Escape, disabled and busy controls, hover and selection, touch targets, IME and draft preservation. Review desktop, narrow desktop and phone layouts, long content, empty data and loading. Check reduced motion and transitions for flicker, jumps and repeated work.

Use advertised tools for actual rendering or screenshots. Source inspection and automated tests are separate evidence; neither is proof of the visual experience. Never report an unavailable browser as used. Do not upload private material to an external validator.

## Resolve and report

Fix task blockers, data loss and material layout/interaction problems before handoff. Recapture affected states after changes and compare again. Run relevant tests and a build when tools permit. Report the outcome, exact evidence, residual limitations and steps the user can use to review the result. Clearly label unverified states and do not claim a complete production acceptance from one screenshot or a narrow test.
