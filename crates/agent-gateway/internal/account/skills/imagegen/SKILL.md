---
name: imagegen
description: Generate new images or edit existing images when the user needs a visual, illustration, mockup or design exploration. Do not use for ordinary code, charts or vector icons.
---

# ImageGen

Use `generate_image` for new images and reference edits. It uses Settings → 图像创作 independently of the conversation model. Never ask for an API key or arbitrary provider URL.

- Compose a specific prompt with purpose, subject, composition, style, materials, palette, exact text and constraints. Preserve the user's intent; avoid unrelated decoration.
- For edits include owned `file_id` or generated `artifact_version_id` references. Specify what changes and what stays invariant. Do not describe a reference you have not seen through vision/file tools.
- Generate one image per call. For requested variants use distinct prompts and a deliberate small count. Preserve completed results if a later call fails. Use descriptive PNG names. Use `family_id` only for an intentional new version of the same generated image.
- `needs_configuration` means no default. Guide the user to the inline settings action, then continue when they return. Never silently choose a paid model or claim generation succeeded.
- Only a returned ready artifact is a deliverable. The UI displays it automatically below the reply. Describe the results briefly without adding repeated bare artifact citations or duplicate download links. Use `【成果:VERSION_ID】` only for a useful reference inside prose. Never paste base64 or invent image URLs.
- Follow-up edits create immutable new results; do not overwrite uploads or automatically share images. Unknown outcomes must not be automatically retried.
- Prefer actual components/vector code for existing icons and interactive charts. Use this tool for real bitmap assets and image-based visual directions.
