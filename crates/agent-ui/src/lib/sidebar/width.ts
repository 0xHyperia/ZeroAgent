export const SIDEBAR_DEFAULT_WIDTH = 272;
export const SIDEBAR_MIN_WIDTH = 240;
export const SIDEBAR_MAX_WIDTH = 440;
export const SIDEBAR_WIDTH_STORAGE_KEY = "zeroagent:ui:sidebar-width:v1";

/** Shrinking a window constrains presentation, not the user's saved preference. */
export function sidebarWidthBounds(hostWidth: number) {
  const max =
    hostWidth > 0 && Number.isFinite(hostWidth)
      ? Math.max(
          SIDEBAR_MIN_WIDTH,
          Math.min(SIDEBAR_MAX_WIDTH, Math.floor(hostWidth * 0.4), hostWidth - 360),
        )
      : SIDEBAR_MAX_WIDTH;
  return { min: SIDEBAR_MIN_WIDTH, max };
}

export function clampSidebarWidth(width: number, max = SIDEBAR_MAX_WIDTH) {
  return Math.round(
    Math.max(
      SIDEBAR_MIN_WIDTH,
      Math.min(max, Number.isFinite(width) ? width : SIDEBAR_DEFAULT_WIDTH),
    ),
  );
}

/** Layout preference only: never reads account, device, conversation or execution data. */
export function createSidebarWidthStore(storage = () => window.localStorage) {
  let value = SIDEBAR_DEFAULT_WIDTH;
  let initialized = false;
  const listeners = new Set<() => void>();
  const parse = (raw: string | null) =>
    raw?.trim() && Number.isFinite(Number(raw))
      ? clampSidebarWidth(Number(raw))
      : SIDEBAR_DEFAULT_WIDTH;
  const emit = (next: number) => {
    if (next === value) return;
    value = next;
    for (const listener of listeners) listener();
  };
  const getSnapshot = () => {
    if (!initialized) {
      initialized = true;
      try {
        value = parse(storage().getItem(SIDEBAR_WIDTH_STORAGE_KEY));
      } catch {
        /* In-memory layout still works. */
      }
    }
    return value;
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key === SIDEBAR_WIDTH_STORAGE_KEY || event.key === null) emit(parse(event.newValue));
  };
  return {
    getSnapshot,
    getServerSnapshot: () => SIDEBAR_DEFAULT_WIDTH,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) window.removeEventListener("storage", onStorage);
      };
    },
    set(width: number, persist = false) {
      getSnapshot();
      const next = clampSidebarWidth(width);
      emit(next);
      if (persist) {
        try {
          storage().setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(next));
        } catch {
          /* Storage can be unavailable in embedded/private hosts. */
        }
      }
    },
  };
}

export const sidebarWidthStore = createSidebarWidthStore();
