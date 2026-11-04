---
name: product-design
description: Design or improve a product experience, audit a flow, explore visual directions, or implement a selected visual reference as a responsive interface. Not for unrelated code fixes.
---

# Product Design

Work from the user's task and existing product. This is ZeroAgent's built-in workflow; do not imply access to ChatGPT, Figma, Mobbin or unavailable browser plugins.

- **Understand / audit:** inspect supplied screenshots, files or accessible source. Map user tasks, navigation, page structure, desktop/phone layouts, complete journey and key states. Report concrete evidence. Distinguish inspected behavior from inference and say what cannot be verified.
- **Explore:** for design pictures read `imagegen` and generate real visual directions. Prefer 2–3 distinct alternatives when a choice helps; a selected precise reference needs one faithful direction. Keep identity, hierarchy, typography, spacing, purposeful density and loading/empty/error/hover/focus states coherent. Include phone behavior. Let the user choose a direction when needed; continue independent work meanwhile.
- **Implement:** inspect existing components and tokens first. Preserve working functions, state and drafts. Build semantic, responsive UI from shared components and real actions. Avoid placeholder buttons, arbitrary card collections, redundant explanations and fake loading progress. Use generated assets where they improve the product.
- **Refine / deliver:** check actual desktop and phone rendering when tools allow. Verify alignment, typography, overflow, transitions, reduced motion, keyboard focus and full task completion. Save runnable private sites with `publish_site` or real files with `publish_artifact`. Do not claim browser verification or deployment without evidence.

Make primary content and the next useful action obvious. Use hierarchy and whitespace before more borders, color or motion. Group controls by task; occasional actions belong in menus. Reserve result dimensions during loading. Motion explains transitions and stays interruptible. Phone is a deliberate single-column flow, not compressed desktop columns.

Follow the existing product's confirmed visual language. Reuse its previewers, tooltips, menus, scrollbars, dialogs and selection controls. Suggest improvements when useful, without imposing one style on every product. Keep implementation details out of the user's workflow.
