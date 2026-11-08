export type CloudTranscriptReadingPosition = { messageId: string; offset: number };

const KEY = "zeroagent:cloud-transcript-reading:";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const LIMIT = 48;

function readPositions(owner: number | string): Record<string, CloudTranscriptReadingPosition> {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(`${KEY}${owner}`) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        ([id, position]) =>
          ID_PATTERN.test(id) &&
          typeof position?.messageId === "string" &&
          ID_PATTERN.test(position.messageId) &&
          Number.isFinite(position.offset) &&
          Math.abs(position.offset) <= 65_536,
      ),
    );
  } catch {
    return {};
  }
}

export function readCloudTranscriptReading(owner: number | string, id: string) {
  const positions = readPositions(owner);
  return Object.hasOwn(positions, id) ? positions[id] : undefined;
}

export function writeCloudTranscriptReading(
  owner: number | string,
  id: string,
  position?: CloudTranscriptReadingPosition,
) {
  if (!ID_PATTERN.test(id)) return;
  const positions = new Map(Object.entries(readPositions(owner)));
  const previous = positions.get(id);
  if (previous?.messageId === position?.messageId && previous?.offset === position?.offset) return;
  positions.delete(id);
  if (position) positions.set(id, position);
  try {
    window.sessionStorage.setItem(
      `${KEY}${owner}`,
      JSON.stringify(Object.fromEntries([...positions].slice(-LIMIT))),
    );
  } catch {
    // Reading positions are optional in a window without session storage.
  }
}

export function readVisibleCloudTranscriptAnchor(
  viewport: HTMLElement,
  messageIds: ReadonlySet<string>,
): CloudTranscriptReadingPosition | undefined {
  const bounds = viewport.getBoundingClientRect();
  for (const row of viewport.querySelectorAll<HTMLElement>("article[data-row-key]")) {
    const messageId = row.dataset.rowKey;
    if (!messageId || !messageIds.has(messageId)) continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
      return { messageId, offset: Math.round(bounds.top - rect.top) };
    }
  }
}
