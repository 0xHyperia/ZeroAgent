import { GATEWAY_COMPACT_VIEWPORT_QUERY } from "@liveagent/ui/hooks/use-mobile";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { dismissTopMobileOverlay } from "./mobileRuntime";

const historyKey = "zeroagentBrowserBackLayer";
const surfaceSelector =
  ":is([data-browser-back-surface], [data-slot='dialog-content'], [data-slot='popover-content'], [role='menu'], [role='listbox'])";
const openSurfaceSelector = `${surfaceSelector}[data-open]`;

type BrowserLayerEntry = {
  id: string;
  href: string;
  updatedState?: Record<string, unknown>;
};

let layer: BrowserLayerEntry | undefined;
let retiring = false;

function isCurrentLayer(entry: BrowserLayerEntry) {
  return window.location.href === entry.href && window.history.state?.[historyKey] === entry.id;
}

export function pushWorkbenchLocation(state: Record<string, unknown> | null, href: string) {
  if (layer && isCurrentLayer(layer)) {
    const next = { ...state };
    delete next[historyKey];
    layer = undefined;
    retiring = false;
    window.history.replaceState(next, "", href);
  } else {
    window.history.pushState(state, "", href);
  }
}

export function replaceWorkbenchState(state: Record<string, unknown>) {
  if (layer && isCurrentLayer(layer)) {
    const next = { ...state };
    delete next[historyKey];
    layer.updatedState = next;
    window.history.replaceState({ ...next, [historyKey]: layer.id }, "", layer.href);
    return;
  }
  window.history.replaceState(state, "", window.location.href);
}

export function installBrowserMobileBack() {
  const compact = window.matchMedia(GATEWAY_COMPACT_VIEWPORT_QUERY);
  let frame = 0;

  function sync() {
    frame = 0;
    if (retiring) return;
    if (layer && !isCurrentLayer(layer)) layer = undefined;
    const open = compact.matches && !!document.querySelector(openSurfaceSelector);
    if (open && !layer) {
      const entry = { id: createUuid(), href: window.location.href };
      window.history.pushState({ ...window.history.state, [historyKey]: entry.id }, "", entry.href);
      layer = entry;
    } else if (!open && layer) {
      retiring = true;
      window.history.back();
    }
  }

  function scheduleSync() {
    if (!frame) frame = window.requestAnimationFrame(sync);
  }

  window.addEventListener(
    "popstate",
    (event) => {
      const previous = layer;
      if (!previous || isCurrentLayer(previous)) return;
      layer = undefined;
      const wasRetiring = retiring;
      retiring = false;
      if (window.location.href !== previous.href) return;

      // This entry represents the view over the current route. Let the shared
      // popup handle one Escape before the conversation's history listeners run.
      event.stopImmediatePropagation();
      if (previous.updatedState) {
        window.history.replaceState(previous.updatedState, "", previous.href);
      }
      if (!wasRetiring) dismissTopMobileOverlay();
      scheduleSync();
    },
    { capture: true },
  );

  const observer = new MutationObserver((mutations) => {
    if (!compact.matches) return;
    if (
      mutations.some((mutation) => {
        if (mutation.type === "attributes") {
          return (mutation.target as Element).matches(surfaceSelector);
        }
        return [...mutation.addedNodes, ...mutation.removedNodes].some(
          (node) =>
            node instanceof Element &&
            (node.matches(openSurfaceSelector) || node.querySelector(openSurfaceSelector) !== null),
        );
      })
    )
      scheduleSync();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-open"],
  });
  compact.addEventListener("change", scheduleSync);
}
