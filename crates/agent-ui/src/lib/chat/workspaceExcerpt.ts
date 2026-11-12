import { formatMarkdownBlockquote, normalizeQuoteText } from "./transcriptQuote";

export type WorkspaceExcerpt = {
  id: string;
  path: string;
  text: string;
  comment?: string;
};

export function normalizeWorkspaceExcerpt(value: unknown): WorkspaceExcerpt | null {
  if (!value || typeof value !== "object") return null;
  const { id, path, text, comment } = value as Partial<WorkspaceExcerpt>;
  if (typeof id !== "string" || !id || typeof path !== "string" || typeof text !== "string") {
    return null;
  }
  const quote = normalizeQuoteText(text);
  const source = path.replace(/[\r\n]/g, " ").trim();
  if (!quote || !source) return null;
  return {
    id,
    path: source,
    text: quote,
    comment: typeof comment === "string" ? comment.trim().slice(0, 1200) || undefined : undefined,
  };
}

export function formatWorkspaceExcerpt({ path, text, comment }: WorkspaceExcerpt) {
  const quote = formatMarkdownBlockquote(text);
  return `\n\nFile excerpt: ${path}\n${quote}${comment ? `\n\nComment: ${comment}` : ""}\n`;
}
