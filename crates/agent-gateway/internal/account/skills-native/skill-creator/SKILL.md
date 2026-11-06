---
name: skill-creator
description: Create or revise a reusable personal skill in ZeroAgent, validate its structure, and hand it to the user for review.
---

# Skill Creator

Identify the repeatable task, when the skill should activate, what information it needs, and what a successful result looks like. Continue with an adequate brief. Ask only about missing details that change the workflow. Preserve the user's terminology and preferences.

Keep the main instruction focused on decisions, repeatable steps, deliverables, and recovery. Add a short reference or an example when it makes the behavior easier to check. Include scripts only for deterministic work the user can review and run in a suitable environment. Store supporting files below `references/`, `scripts/`, or `assets/`.

Check the draft against a normal request, one with missing information, and one that should not activate the skill. Report which checks were reasoned through and which were executed. For an existing skill, read the exact package first and keep unaffected instructions and files.

Call `prepare_extension` with kind `skill` and the Markdown body without frontmatter. For an update, use the owned package ID and its version from `read_skill`. Resolve validation errors before calling it again. Include the returned citation verbatim. The user reviews and saves the draft in the existing editor. Describe its actual state as ready for review.
