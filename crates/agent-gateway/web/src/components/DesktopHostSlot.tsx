import { useCallback } from "react";
import { getDesktopRemoteHost } from "../lib/desktopRemoteHost";

/** Native React portals enter DOM slots, never the WebUI's separate React graph. */
export function DesktopHostSlot({ kind }: { kind: "header" | "account" | "window" }) {
  const host = getDesktopRemoteHost();
  const attach = useCallback(
    (element: HTMLDivElement | null) => {
      if (kind === "header") host?.onHeaderTarget?.(element);
      else if (kind === "account") host?.onAccountTarget?.(element);
      else host?.onWindowControlsTarget?.(element);
    },
    [host, kind],
  );
  return (
    <div
      ref={attach}
      data-desktop-host-slot={kind}
      className={kind === "account" ? "w-full min-w-0" : "flex h-full shrink-0 items-center"}
    />
  );
}
