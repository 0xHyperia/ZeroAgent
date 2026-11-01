import { createDocxOutline, type DocxOutlineEntry } from "./docxOutline";
import { isolatedPreviewDocument } from "./previewPolicy";

export type DocumentAnchor = { id: string; page: number; text: string };
export type DocumentHeading = { id: string; title: string; level: number };
export type DocumentPage = { id: string; cover: string };
export type DocumentSelection = { id: string; start: number; end: number; x: number; y: number };

/** Application-owned code only. Opaque sandbox; no origin, network, files or host API. */
function readerBridge(token: string) {
  const send = (value: object) => parent.postMessage({ token, ...value }, "*");
  let enabled = false;
  const choose = (event: MouseEvent) => {
    if (!enabled || !(event.target instanceof Element)) return;
    const block = event.target.closest<HTMLElement>("[data-reader-block]");
    if (!block) return;
    const range = getSelection()?.rangeCount ? getSelection()?.getRangeAt(0) : null;
    // Never replace a cross-paragraph selection with an unrelated whole block.
    if (
      range &&
      !range.collapsed &&
      (!block.contains(range.startContainer) || !block.contains(range.endContainer))
    )
      return;
    const prefix = document.createRange();
    prefix.selectNodeContents(block);
    let start = 0,
      end = block.textContent?.length ?? 0;
    if (
      range &&
      !range.collapsed &&
      block.contains(range.startContainer) &&
      block.contains(range.endContainer)
    ) {
      prefix.setEnd(range.startContainer, range.startOffset);
      start = prefix.toString().length;
      end = start + range.toString().length;
    }
    const rect =
      range && !range.collapsed ? range.getBoundingClientRect() : block.getBoundingClientRect();
    send({
      type: "selection",
      id: block.dataset.readerBlock,
      start,
      end: Math.min(end, start + 2000),
      x: rect.left,
      y: rect.bottom,
    });
  };
  document.addEventListener("mouseup", choose);
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Enter" &&
      enabled &&
      event.target instanceof HTMLElement &&
      event.target.hasAttribute("data-reader-block")
    )
      choose(event as unknown as MouseEvent);
  });
  window.addEventListener("message", (event) => {
    if (event.source !== parent || event.data?.token !== token) return;
    const message = event.data;
    if (
      message.type === "navigate" &&
      typeof message.id === "string" &&
      /^za-reader-(?:page|block|heading)-\d+$/.test(message.id)
    ) {
      (
        document.getElementById(message.id) ??
        document.querySelector(`[data-reader-block="${message.id}"]`)
      )?.scrollIntoView({
        block: "start",
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
    }
    if (message.type === "annotate" && typeof message.enabled === "boolean") {
      enabled = message.enabled;
      document.body.toggleAttribute("data-annotating", enabled);
      document.querySelectorAll<HTMLElement>("[data-reader-block]").forEach((element) => {
        element.tabIndex = enabled ? 0 : -1;
      });
    }
    if (message.type === "marks" && Array.isArray(message.ids) && message.ids.length <= 20) {
      const ids = new Set(message.ids.filter((id: unknown) => typeof id === "string"));
      document.querySelectorAll<HTMLElement>("[data-reader-block]").forEach((element) => {
        element.toggleAttribute("data-commented", ids.has(element.dataset.readerBlock));
      });
    }
  });
  let queued = false;
  document.addEventListener(
    "scroll",
    () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        let page = 1;
        for (const element of document.querySelectorAll<HTMLElement>("[data-reader-page]")) {
          if (element.getBoundingClientRect().top > innerHeight * 0.45) break;
          page = Number(element.dataset.readerPage);
        }
        send({ type: "page", page });
      });
    },
    { passive: true },
  );
  send({ type: "ready" });
}

/** Strip document-supplied authority before granting the single nonce script. */
export function prepareReaderDocument(root: HTMLElement, outline: readonly DocxOutlineEntry[]) {
  root
    .querySelectorAll("script,iframe,object,embed,link,meta,base,form,input,button,textarea,select")
    .forEach((element) => {
      element.remove();
    });
  for (const element of root.querySelectorAll("*")) {
    for (const attr of [...element.attributes]) {
      if (
        /^on/i.test(attr.name) ||
        ["srcdoc", "nonce", "formaction", "target", "href", "xlink:href"].includes(attr.name) ||
        (attr.name === "src" && !/^data:image\//i.test(attr.value))
      )
        element.removeAttribute(attr.name);
    }
    element.removeAttribute("data-reader-block");
    element.removeAttribute("data-reader-page");
    if (/^za-reader-/.test(element.id)) element.removeAttribute("id");
  }
  const nav = createDocxOutline(root, outline);
  const headings: DocumentHeading[] = [];
  for (const [index, link] of [
    ...(nav?.querySelectorAll<HTMLAnchorElement>("a") ?? []),
  ].entries()) {
    const destination = root.querySelector<HTMLElement>(
      `[id="${link.getAttribute("href")?.split("#")[1]}"]`,
    );
    if (!destination) continue;
    destination.id = `za-reader-heading-${index + 1}`;
    headings.push({
      id: destination.id,
      title: link.textContent ?? "",
      level: Number(link.parentElement?.style.getPropertyValue("--outline-level") ?? 0),
    });
  }
  const blocks: DocumentAnchor[] = [],
    pages: DocumentPage[] = [];
  let coverBudget = 6000;
  const styles = [...root.querySelectorAll("style")].map((node) => node.outerHTML).join("");
  for (const [index, page] of [...root.querySelectorAll<HTMLElement>("section.docx")].entries()) {
    page.id = `za-reader-page-${index + 1}`;
    page.dataset.readerPage = String(index + 1);
    for (const block of page.querySelectorAll<HTMLElement>("p")) {
      const text = block.textContent ?? "";
      if (!text.trim() || blocks.length >= 20000) continue;
      const id = `za-reader-block-${blocks.length + 1}`;
      // Preserve semantic heading IDs; block identity remains a separate attribute.
      if (!block.id) block.id = id;
      block.dataset.readerBlock = id;
      blocks.push({ id, page: index + 1, text });
    }
    if (index < 80) {
      const count = page.querySelectorAll("*").length;
      let cover = "";
      if (count <= coverBudget) {
        coverBudget -= count;
        cover = isolatedPreviewDocument(
          `${styles}<style>body{padding:0!important}.docx-wrapper{padding:0!important}.docx-wrapper>section.docx{margin:0!important;box-shadow:none!important}</style><div class="docx-wrapper">${page.outerHTML}</div>`,
          "document",
        );
      }
      pages.push({ id: page.id, cover });
    }
  }
  const token = crypto.randomUUID().replaceAll("-", "");
  const script = `(${readerBridge.toString()})(${JSON.stringify(token)})`;
  const css = `<style>html{scrollbar-width:thin;scrollbar-color:#c4c4c4 transparent}body{padding:0!important}.docx-wrapper{padding:20px!important}body[data-annotating] [data-reader-block]{position:relative;cursor:pointer;outline:1px dashed transparent;outline-offset:5px;border-radius:2px}body[data-annotating] [data-reader-block]:is(:hover,:focus-visible),[data-reader-block][data-commented]{outline:1px dashed #85b9ee;outline-offset:5px}body[data-annotating] [data-reader-block]:hover:after,[data-reader-block][data-commented]:after{content:'+';position:absolute;right:-26px;top:0;background:#e0ecff;border:1px solid #a6c9fa;border-radius:50%;width:21px;height:21px;text-align:center;font:16px/19px system-ui;color:#3478cf;pointer-events:none}::selection{background:#b8d9fa}</style>`;
  const source = isolatedPreviewDocument(
    `${css}${root.outerHTML}<script nonce="${token}">${script}</script>`,
    "document",
  ).replace("script-src 'none'", `script-src 'nonce-${token}'`);
  return { source, token, headings, pages, blocks };
}

export function checkedDocumentSelection(
  value: unknown,
  blocks: readonly DocumentAnchor[],
): (DocumentSelection & { quote: string; page: number }) | null {
  if (!value || typeof value !== "object") return null;
  const selection = value as DocumentSelection;
  const block = blocks.find((item) => item.id === selection.id);
  if (
    !block ||
    !Number.isSafeInteger(selection.start) ||
    !Number.isSafeInteger(selection.end) ||
    selection.start < 0 ||
    selection.end <= selection.start ||
    selection.end > block.text.length ||
    selection.end - selection.start > 2000 ||
    !Number.isFinite(selection.x) ||
    !Number.isFinite(selection.y) ||
    Math.abs(selection.x) > 100000 ||
    Math.abs(selection.y) > 100000
  )
    return null;
  return {
    ...selection,
    quote: block.text.slice(selection.start, selection.end),
    page: block.page,
  };
}
