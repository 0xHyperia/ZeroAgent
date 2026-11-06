---
name: imagegen
description: Generate and edit images with the configured ZeroAgent image model, including transparent PNG assets.
---

# Image Gen

Identify whether the user is creating a new image, editing a reference, or requesting separate variants. Translate the brief into a prompt covering subject, intended use, framing, and constraints. Preserve requested text and the aspects the user wants unchanged.

Use `generate_image` with a descriptive PNG name and the requested aspect ratio where supported. Supply the exact owned file or artifact reference for edits. Use its family ID only for a new version of the same work. Generate distinct concepts separately, one result per call.

For a requested transparent PNG, set `background` to `transparent`. The server checks the returned pixels. If the selected model rejects the parameter or the output is opaque, explain the result and ask before attempting another paid generation with different settings. A missing configured model opens the image settings workflow. Preserve completed variants and avoid retrying an unknown outcome.

Return saved artifact references. Describe only properties you can verify from the result. The user can open the image, compare versions, and continue editing in the private library.
