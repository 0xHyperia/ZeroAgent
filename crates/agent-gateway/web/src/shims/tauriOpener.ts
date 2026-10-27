import { getDesktopRemoteHost, requireCurrentDesktopRemoteHost } from "../lib/desktopRemoteHost";

export async function openUrl(url: string): Promise<void> {
  const host = getDesktopRemoteHost();
  if (host) {
    requireCurrentDesktopRemoteHost();
    if (!host.openExternal) throw new Error("桌面外部链接暂不可用。");
    await host.openExternal(url);
    return;
  }
  const opened = window.open(url, "_blank", "noopener,noreferrer");
  if (opened) {
    opened.opener = null;
  }
}
