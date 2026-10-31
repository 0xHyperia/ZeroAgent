/** Identity only. The receiving host must re-read current, account-authorized metadata. */
export const CLOUD_RESOURCE_DRAG_MIME = "application/x-zeroagent-cloud-resource+json";
export type CloudResourceDragIdentity = {
  kind: "file" | "artifact";
  id: string;
  target_id: string;
  site_version_id?: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function identities(value: unknown): CloudResourceDragIdentity[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 8) return null;
  const result: CloudResourceDragIdentity[] = [];
  for (const item of value) {
    if (
      !item ||
      typeof item !== "object" ||
      !["file", "artifact"].includes(item.kind) ||
      typeof item.id !== "string" ||
      !UUID.test(item.id) ||
      typeof item.target_id !== "string" ||
      !UUID.test(item.target_id) ||
      (item.site_version_id !== undefined &&
        (item.kind !== "artifact" ||
          typeof item.site_version_id !== "string" ||
          !UUID.test(item.site_version_id)))
    )
      return null;
    if (
      result.some(
        (old) =>
          old.kind === item.kind &&
          old.target_id === item.target_id.toLowerCase() &&
          old.site_version_id === item.site_version_id?.toLowerCase(),
      )
    )
      continue;
    result.push({
      kind: item.kind,
      id: item.id.toLowerCase(),
      target_id: item.target_id.toLowerCase(),
      ...(item.site_version_id ? { site_version_id: item.site_version_id.toLowerCase() } : {}),
    });
  }
  return result;
}

export function writeCloudResourceDragPayload(
  transfer: DataTransfer,
  items: readonly CloudResourceDragIdentity[],
) {
  const safe = identities(items);
  if (!safe) return false;
  transfer.setData(CLOUD_RESOURCE_DRAG_MIME, JSON.stringify({ version: 1, items: safe }));
  transfer.effectAllowed = "copy";
  return true;
}

export function hasCloudResourceDragPayload(transfer: DataTransfer) {
  return Array.from(transfer.types).includes(CLOUD_RESOURCE_DRAG_MIME);
}

export function readCloudResourceDragPayload(transfer: DataTransfer) {
  const raw = transfer.getData(CLOUD_RESOURCE_DRAG_MIME);
  if (!raw || raw.length > 4096) return null;
  try {
    const payload = JSON.parse(raw);
    return payload?.version === 1 ? identities(payload.items) : null;
  } catch {
    return null;
  }
}
