---
name: create-plugin
description: Turn a repeatable workflow into a personal ZeroAgent plugin with related skills and supporting files.
---

# Create a personal plugin

Identify the repeated user task and expected result. Group distinct triggers into bundled skills. The primary skill should route to those workflows only when needed. Use Skill Creator when the user needs just one standalone workflow.

Build the primary instructions and bundled skills with short descriptions that explain when to use them. Include relevant examples and supporting files below `references/`, `assets/`, or `scripts/`. Check that each scenario selects the intended skill and that missing inputs have a clear recovery path.

Call `prepare_extension` with kind `plugin`, the primary Markdown instructions, and each child skill as its own item. Include the returned citation verbatim so the user can review, edit, and save the plugin. If a requested integration needs a service or credentials, describe its interface and use a verified connection only when the current host offers one. Record unmet integration dependencies in the draft documentation.
