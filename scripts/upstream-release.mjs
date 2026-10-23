const tagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-((?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)\.)*(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)))?$/;

// Structural validation only. GitHub provenance and local ancestry are independent checks.
export function validateUpstreamRelease(metadata) {
  const errors = [];
  if (metadata.repository !== "Stack-Cairn/LiveAgent") errors.push("invalid repository");
  const match = typeof metadata.tag === "string" && tagPattern.exec(metadata.tag);
  if (!match) errors.push("invalid exact release tag");
  for (const field of ["base_commit", "commit"]) {
    if (!/^[0-9a-f]{40}$/.test(metadata[field] ?? "")) errors.push(`invalid ${field}`);
  }
  if (metadata.channel != null && !["stable", "preview"].includes(metadata.channel)) errors.push("invalid channel");
  if (match?.[1] || metadata.prerelease === true || metadata.channel === "preview") {
    if (metadata.channel !== "preview" || metadata.prerelease !== true) errors.push("preview must be explicit");
    if (metadata.release_url !== `https://github.com/Stack-Cairn/LiveAgent/releases/tag/${metadata.tag}`) errors.push("invalid preview release URL");
    if (typeof metadata.published_at !== "string" || !Number.isFinite(Date.parse(metadata.published_at))) errors.push("missing preview publication time");
  }
  return errors;
}
