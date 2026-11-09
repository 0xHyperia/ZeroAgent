import { safeBrowserUrl } from "./browserAddress";

export type BrowserHistorySnapshot = {
  entries: string[];
  index: number | null;
};

export function parseBrowserHistory(value: unknown): BrowserHistorySnapshot | null {
  if (!value || typeof value !== "object" || !("entries" in value) || !("index" in value))
    return null;
  const { entries, index } = value;
  if (!Array.isArray(entries) || entries.length > 20) return null;
  if (
    index !== null &&
    (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= entries.length)
  )
    return null;
  if (
    !entries.every(
      (url) =>
        typeof url === "string" &&
        url.length <= 2048 &&
        !/[?#]/.test(url) &&
        safeBrowserUrl(url) === url,
    )
  )
    return null;
  return { entries, index };
}
