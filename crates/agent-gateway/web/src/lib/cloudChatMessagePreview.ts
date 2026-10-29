// Rendering budgets are independent from the canonical history/body limits.
// Complete content stays in private React state for protocol operations; only
// explicitly labelled excerpts enter a transcript, editor or reader DOM.
export const CLOUD_MESSAGE_TRANSCRIPT_CHARS = 4096;
export const CLOUD_MESSAGE_READER_CHARS = 8192;
// Editing and explicit share capture allow ordinary reports beyond the display
// preview, while bounding textarea/accessibility and screenshot-rendering work.
// Clipboard writes have a separate memory/bridge budget and never use a DOM
// textarea fallback for private complete text. Larger originals remain intact
// and downloadable, so these budgets do not truncate canonical content.
export const CLOUD_MESSAGE_INLINE_EDIT_BYTES = 64 * 1024;
export const CLOUD_MESSAGE_CLIPBOARD_BYTES = 1024 * 1024;

export function cloudMessageFitsTextBudget(text: string, limit: number) {
  if (text.length > limit) return false;
  return text.length <= Math.floor(limit / 3) || new TextEncoder().encode(text).byteLength <= limit;
}

export async function copyCloudMessageText(text: string, guard: () => void) {
  guard();
  if (!cloudMessageFitsTextBudget(text, CLOUD_MESSAGE_CLIPBOARD_BYTES))
    throw new Error("消息较长，请分段查看或下载完整正文。");
  if (!navigator.clipboard?.writeText)
    throw new Error("当前浏览器无法访问剪贴板，请下载完整正文。");
  await navigator.clipboard.writeText(text);
  guard();
}

export function cloudMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

function boundary(text: string, position: number): number {
  const index = Math.min(position, text.length);
  // Never split a UTF-16 surrogate pair between adjacent excerpts.
  return index > 0 &&
    /[\uDC00-\uDFFF]/.test(text[index] ?? "") &&
    /[\uD800-\uDBFF]/.test(text[index - 1])
    ? index - 1
    : index;
}

export function cloudMessageTextPage(
  text: string,
  page: number,
  limit = CLOUD_MESSAGE_READER_CHARS,
) {
  const pages = Math.max(1, Math.ceil(text.length / limit));
  const current = Math.max(0, Math.min(pages - 1, Math.floor(page)));
  const start = boundary(text, current * limit);
  const end = boundary(text, (current + 1) * limit);
  return { text: text.slice(start, end), start, end, page: current, pages };
}

export function cloudMessageTranscriptPreview(text: string) {
  const preview = cloudMessageTextPage(text, 0, CLOUD_MESSAGE_TRANSCRIPT_CHARS);
  return {
    text: preview.text,
    truncated: preview.end < text.length,
    notice: preview.end < text.length ? "当前仅显示正文开头；分段查看或下载完整正文。" : "",
  };
}
