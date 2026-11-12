/** Reader navigation honors reduced motion without changing global scrolling. */
export function readerScrollBehavior(): ScrollBehavior {
  return typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ? "instant"
    : "smooth";
}

// One teardrop silhouette for the paper mark, hover pointer and revision cursor.
function commentPin(size: number) {
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 28 28"><path d="M4 14a10 10 0 1 1 10 10H6a2 2 0 0 1-2-2Z" fill="#3785f6" stroke="white" stroke-width="1.3"/></svg>`)}")`;
}

export const COMMENT_PIN = commentPin(28);
export const COMMENT_CURSOR = `${COMMENT_PIN} 4 24, pointer`;
export const SHEET_COMMENT_CURSOR = `${commentPin(26)} 13 12, crosshair`;
export const READER_NAVIGATION_WIDTH = 232;
export const READER_NAVIGATION_INSET = READER_NAVIGATION_WIDTH + 12;
