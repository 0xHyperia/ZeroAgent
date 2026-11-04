---
name: plugin-creator
description: Create a personal plugin through conversation
---

# Create a personal plugin

Understand the user's recurring task, inputs, desired results and success criteria. Ask only for information needed to proceed. A plugin groups related skills and reference files under one installation; an independent skill belongs in the separate Skills directory.

Describe the plugin's purpose, its main workflow and any supporting skills. Give each skill a lowercase-hyphen name, a concise description and its own SKILL.md with frontmatter. Keep the main workflow at SKILL.md; place supporting skills at skills/<skill-name>/SKILL.md so the importer recognizes them. Ordinary reference Markdown files do not register another skill. Include practical examples, quality checks and failure recovery. Keep longer references in clearly named relative text files.

Use only tools advertised in the current isolated workspace. This CloudChat package format supports inspectable UTF-8 text instructions and references, not executable scripts, binary assets, third-party app connections or new tool permissions. Do not claim to provision an MCP service, OAuth connection, public directory entry or application UI. Explain any required capability that is unavailable. Never include credentials or private conversation data in a package.

Create an actual ZIP artifact containing SKILL.md and the related text files, using at most 64 files, 64 KiB per file and 256 KiB expanded. Avoid traversal, absolute paths, symlinks, binaries and dependencies. Tell the user to inspect the package and import it through 自定义 → 插件 → 个人 → 添加 → 上传插件包. Generating or referencing a package does not install it; importing installs it only for the current account. If archive tools are unavailable, provide exact files and explain the manual packaging step. Preserve existing drafts, files and results.
