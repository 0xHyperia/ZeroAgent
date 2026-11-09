import { parser as cssParser } from "@lezer/css";
import { parser as jsParser } from "@lezer/javascript";
import {
  type DefaultTreeAdapterMap,
  defaultTreeAdapter,
  parse,
  parseFragment,
  serialize,
} from "parse5";

export type WorkspaceHTMLAsset = { mime_type: string; data: string };
export type WorkspaceHTMLLink = { kind: "file"; path: string } | { kind: "web"; url: string };

const MAX_ASSETS = 64;
const MAX_ASSET_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_ASSET_DEPTH = 8;
const BLANK_RESOURCE = "data:,";
const DATA_MIME =
  /^(?:image\/(?:avif|bmp|gif|jpeg|png|svg\+xml|webp|x-icon)|audio\/(?:mpeg|wav|ogg|mp4)|video\/(?:mp4|webm|ogg)|font\/(?:woff2?|ttf|otf)|text\/vtt)$/i;
const DATA_ASSET = /^data:([^;,]+);base64,([a-z0-9+/=]+)$/i;
const BLOCKED_ELEMENTS = new Set([
  "base",
  "noscript",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "fencedframe",
  "animate",
  "set",
  "animatetransform",
  "animatemotion",
]);
const FRAME_LINK_ATTRIBUTE = "data-za-preview-link";
const BLOCKED_SCRIPT = "data:text/javascript,export%20%7B%7D";
const SCRIPT_TYPES =
  /^(?:module|(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:jscript|livescript))$/i;
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Parent = DefaultTreeAdapterMap["parentNode"];

function documentRelativePath(documentPath: string, value: string): string | null {
  if (
    !documentPath ||
    /[:\\\0]/.test(documentPath) ||
    documentPath.split("/").some((piece) => !piece || piece === "." || piece === "..")
  )
    return null;
  const reference = value.trim().split(/[?#]/, 1)[0];
  if (!reference || /^(?:[a-z][a-z0-9+.-]*:|[/\\])|%2f|%5c/i.test(reference)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(reference);
  } catch {
    return null;
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Reject unsafe controls after URL decoding.
  if (/[:\\\u0000-\u001f\u007f]/.test(decoded)) return null;
  const segments = documentPath.split("/").slice(0, -1);
  for (const piece of decoded.split("/")) {
    if (piece === "..") {
      if (segments.length === 0) return null;
      segments.pop();
    } else if (piece && piece !== ".") {
      segments.push(piece);
    }
  }
  return segments.join("/") || null;
}

function secureLink(documentPath: string, value: string): WorkspaceHTMLLink | null {
  if (/^https?:\/\//i.test(value.trim())) {
    try {
      const url = new URL(value.trim());
      if (!url.username && !url.password && url.href.length <= 2048)
        return { kind: "web", url: url.href };
    } catch {
      return null;
    }
  }
  const path = documentRelativePath(documentPath, value);
  return path ? { kind: "file", path } : null;
}

function cssUrl(value: string) {
  const raw = value.trim();
  const unquoted = /^(["']).*\1$/s.test(raw) ? raw.slice(1, -1) : raw;
  return unquoted.replace(
    /\\(?:([a-f0-9]{1,6})\s?|\r\n|[\r\n\f]|(.))/gi,
    (_match, hex: string | undefined, escaped: string | undefined) => {
      if (!hex) return escaped ?? "";
      const point = Number.parseInt(hex, 16);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "\uFFFD";
    },
  );
}

function encodeText(text: string) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let at = 0; at < bytes.length; at += 8192) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  }
  return btoa(binary);
}

function decodeScriptString(raw: string) {
  try {
    return raw
      .slice(1, -1)
      .replace(
        /\\(?:u\{([a-f0-9]+)\}|u([a-f0-9]{4})|x([a-f0-9]{2})|\r\n|[\r\n\u2028\u2029]|(.))/gi,
        (
          _match,
          wide: string | undefined,
          unit: string | undefined,
          hex: string | undefined,
          escaped: string | undefined,
        ) => {
          const point = wide ?? unit ?? hex;
          if (point) return String.fromCodePoint(Number.parseInt(point, 16));
          const controls: Record<string, string> = {
            n: "\n",
            r: "\r",
            t: "\t",
            b: "\b",
            f: "\f",
            v: "\v",
            "0": "\0",
          };
          return escaped ? (controls[escaped] ?? escaped) : "";
        },
      );
  } catch {
    return "";
  }
}

function escapeAttribute(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function policy(scriptNonces: string[], frame: "about:" | "'none'") {
  // Chromium loads JSON modules under connect-src. Data URLs keep that support offline.
  return `default-src 'none'; script-src ${scriptNonces.map((nonce) => `'nonce-${nonce}'`).join(" ")} data:; script-src-attr 'unsafe-inline'; style-src 'unsafe-inline' data:; img-src data:; font-src data:; media-src data:; base-uri 'none'; form-action 'none'; connect-src data:; object-src 'none'; frame-src ${frame}; worker-src 'none'; manifest-src 'none'`;
}

// Intersect the nonce policy with a scheme policy. A nonce copied by author
// JS cannot authorize a script URL outside the preview's data resources.
const offlineScriptPolicy = `<meta http-equiv="Content-Security-Policy" content="script-src 'unsafe-inline' data:">`;

function makeBridge(scriptNonce: string, bridgeToken: string) {
  return `<meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy([scriptNonce], "'none'")}">${offlineScriptPolicy}<script nonce="${scriptNonce}">
(() => {
  const send = parent.postMessage.bind(parent);
  const closest = Function.call.bind(Element.prototype.closest);
  const attr = Function.call.bind(Element.prototype.getAttribute);
  const prevent = Function.call.bind(Event.prototype.preventDefault);
  const findById = document.getElementById.bind(document);
  const findByName = document.getElementsByName.bind(document);
  const decode = decodeURIComponent;
  document.currentScript.remove();
  for (const key of ["RTCPeerConnection", "webkitRTCPeerConnection", "mozRTCPeerConnection", "RTCIceGatherer", "chrome", "__TAURI__", "__TAURI_INTERNALS__"]) {
    try { Object.defineProperty(window, key, {value: undefined}); } catch {}
  }
  addEventListener('click', (event) => {
    const link = event.target instanceof Element && closest(event.target, 'a, area');
    if (!link) return;
    prevent(event);
    if (!event.isTrusted) return;
    const linkId = attr(link, '${FRAME_LINK_ATTRIBUTE}');
    if (linkId !== null) {
      send({ kind:'zeroagent-workspace-html-link', token:${JSON.stringify(bridgeToken)}, linkId }, '*');
      return;
    }
    const fragment = attr(link, 'href');
    if (!fragment || fragment.charAt(0) !== '#') return;
    try {
      const id = decode(fragment.slice(1));
      if (id) (findById(id) || findByName(id)[0])?.scrollIntoView();
    } catch {}
  }, true);
})();
</script>`;
}

function sandboxDocument(
  authorDocument: string,
  nonce: string,
  scriptNonce: string,
  bridgeToken: string,
) {
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy([nonce, scriptNonce], "about:")}">${offlineScriptPolicy}<style>html,body,iframe{width:100%;height:100%;margin:0;padding:0;border:0;display:block;overflow:hidden}</style>
<script nonce="${nonce}">
addEventListener('message', (event) => {
  if (event.origin !== 'null' || event.source !== document.getElementById('preview-document')?.contentWindow) return;
  const data = event.data;
  if (data?.kind !== 'zeroagent-workspace-html-link' || data.token !== ${JSON.stringify(bridgeToken)} || typeof data.linkId !== 'string') return;
  parent.postMessage({kind:'zeroagent-workspace-html-link',token:${JSON.stringify(nonce)},linkId:data.linkId}, '*');
});
</script><iframe id="preview-document" title="HTML" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeAttribute(authorDocument)}"></iframe>`;
}

export async function buildWorkspaceHTMLPreview({
  html,
  documentPath,
  nonce,
  loadAsset,
  signal,
}: {
  html: string;
  documentPath: string;
  nonce: string;
  loadAsset(path: string): Promise<WorkspaceHTMLAsset>;
  signal: AbortSignal;
}) {
  if (!/^[a-f0-9-]{36}$/i.test(nonce) || html.length > MAX_DOCUMENT_BYTES)
    throw new Error("HTML preview exceeds its limits");
  const scriptNonce = crypto.randomUUID();
  const bridgeToken = crypto.randomUUID();
  const links = new Map<string, WorkspaceHTMLLink>();
  const loaded = new Map<string, Promise<WorkspaceHTMLAsset | null>>();
  const expanded = new Map<string, string>();
  const modules = new Map<string, { name: string; source: Promise<string> }>();
  let readBytes = 0;

  function readAsset(path: string): Promise<WorkspaceHTMLAsset | null> {
    const pending = loaded.get(path);
    if (pending) return pending;
    if (loaded.size >= MAX_ASSETS) return Promise.resolve(null);
    const read = (async () => {
      const result = await loadAsset(path).catch(() => null);
      signal.throwIfAborted();
      if (!result || typeof result.data !== "string") return null;
      const bytes =
        Math.floor((result.data.length * 3) / 4) - (result.data.match(/=+$/)?.[0].length ?? 0);
      readBytes += bytes;
      return bytes <= MAX_ASSET_BYTES && readBytes <= MAX_TOTAL_ASSET_BYTES ? result : null;
    })();
    loaded.set(path, read);
    return read;
  }

  async function asset(
    value: string,
    from: string,
    style: boolean,
    chain: readonly string[],
  ): Promise<string> {
    signal.throwIfAborted();
    const original = value.trim();
    if (original.startsWith("#")) return style ? BLANK_RESOURCE : original;
    const data = DATA_ASSET.exec(original);
    if (data && !style && DATA_MIME.test(data[1]) && original.length <= MAX_DOCUMENT_BYTES)
      return original;
    const path = documentRelativePath(from, original);
    if (!path || chain.includes(path) || chain.length >= MAX_ASSET_DEPTH) return BLANK_RESOURCE;
    const result = await readAsset(path);
    if (!result) return BLANK_RESOURCE;
    if (!style)
      return DATA_MIME.test(result.mime_type)
        ? `data:${result.mime_type};base64,${result.data}`
        : BLANK_RESOURCE;
    if (result.mime_type !== "text/css") return BLANK_RESOURCE;
    let css = expanded.get(path);
    if (css === undefined) {
      const originalCSS = new TextDecoder().decode(
        Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0)),
      );
      css = `data:text/css;base64,${encodeText(await rewriteCSS(originalCSS, path, [...chain, path]))}`;
      if (css.length > MAX_DOCUMENT_BYTES) return BLANK_RESOURCE;
      expanded.set(path, css);
    }
    return css;
  }

  function registerModule(reference: string, from: string, depth: number) {
    const path = documentRelativePath(from, reference);
    if (!path || !/\.(?:m?js|json)$/i.test(path)) return null;
    const existing = modules.get(path);
    if (existing) return existing;
    if (modules.size >= MAX_ASSETS || depth >= MAX_ASSET_DEPTH) return null;
    const index = modules.size;
    const name = `@zeroagent/preview/${scriptNonce}/${index}`;
    // A data URL is the module's identity. Keep separate paths independent
    // when their file contents happen to be identical.
    const fragment = `#preview-${index}`;
    const source = (async () => {
      try {
        const result = await readAsset(path);
        if (!result) return BLOCKED_SCRIPT;
        if (/\.json$/i.test(path))
          return result.mime_type === "application/json"
            ? `data:application/json;base64,${result.data}${fragment}`
            : BLOCKED_SCRIPT;
        if (result.mime_type !== "text/javascript") return BLOCKED_SCRIPT;
        const script = new TextDecoder("utf-8", { fatal: true }).decode(
          Uint8Array.from(atob(result.data), (character) => character.charCodeAt(0)),
        );
        return `data:text/javascript;base64,${encodeText(rewriteScript(script, path, depth + 1))}${fragment}`;
      } catch {
        return BLOCKED_SCRIPT;
      }
    })();
    const module = { name, source };
    modules.set(path, module);
    return module;
  }

  function rewriteScript(script: string, from: string, depth: number) {
    let output = "";
    let previous = 0;
    jsParser.parse(script).iterate({
      enter({ node }) {
        if (
          node.name !== "String" ||
          !["ImportDeclaration", "ExportDeclaration", "DynamicImport"].includes(
            node.parent?.name ?? "",
          )
        )
          return;
        const specifier = decodeScriptString(script.slice(node.from, node.to));
        if (!/^(?:\.{1,2}\/|[/\\]|[a-z][a-z0-9+.-]*:)/i.test(specifier)) return;
        const target = registerModule(specifier, from, depth);
        output +=
          script.slice(previous, node.from) + JSON.stringify(target?.name ?? BLOCKED_SCRIPT);
        previous = node.to;
      },
    });
    return output + script.slice(previous);
  }

  async function rewriteCSS(css: string, from: string, chain: readonly string[]) {
    const locations: { from: number; to: number; url: string; import: boolean; call: boolean }[] =
      [];
    cssParser.parse(css).iterate({
      enter({ node }) {
        if (node.name === "CallLiteral") {
          const tag = node.getChild("CallTag");
          const start = node.getChild("(");
          const end = node.getChild(")");
          if (tag && start && end && css.slice(tag.from, tag.to).toLowerCase() === "url") {
            locations.push({
              from: node.from,
              to: node.to,
              url: cssUrl(css.slice(start.to, end.from)),
              import: node.parent?.name === "ImportStatement",
              call: true,
            });
            return false;
          }
        } else if (node.name === "StringLiteral" && node.parent?.name === "ImportStatement") {
          locations.push({
            from: node.from,
            to: node.to,
            url: cssUrl(css.slice(node.from, node.to)),
            import: true,
            call: false,
          });
        }
      },
    });
    let output = "";
    let last = 0;
    for (const location of locations) {
      output += css.slice(last, location.from);
      const rewritten = JSON.stringify(await asset(location.url, from, location.import, chain));
      output += location.call ? `url(${rewritten})` : rewritten;
      if (output.length > MAX_DOCUMENT_BYTES)
        throw new Error("HTML stylesheet exceeds its preview limit");
      last = location.to;
    }
    return output + css.slice(last);
  }

  async function rewriteSrcset(value: string) {
    const candidates: string[] = [];
    for (const match of value.matchAll(
      /(?:^|,\s*)(data:\S+|[^\s,]+)(?:\s+(\d+(?:\.\d+)?[wx]))?/gi,
    )) {
      const rewritten = await asset(match[1].replace(/,$/, ""), documentPath, false, []);
      if (rewritten !== BLANK_RESOURCE)
        candidates.push(`${rewritten}${match[2] ? ` ${match[2]}` : ""}`);
    }
    return candidates.join(", ");
  }

  function detach(node: Node) {
    if (defaultTreeAdapter.isElementNode(node)) defaultTreeAdapter.detachNode(node);
  }

  async function rewriteElement(node: Element) {
    const tag = node.tagName.toLowerCase();
    const scriptType =
      tag === "script"
        ? (node.attrs.find(({ name }) => name === "type")?.value.trim() ?? "")
        : null;
    if (
      BLOCKED_ELEMENTS.has(tag) ||
      (scriptType !== null && /^(?:importmap|speculationrules)$/i.test(scriptType)) ||
      (tag === "meta" && node.attrs.some(({ name }) => name === "http-equiv"))
    ) {
      detach(node);
      return false;
    }
    const isStylesheet =
      tag === "link" &&
      node.attrs.some(
        ({ name, value }) =>
          name === "rel" && value.toLowerCase().split(/\s+/).includes("stylesheet"),
      );
    if (tag === "link" && !isStylesheet) {
      detach(node);
      return false;
    }
    node.attrs = node.attrs.filter(
      ({ name }) =>
        ![
          "target",
          "ping",
          "download",
          "action",
          "formaction",
          "integrity",
          "crossorigin",
          "nonce",
          FRAME_LINK_ATTRIBUTE,
        ].includes(name),
    );
    if (scriptType !== null) {
      if (scriptType && !SCRIPT_TYPES.test(scriptType)) {
        node.attrs = node.attrs.filter(({ name }) => name !== "src");
        return true;
      }
      node.attrs.push({ name: "nonce", value: scriptNonce });
      const source = node.attrs.find(({ name }) => name === "src");
      if (source) {
        const module = registerModule(source.value, documentPath, 0);
        if (!module) {
          detach(node);
          return false;
        }
        source.value = await module.source;
        if (source.value === BLOCKED_SCRIPT || !source.value.startsWith("data:text/javascript;")) {
          detach(node);
          return false;
        }
      } else {
        for (const child of node.childNodes) {
          if (defaultTreeAdapter.isTextNode(child))
            child.value = rewriteScript(child.value, documentPath, 0);
        }
      }
      return true;
    }
    for (const attribute of node.attrs) {
      const { name, value } = attribute;
      if (name === "style") {
        const wrapped = await rewriteCSS(`x{${value}}`, documentPath, []);
        attribute.value = wrapped.slice(2, -1);
      } else if (name === "srcset") {
        attribute.value = await rewriteSrcset(value);
      } else if (
        ["src", "poster", "background"].includes(name) ||
        (name === "href" && (isStylesheet || tag === "image"))
      ) {
        attribute.value = await asset(value, documentPath, isStylesheet, []);
      } else if (name === "href" && !value.trim().startsWith("#")) {
        const link = (tag === "a" || tag === "area") && secureLink(documentPath, value);
        attribute.value = "#";
        if (link) {
          const linkId = String(links.size);
          links.set(linkId, link);
          node.attrs.push({ name: FRAME_LINK_ATTRIBUTE, value: linkId });
        }
      }
    }
    if (tag === "style") {
      for (const child of node.childNodes) {
        if (defaultTreeAdapter.isTextNode(child))
          child.value = await rewriteCSS(child.value, documentPath, []);
      }
    }
    return true;
  }

  const document = parse(html);
  const root = document.childNodes.find(
    (node): node is Element => defaultTreeAdapter.isElementNode(node) && node.tagName === "html",
  );
  const head = root?.childNodes.find(
    (node): node is Element => defaultTreeAdapter.isElementNode(node) && node.tagName === "head",
  );
  if (!head) throw new Error("HTML document has no head");
  // Iterative walk keeps deeply nested authored HTML away from the JS stack.
  const parents: Parent[] = [document];
  for (let parent = parents.pop(); parent; parent = parents.pop()) {
    signal.throwIfAborted();
    for (const child of [...parent.childNodes]) {
      if (!defaultTreeAdapter.isElementNode(child) || !(await rewriteElement(child))) continue;
      parents.push(child);
      if ("content" in child) parents.push(defaultTreeAdapter.getTemplateContent(child));
    }
  }
  const first = head.childNodes[0];
  const imports: Record<string, string> = {};
  for (const module of modules.values()) {
    signal.throwIfAborted();
    imports[module.name] = await module.source;
  }
  const bridge = makeBridge(scriptNonce, bridgeToken);
  const importMap = modules.size
    ? `<script type="importmap" nonce="${scriptNonce}">${JSON.stringify({ imports })}</script>`
    : "";
  for (const node of [...parseFragment(bridge + importMap).childNodes]) {
    if (first) defaultTreeAdapter.insertBefore(head, node, first);
    else defaultTreeAdapter.appendChild(head, node);
  }
  const authorDocument = serialize(document);
  if (authorDocument.length > MAX_DOCUMENT_BYTES)
    throw new Error("HTML document exceeds its preview limit");
  const srcDoc = sandboxDocument(authorDocument, nonce, scriptNonce, bridgeToken);
  return { srcDoc, links };
}
