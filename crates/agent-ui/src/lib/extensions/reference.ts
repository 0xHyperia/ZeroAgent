export function parseExtensionReference(reference: string) {
  const match = /^zeroagent-skill:([a-z0-9-]+)\/([1-9][0-9]{0,8})\/([a-z0-9-]+)$/.exec(reference);
  return match
    ? { packageId: match[1], version: Number(match[2]), skillName: match[3] }
    : undefined;
}

export function extensionDraftSelection(references: readonly string[], requested: string) {
  const target = parseExtensionReference(requested);
  if (!target) return "none";
  let selected = false;
  for (const reference of references) {
    if (parseExtensionReference(reference)?.packageId !== target.packageId) continue;
    if (reference !== requested) return "conflict";
    selected = true;
  }
  return selected ? "selected" : "none";
}
