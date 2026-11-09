/** Keep address/search parsing separate from native navigation policy. */
export function resolveBrowserAddress(value: string): string | null {
  const input = value.trim();
  if (!input || input.length > 16_384) return null;

  const hostWithPort = /^(?:localhost|(?:[\w-]+\.)+[\w-]+|\[[0-9a-f:.]+\]):\d+(?:[/?#]|$)/i;
  const explicitScheme = /^[a-z][a-z\d+.-]*:/i.test(input) && !hostWithPort.test(input);
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
  const address = /^(?:[\p{L}\d-]+\.)+[\p{L}\d-]+(?::\d+)?(?:[/?#]|$)/u;
  const ipLiteral = /^\[[0-9a-f:.]+\](?::\d+)?(?:[/?#]|$)/i;
  if (!explicitScheme && !local.test(input) && !address.test(input) && !ipLiteral.test(input)) {
    const search = new URL("https://www.google.com/search");
    search.searchParams.set("q", input);
    return search.href;
  }

  return safeBrowserUrl(
    explicitScheme ? input : `${local.test(input) ? "http" : "https"}://${input}`,
  );
}

export function safeBrowserUrl(input: string): string | null {
  try {
    const url = new URL(input);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.hostname &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function formatBrowserAddress(address: string): string {
  const normalized = safeBrowserUrl(address);
  if (!normalized) return "";
  const url = new URL(normalized);
  const host = url.host.replace(/^www\./i, "");
  return url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ? `http://${host}`
    : host;
}
