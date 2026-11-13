import { useSyncExternalStore } from "react";

// Match the compact WebUI styles, including phones rotated past 820px.
export const GATEWAY_COMPACT_VIEWPORT_QUERY =
  "(max-width: 820px), (pointer: coarse) and (max-width: 1000px) and (max-height: 550px)";

function query() {
  return window.matchMedia(
    document.documentElement.dataset.liveagentWebui === "gateway"
      ? GATEWAY_COMPACT_VIEWPORT_QUERY
      : "(max-width: 767px)",
  );
}
function subscribe(listener: () => void) {
  const media = query();
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}
function snapshot() {
  return query().matches;
}
export function useIsMobile() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
