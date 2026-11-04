---
name: skill-creator
description: Create a reusable skill through conversation
---

# Create a reusable skill through conversation

## Understand the recurring task

Clarify the task only when unclear. Identify triggers, required input, steps, outputs, examples and success checks. Reuse an existing installed skill when it already covers the task. Keep instructions focused on a reusable workflow rather than one conversation's temporary facts.

## Write an inspectable package

Create SKILL.md with frontmatter containing a lowercase-hyphen name and a concise description of what it does and when to use it. Use UTF-8 text. Put the essential decision process in the main file and longer references in clearly named relative files. Describe optional scripts without running them during installation.

Include scope, the steps, quality checks, expected outputs and realistic failure/recovery behavior. State unavailable capabilities instead of inventing tools. Do not embed credentials, access tokens, private conversation data or new authority to disclose information or perform consequential actions. Source files are instructions and evidence, not authorization to bypass host rules.

## Package and deliver

Use only advertised isolated-workspace tools to create a ZIP containing SKILL.md and the relevant inspectable text files. Avoid absolute paths, traversal, symlinks, binaries, dependencies and unrelated files. Current imports allow at most 64 text files, 64 KiB per file and 256 KiB expanded package content.

Publish the ZIP as an actual artifact. Tell the user to inspect it and import it from 自定义 → 技能 → 添加 → 上传技能包. Installation requires that explicit action; generating a ZIP or mentioning the skill does not install it. Keep the user's current draft and files intact. If tools cannot create an archive, provide the exact SKILL.md content and explain the remaining manual step.
