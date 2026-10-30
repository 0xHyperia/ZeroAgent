/** 发送键为本机输入偏好，仅在消息编辑器中读取，不注册系统快捷键。 */
export type SendShortcut = "enter" | "ctrlEnter";
export const SEND_SHORTCUT_STORAGE_KEY = "liveagent.sendShortcut.v1";

export function readSendShortcut(): SendShortcut {
  try {
    return window.localStorage.getItem(SEND_SHORTCUT_STORAGE_KEY) === "ctrlEnter"
      ? "ctrlEnter"
      : "enter";
  } catch {
    return "enter";
  }
}

/** Phone/tablet return keys insert paragraphs; viewport width never changes desktop shortcuts. */
export function readComposerSendShortcut(): SendShortcut {
  if (typeof navigator !== "undefined") {
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const tabletDesktopAgent =
      /Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1;
    if (mobile || tabletDesktopAgent) return "ctrlEnter";
  }
  return readSendShortcut();
}

export function writeSendShortcut(shortcut: SendShortcut): void {
  window.localStorage.setItem(SEND_SHORTCUT_STORAGE_KEY, shortcut);
}

export function shouldSendOnEnter(
  event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean },
  shortcut: SendShortcut,
): boolean {
  if (event.shiftKey || event.altKey) return false;
  return shortcut === "enter" || event.ctrlKey || event.metaKey;
}
