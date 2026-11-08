export type DeviceScheduleDraft = {
  id: string;
  name: string;
  prompt: string;
};

type PendingDraft = DeviceScheduleDraft & { owner: number; targetId: string; expiresAt: number };
const draftLifetime = 15 * 60_000;

// The native embedded workbench has its own JS module graph in the same window.
// A window-scoped intent can cross that host boundary without going into URLs or storage.
const pendingDraft = Symbol.for("zeroagent.pending-device-schedule-draft");
export const DEVICE_SCHEDULE_DRAFT_RECEIVED = "zeroagent:device-schedule-draft-received";

function host() {
  return window as Window & { [pendingDraft]?: PendingDraft };
}

export function stageDeviceScheduleDraft(
  owner: number,
  targetId: string,
  draft: DeviceScheduleDraft,
) {
  host()[pendingDraft] = { ...draft, owner, targetId, expiresAt: Date.now() + draftLifetime };
}

export function discardDeviceScheduleDraft(owner: number, draftId: string) {
  const pending = host()[pendingDraft];
  if (pending?.owner === owner && pending.id === draftId) delete host()[pendingDraft];
}

export function receiveDeviceScheduleDraft(owner: number, targetId: string) {
  const pending = host()[pendingDraft];
  if (pending && pending.expiresAt <= Date.now()) {
    delete host()[pendingDraft];
    return;
  }
  if (pending?.owner !== owner || pending.targetId !== targetId) return;
  delete host()[pendingDraft];
  const { id, name, prompt } = pending;
  window.dispatchEvent(
    new window.CustomEvent(DEVICE_SCHEDULE_DRAFT_RECEIVED, { detail: { owner, id } }),
  );
  return { id, name, prompt } satisfies DeviceScheduleDraft;
}
