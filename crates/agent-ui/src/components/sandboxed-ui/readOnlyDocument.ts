import { type DefaultTreeAdapterMap, parse, parseFragment, serialize } from "parse5";

const BLOCKED = new Set([
  "applet",
  "base",
  "embed",
  "fencedframe",
  "form",
  "frame",
  "frameset",
  "iframe",
  "link",
  "meta",
  "noscript",
  "object",
  "portal",
  "script",
  "template",
  "animate",
  "animatetransform",
  "animatemotion",
  "discard",
  "set",
  "foreignobject",
]);
const ACTIVE_ATTR = new Set([
  "action",
  "attributionsrc",
  "autofocus",
  "background",
  "contenteditable",
  "data",
  "download",
  "formaction",
  "href",
  "ping",
  "poster",
  "src",
  "srcdoc",
  "srcset",
  "target",
]);
const MEDIA_DATA =
  /^data:(?:image\/(?:avif|bmp|gif|jpeg|png|svg\+xml|webp|x-icon)|audio\/(?:mpeg|ogg|wav)|video\/(?:mp4|ogg|webm));base64,[a-z0-9+/=]+$/i;
const POLICY =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";

export function buildReadOnlyDeviceUiDocument(html: string): string {
  if (html.length > 5 * 1024 * 1024) throw new Error("DEVICE_UI_DOCUMENT_TOO_LARGE");
  const document = parse(html, { scriptingEnabled: false });
  const pending: DefaultTreeAdapterMap["parentNode"][] = [document];
  let head: DefaultTreeAdapterMap["element"] | undefined;
  for (const parent of pending) {
    parent.childNodes = parent.childNodes.filter((node) => {
      if (!("tagName" in node)) return true;
      const tag = node.tagName.toLowerCase();
      if (BLOCKED.has(tag)) return false;
      if (!head && tag === "head" && node.namespaceURI === "http://www.w3.org/1999/xhtml") {
        head = node;
      }
      node.attrs = node.attrs.filter(({ name, value }) => {
        const key = name.toLowerCase();
        if (key === "src" || key === "poster") {
          return (
            ["img", "image", "audio", "video", "source"].includes(tag) && MEDIA_DATA.test(value)
          );
        }
        return !key.startsWith("on") && !ACTIVE_ATTR.has(key);
      });
      pending.push(node);
      return true;
    });
  }
  if (!head) throw new Error("DEVICE_UI_DOCUMENT_INVALID");
  const policy = parseFragment(
    head,
    `<meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${POLICY}"><style>html{color-scheme:light dark;overflow-wrap:anywhere}img,video{max-width:100%}</style>`,
    {},
  );
  head.childNodes = [...policy.childNodes, ...head.childNodes];
  return serialize(document);
}
