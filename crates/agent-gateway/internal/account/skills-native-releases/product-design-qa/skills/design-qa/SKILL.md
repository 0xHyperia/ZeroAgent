---
name: design-qa
description: Verify a Product Design build against actual visual evidence before handoff, and record the result.
---

# Design QA

Run this check for Product Design builds, including screenshot-to-code and URL-to-code. Use the separate `audit` workflow when the user wants a critique of an existing product or journey.

## Establish comparable evidence

1. Identify the source and the exact implementation under review. For a new design, use the approved mockup, concept image, or rendered visual target. For a reproduction, use the supplied reference or an authorized capture. Record the implementation's private site version or screenshot identity.
2. Open or capture both sides. Work from the visible rendering. A build log, code inspection, fetched page text, or a publication receipt can substantiate its own check, but it cannot substantiate visual fidelity.
3. Compare the same task state and realistic content. Align viewport, zoom, theme, crop, and device frame. Record CSS viewport and pixel dimensions if density differs. Review the full view first, then check the important regions at a readable scale.
4. Repeat at the relevant desktop and phone widths. Test the important interaction states in the rendered implementation, including the primary action and at least one recovery path when applicable. Record keyboard, console, touch, or accessibility checks only when actually exercised.

If one side cannot be inspected, the result is `blocked`. Record the missing evidence and the smallest next action, such as asking the user for a screenshot of the exact preview and state.

## Compare and repair

- Compare the primary task, hierarchy, layout, spacing, typography, color, and assets. Look for clipped content, overlapping controls, blank regions, and horizontal overflow.
- Test navigation, keyboard focus, the main action, and relevant loading, empty, and error states. Check that phone layout preserves the same task.
- Use `references/design-qa-rubric.md` to rank findings. Include source versus observed behavior, the viewport and state, and a specific correction.
- Fix what is in scope and capture the affected states again. Keep previous evidence labeled as previous. A repair is verified only after checking the changed implementation.

## Record the handoff

Write `design-qa.md` in the isolated workspace when available. Include the target and implementation references, viewport and state pairs, checks performed, remaining issues, and exactly one final result. If the session cannot save a file, provide the same report in the conversation. Use an authenticated private preview for user review when available.

Use `final result: passed` only after both renderings were inspected, required checks ran, and no actionable P0, P1, or P2 issue remains. Otherwise use `final result: blocked` and name the blocker. A blocked preview can be delivered for review with its status visible. It cannot be described as a verified final handoff.
