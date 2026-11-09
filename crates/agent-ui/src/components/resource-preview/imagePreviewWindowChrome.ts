let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function subscribeImagePreviewWindowChrome(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getImagePreviewWindowChrome() {
  return slot;
}

export function mountImagePreviewWindowChrome(element: HTMLElement) {
  slot = element;
  for (const listener of listeners) listener();
  return () => {
    if (slot !== element) return;
    slot = null;
    for (const listener of listeners) listener();
  };
}
