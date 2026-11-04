---
name: design-share
description: Deliver a verified private prototype
---

# Deliver a verified private prototype

## Prepare the actual output

Confirm that the prototype matches the requested task and read design-verify. Use the existing isolated workspace. Produce a static build with index.html, relative paths and bundled local assets. Check that the chosen output directory contains the runtime files needed to open the prototype.

Exclude credentials, hidden configuration, source dependencies, node_modules, unrelated uploads and server code. Never publish the entire workspace. Dynamic services, OAuth, databases, analytics and custom domains require real supported services; do not imitate them with nonfunctional controls.

## Save privately

Call publish_site for only the verified build directory. Keep the existing family_id when the user is updating the same owned site. Reference only the immutable artifact/version returned by the tool. A successful private save is not public publication. The user controls sharing and revocation in the site interface; do not invent a public URL or new permissions.

If publication fails or its result is unknown, preserve files, report the actual state and do not claim the site is live. Do not blindly repeat a write after an unknown result. For deliverables that are files rather than sites, use publish_artifact.

## Hand off clearly

State what was built, how to open the returned result and what was actually tested. Identify unsupported or unverified capabilities without presenting them as working. Keep the source and prior versions available for continuing the user's work.
