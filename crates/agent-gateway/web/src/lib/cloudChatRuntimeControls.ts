import type { ChatRuntimeControls } from "@/lib/settings";

// The shared control's "off" radio emits only thinkingEnabled:false. Cloud
// persists a reasoning effort snapshot, so normalize that callback explicitly
// without changing the device runtime's independent thinking semantics.
export function patchCloudChatRuntimeControls(
  current: ChatRuntimeControls,
  patch: Partial<ChatRuntimeControls>,
): ChatRuntimeControls {
  const next = { ...current, ...patch };
  if (patch.thinkingEnabled === false) {
    next.reasoning = "off";
    next.thinkingEnabled = false;
  } else if (patch.reasoning !== undefined) {
    next.reasoning = patch.reasoning;
    next.thinkingEnabled = patch.reasoning !== "off";
  } else if (patch.thinkingEnabled === true) {
    next.reasoning = current.reasoning === "off" ? "medium" : current.reasoning;
    next.thinkingEnabled = true;
  }
  return next;
}
