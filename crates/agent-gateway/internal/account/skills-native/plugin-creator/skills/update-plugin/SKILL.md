---
name: update-plugin
description: Review an owned ZeroAgent plugin and prepare a targeted update while preserving unrelated workflows and files.
---

# Update a personal plugin

Identify the owned package by exact ID. Read the current primary skill and the supporting files involved. Ask for the correct package if the identity is ambiguous. Summarize the behavior that changes and the checks that cover it.

Call `prepare_extension` with kind `plugin`, `target_id`, and the exact `base_revision` returned by `read_skill`. Keep the package name stable. Include the complete primary instructions and only the child skills and supporting files that change. The draft preserves other content. If the base has changed, read it again and reconcile the requested changes before preparing another draft.

Include the draft citation verbatim. The user compares the proposed files in the editor and saves explicitly. Use the current host's real tools for any checks and state their result.
