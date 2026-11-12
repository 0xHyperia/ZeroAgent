import { docxCoverDocument } from "./docxCoverDocument";
import { createDocxOutline, type DocxOutlineEntry } from "./docxOutline";
import { isolatedPreviewDocument } from "./previewPolicy";
import { COMMENT_CURSOR, COMMENT_PIN, READER_COMMENT_PREVIEW_DELAY } from "./readerInteraction";

export type DocumentAnchor = { id: string; page: number; text: string; kind?: "image" };
export type DocumentHeading = { id: string; title: string; level: number };
export type DocumentPage = { id: string; cover: string };
export type DocumentPageGeometry = { pageCount: number; pageWidth: number; pageHeight: number };
export type DocumentRegion = { left: number; top: number; width: number; height: number };
export type DocumentSelectionAnchor = { id: string; start: number; end: number };
export type DocumentSelection = {
  id: string;
  start: number;
  end: number;
  x: number;
  y: number;
  kind?: "image";
  region?: DocumentRegion;
  anchors?: DocumentSelectionAnchor[];
  document?: DocumentPageGeometry;
};

/** Application-owned code only. Opaque sandbox; no origin, network, files or host API. */
function readerBridge(
  token: string,
  validRegion: typeof validDocumentRegion,
  previewDelay: number,
) {
  const send = (value: object) => parent.postMessage({ token, ...value }, "*");
  let enabled = false;
  let canModify = false;
  let viewportTop = 0;
  let viewportHeight = innerHeight;
  let textClip: { left: number; top: number; right: number; bottom: number } | null = null;
  let lastHeight = 0;
  let editing = false;
  let editingCommentId = "";
  let tracked: { id: string; page: number; region?: DocumentRegion } | null = null;
  const position = () => {
    if (!tracked) return;
    const block = document.querySelector<HTMLElement>(`[data-reader-block="${tracked.id}"]`);
    const page = document.getElementById(`za-reader-page-${tracked.page}`);
    const box = (tracked.region ? page : block)?.getBoundingClientRect();
    if (!box) return;
    const region = tracked.region;
    const top = box.top + (region ? region.top * box.height : 0);
    const bottom = region ? top + region.height * box.height : box.bottom;
    send({
      type: "position",
      id: tracked.id,
      x: box.right - (region ? (1 - region.left - region.width) * box.width : 0),
      y: bottom,
      top,
      bottom,
    });
  };
  const measure = () => {
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      send({ type: "height", height });
    }
  };
  const publishPage = () => {
    let page = 1;
    for (const element of document.querySelectorAll<HTMLElement>("[data-reader-page]")) {
      if (element.getBoundingClientRect().top - viewportTop > viewportHeight * 0.45) break;
      page = Number(element.dataset.readerPage);
    }
    send({ type: "page", page });
    let heading = "";
    for (const element of document.querySelectorAll<HTMLElement>('[id^="za-reader-heading-"]')) {
      if (element.getBoundingClientRect().top - viewportTop > 96) break;
      heading = element.id;
    }
    if (!heading)
      heading = document.querySelector<HTMLElement>('[id^="za-reader-heading-"]')?.id ?? "";
    const currentPage = document.getElementById(`za-reader-page-${page}`);
    const headingPage = document
      .getElementById(heading)
      ?.closest<HTMLElement>("[data-reader-page]");
    if (Number(headingPage?.dataset.readerPage ?? 0) < page)
      heading =
        currentPage?.querySelector<HTMLElement>('[id^="za-reader-heading-"]')?.id || heading;
    if (heading) send({ type: "heading", id: heading });
  };
  document.addEventListener(
    "wheel",
    (event) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      send({
        type: "zoom",
        delta: Math.max(-100, Math.min(100, event.deltaY * (event.deltaMode === 1 ? 16 : 1))),
        x: event.clientX,
        y: event.clientY,
      });
    },
    { passive: false },
  );
  document.addEventListener("keydown", (event) => {
    if (
      !(event.ctrlKey || event.metaKey) ||
      event.altKey ||
      !["+", "=", "-", "0"].includes(event.key)
    )
      return;
    event.preventDefault();
    send(
      event.key === "0"
        ? { type: "zoom-reset" }
        : { type: "zoom", delta: event.key === "-" ? 18 : -18 },
    );
  });
  let pinchDistance = 0;
  const touchDistance = (event: TouchEvent) =>
    Math.hypot(
      event.touches[0].clientX - event.touches[1].clientX,
      event.touches[0].clientY - event.touches[1].clientY,
    );
  document.addEventListener(
    "touchstart",
    (event) => {
      if (event.touches.length !== 2) return;
      event.preventDefault();
      pinchDistance = touchDistance(event);
      drag = null;
      box.remove();
    },
    { passive: false },
  );
  document.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length !== 2 || pinchDistance <= 0) return;
      event.preventDefault();
      const distance = touchDistance(event);
      if (distance > 0)
        send({
          type: "zoom",
          delta: Math.max(-100, Math.min(100, Math.log(pinchDistance / distance) / 0.01)),
          x: (event.touches[0].clientX + event.touches[1].clientX) / 2,
          y: (event.touches[0].clientY + event.touches[1].clientY) / 2,
        });
      pinchDistance = distance;
    },
    { passive: false },
  );
  document.addEventListener("touchend", () => {
    pinchDistance = 0;
  });
  document.addEventListener("touchcancel", () => {
    pinchDistance = 0;
  });
  const noteIds = new WeakMap<Element, string>();
  let previewTimer = 0;
  let previewOpen = false;
  function hideTip() {
    clearTimeout(previewTimer);
    if (!previewOpen) return;
    previewOpen = false;
    send({ type: "comment-preview-close" });
  }
  function addCommentPin(mark: HTMLElement, item: { commentId: string; comment?: string }) {
    const id = item.commentId;
    noteIds.set(mark, id);
    const pin = document.createElement("button");
    pin.type = "button";
    pin.className = "za-reader-comment-pin";
    pin.setAttribute("aria-label", "编辑文档批注");
    if (typeof item.comment === "string")
      pin.setAttribute("aria-description", item.comment.slice(0, 2000));
    const showTip = () => {
      if (!canModify || editingCommentId === id || !pin.isConnected) return;
      const { x, y, width, height } = pin.getBoundingClientRect();
      previewOpen = true;
      send({ type: "comment-preview", id, x, y, width, height });
    };
    pin.addEventListener("pointerenter", (event) => {
      if (event.pointerType === "touch" || drag) return;
      clearTimeout(previewTimer);
      previewTimer = window.setTimeout(showTip, previewDelay);
    });
    pin.addEventListener("pointerleave", () => {
      if (!pin.matches(":focus-visible")) hideTip();
    });
    pin.addEventListener("focus", () => {
      if (pin.matches(":focus-visible")) showTip();
    });
    pin.addEventListener("blur", hideTip);
    pin.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!canModify) return;
      hideTip();
      send({ type: "edit-comment", id });
    });
    mark.append(pin);
  }
  const savedAnnotationAt = (event: MouseEvent, target: Element) =>
    [...document.querySelectorAll<HTMLElement>(".za-reader-saved-region")].find((element) => {
      const rect = element.getBoundingClientRect();
      return (
        event.clientX >= rect.left &&
        event.clientX <= rect.right + 12 &&
        event.clientY >= rect.top - 12 &&
        event.clientY <= rect.bottom
      );
    }) ?? target.closest("[data-commented]");
  const choose = (event: MouseEvent, target = event.target) => {
    if (
      !enabled ||
      !canModify ||
      !(target instanceof Element) ||
      target.closest(".za-reader-comment-pin")
    )
      return;
    const range = getSelection()?.rangeCount ? getSelection()?.getRangeAt(0) : null;
    const saved = savedAnnotationAt(event, target);
    const savedId = saved && noteIds.get(saved);
    if (savedId) {
      hideTip();
      send({ type: "edit-comment", id: savedId });
      return;
    }
    const block = target.closest<HTMLElement>("[data-reader-block]");
    if (!block) {
      const page = target.closest<HTMLElement>("[data-reader-page]");
      const paper = page?.getBoundingClientRect();
      if (!page || !paper?.width || !paper.height) return;
      send({
        type: "selection",
        id: page.id,
        start: 0,
        end: 0,
        x: event.clientX,
        y: event.clientY,
        pageWidth: paper.width,
        pageHeight: paper.height,
        region: {
          left: Math.max(0, Math.min(1, (event.clientX - paper.left) / paper.width)),
          top: Math.max(0, Math.min(1, (event.clientY - paper.top) / paper.height)),
          width: 0,
          height: 0,
        },
      });
      return;
    }
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
      end = block.dataset.readerText?.length ?? block.textContent?.length ?? 0;
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
    const paper = block.closest("[data-reader-page]")?.getBoundingClientRect();
    const region =
      paper?.width && paper.height
        ? {
            left: (rect.left - paper.left) / paper.width,
            top: (rect.top - paper.top) / paper.height,
            width: rect.width / paper.width,
            height: rect.height / paper.height,
          }
        : undefined;
    send({
      type: "selection",
      id: block.dataset.readerBlock,
      start,
      end: Math.min(end, start + 2000),
      x: rect.right,
      y: rect.bottom,
      pageWidth: paper?.width,
      pageHeight: paper?.height,
      ...(region && validRegion(region) ? { region } : {}),
    });
  };
  let selectingText: number | null = null;
  let selectionFrame = 0;
  let showingTextAction = false;
  function readTextSelection() {
    const selected = getSelection();
    if (
      enabled ||
      !canModify ||
      editing ||
      selectingText !== null ||
      !textClip ||
      !selected ||
      selected.isCollapsed ||
      selected.rangeCount !== 1
    )
      return null;
    const range = selected.getRangeAt(0);
    const paperAt = (node: Node) =>
      (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>(
        "[data-reader-page]",
      );
    const page = paperAt(range.startContainer);
    if (!page || page !== paperAt(range.endContainer)) return null;
    const paper = page.getBoundingClientRect();
    if (!paper.width || !paper.height) return null;
    const anchors: DocumentSelectionAnchor[] = [];
    let count = 0;
    for (const block of page.querySelectorAll<HTMLElement>(
      "[data-reader-block]:not([data-reader-kind])",
    )) {
      if (!range.intersectsNode(block)) continue;
      const part = document.createRange();
      part.selectNodeContents(block);
      if (part.compareBoundaryPoints(Range.START_TO_START, range) < 0)
        part.setStart(range.startContainer, range.startOffset);
      if (part.compareBoundaryPoints(Range.END_TO_END, range) > 0)
        part.setEnd(range.endContainer, range.endOffset);
      const text = part.toString();
      if (!text.length || !block.dataset.readerBlock) continue;
      const prefix = document.createRange();
      prefix.selectNodeContents(block);
      prefix.setEnd(part.startContainer, part.startOffset);
      const start = prefix.toString().length;
      count += text.length;
      if (anchors.length >= 20 || count > 2000) return null;
      anchors.push({ id: block.dataset.readerBlock, start, end: start + text.length });
    }
    const first = anchors[0];
    if (!first || !range.toString().trim()) return null;
    const backwards =
      selected.anchorNode === range.endContainer && selected.anchorOffset === range.endOffset;
    const clip = textClip;
    const rects = Array.from(range.getClientRects()).filter(
      (rect) =>
        rect.width > 0 &&
        rect.height > 0 &&
        rect.right > clip.left &&
        rect.left < clip.right &&
        rect.bottom > clip.top &&
        rect.top < clip.bottom,
    );
    const anchor = backwards ? rects[0] : rects.at(-1);
    if (!anchor) return null;
    const bounds = range.getBoundingClientRect();
    const left = Math.max(paper.left, bounds.left);
    const top = Math.max(paper.top, bounds.top);
    const region = {
      left: (left - paper.left) / paper.width,
      top: (top - paper.top) / paper.height,
      width: (Math.min(paper.right, bounds.right) - left) / paper.width,
      height: (Math.min(paper.bottom, bounds.bottom) - top) / paper.height,
    };
    if (!validRegion(region)) return null;
    return {
      ...first,
      ...(anchors.length > 1 ? { anchors } : {}),
      x: bounds.right,
      y: bounds.bottom,
      region,
      pageWidth: paper.width,
      pageHeight: paper.height,
      anchor: { x: anchor.left, y: anchor.top, width: anchor.width, height: anchor.height },
    };
  }
  function hideTextAction() {
    if (!showingTextAction) return;
    showingTextAction = false;
    send({ type: "text-selection-clear" });
  }
  function refreshTextAction() {
    if (selectionFrame) return;
    selectionFrame = requestAnimationFrame(() => {
      selectionFrame = 0;
      const selection = readTextSelection();
      if (!selection) {
        hideTextAction();
        return;
      }
      showingTextAction = true;
      send({ type: "text-selection", ...selection });
    });
  }
  document.addEventListener("selectionchange", refreshTextAction);
  document.addEventListener("pointerdown", (event) => {
    if (enabled || !canModify || event.button !== 0) return;
    selectingText = event.pointerId;
    hideTextAction();
  });
  const finishTextSelection = (event: PointerEvent) => {
    if (selectingText !== event.pointerId) return;
    selectingText = null;
    refreshTextAction();
  };
  document.addEventListener("pointerup", finishTextSelection);
  document.addEventListener("pointercancel", finishTextSelection);

  // Ordinary reading keeps text selection intact.
  document.addEventListener("click", (event) => {
    if (enabled || !canModify || !(event.target instanceof Element)) return;
    if (getSelection()?.isCollapsed === false) return;
    const mark = savedAnnotationAt(event, event.target);
    const id = mark && noteIds.get(mark);
    if (id && getSelection()?.isCollapsed !== false) {
      hideTip();
      send({ type: "edit-comment", id });
      return;
    }
    if (editing) return;
    const image = event.target.closest<HTMLElement>('[data-reader-kind="image"]');
    if (!image) {
      tracked = null;
      document.querySelectorAll("[data-active]").forEach((element) => {
        element.removeAttribute("data-active");
      });
      send({ type: "image-shortcut-clear" });
      return;
    }
    const rect = image.getBoundingClientRect();
    const paper = image.closest("[data-reader-page]")?.getBoundingClientRect();
    const region =
      paper?.width && paper.height
        ? {
            left: (rect.left - paper.left) / paper.width,
            top: (rect.top - paper.top) / paper.height,
            width: rect.width / paper.width,
            height: rect.height / paper.height,
          }
        : undefined;
    send({
      type: "image-shortcut",
      id: image.dataset.readerBlock,
      start: 0,
      end: image.dataset.readerText?.length ?? 0,
      x: rect.right,
      y: rect.bottom,
      pageWidth: paper?.width,
      pageHeight: paper?.height,
      ...(region && validRegion(region) ? { region } : {}),
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && canModify && !event.isComposing) {
      if (showingTextAction) {
        event.preventDefault();
        getSelection()?.removeAllRanges();
        hideTextAction();
        return;
      }
      if (previewOpen) {
        event.preventDefault();
        hideTip();
        return;
      }
      if (enabled || tracked) {
        event.preventDefault();
        if (!event.repeat) send({ type: "annotation-escape" });
      }
    }
    if (
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      event.key.toLowerCase() === "x" &&
      canModify
    ) {
      event.preventDefault();
      send({ type: "request-modification" });
    }
  });
  let drag: { x: number; y: number; page: HTMLElement; target: Element; moved: boolean } | null =
    null;
  let handledPointer = false;
  const box = document.createElement("div");
  box.className = "za-reader-region za-reader-region-drawing";
  document.addEventListener("pointerdown", (event) => {
    if (!enabled || event.button !== 0 || event.shiftKey || !(event.target instanceof Element))
      return;
    const page = event.target.closest<HTMLElement>("[data-reader-page]");
    if (!page || event.target.closest(".za-reader-comment-pin")) return;
    event.preventDefault();
    getSelection()?.removeAllRanges();
    drag = { x: event.clientX, y: event.clientY, page, target: event.target, moved: false };
    document.documentElement.setPointerCapture?.(event.pointerId);
  });
  document.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const rect = drag.page.getBoundingClientRect();
    const x = Math.max(rect.left, Math.min(rect.right, event.clientX)),
      y = Math.max(rect.top, Math.min(rect.bottom, event.clientY));
    if (Math.hypot(x - drag.x, y - drag.y) < 6 && !drag.moved) return;
    drag.moved = true;
    if (!box.isConnected) document.body.append(box);
    Object.assign(box.style, {
      left: `${Math.min(x, drag.x)}px`,
      top: `${Math.min(y, drag.y)}px`,
      width: `${Math.abs(x - drag.x)}px`,
      height: `${Math.abs(y - drag.y)}px`,
    });
  });
  document.addEventListener("pointerup", (event) => {
    const current = drag;
    drag = null;
    if (!current) return;
    handledPointer = true;
    if (!current.moved) {
      choose(event, current.target);
      return;
    }
    const rect = box.getBoundingClientRect(),
      paper = current.page.getBoundingClientRect();
    const anchors: DocumentSelectionAnchor[] = [];
    let budget = 2000;
    for (const block of current.page.querySelectorAll<HTMLElement>("[data-reader-block]")) {
      const bounds = block.getBoundingClientRect(),
        length = block.dataset.readerText?.length ?? block.textContent?.length ?? 0;
      if (
        length &&
        bounds.right > rect.left &&
        bounds.left < rect.right &&
        bounds.bottom > rect.top &&
        bounds.top < rect.bottom &&
        anchors.length < 20 &&
        budget > 0
      ) {
        const end = Math.min(length, budget);
        budget -= end;
        if (block.dataset.readerBlock)
          anchors.push({ id: block.dataset.readerBlock, start: 0, end });
      }
    }
    box.remove();
    send({
      type: "selection",
      ...(anchors.length ? { ...anchors[0], anchors } : { id: current.page.id, start: 0, end: 0 }),
      x: rect.right,
      y: rect.bottom,
      pageWidth: paper.width,
      pageHeight: paper.height,
      region: {
        left: (rect.left - paper.left) / paper.width,
        top: (rect.top - paper.top) / paper.height,
        width: rect.width / paper.width,
        height: rect.height / paper.height,
      },
    });
  });
  document.addEventListener("pointercancel", () => {
    drag = null;
    box.remove();
  });
  document.addEventListener("mouseup", (event) => {
    if (handledPointer) handledPointer = false;
    else if (event.button === 0) choose(event);
  });
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
    if (message.type === "capabilities" && typeof message.revision === "boolean") {
      canModify = message.revision;
      refreshTextAction();
    }
    if (message.type === "clear-text-selection") {
      getSelection()?.removeAllRanges();
      hideTextAction();
    }
    if (message.type === "confirm-text-selection" && typeof message.requestId === "string") {
      const selection = readTextSelection();
      if (selection)
        send({ type: "text-selection-confirmed", requestId: message.requestId, ...selection });
      else hideTextAction();
    }
    if (
      message.type === "navigate" &&
      typeof message.id === "string" &&
      /^za-reader-(?:page|block|heading)-\d+$/.test(message.id)
    ) {
      const element =
        document.getElementById(message.id) ??
        document.querySelector(`[data-reader-block="${message.id}"]`);
      if (element) {
        const page = element.closest("[data-reader-page]");
        const paper = page?.getBoundingClientRect();
        const top =
          paper && validRegion(message.region, true)
            ? paper.top + message.region.top * paper.height
            : element.getBoundingClientRect().top;
        send({ type: "navigate", top });
      }
    }
    if (
      message.type === "viewport" &&
      Number.isFinite(message.top) &&
      message.top >= 0 &&
      message.top <= 2000000 &&
      Number.isFinite(message.height) &&
      message.height > 0 &&
      message.height <= 100000
    ) {
      viewportTop = message.top;
      viewportHeight = message.height;
      const clip = message.textClip;
      textClip =
        clip &&
        [clip.left, clip.top, clip.right, clip.bottom].every(Number.isFinite) &&
        clip.right > clip.left &&
        clip.bottom > clip.top
          ? clip
          : null;
      publishPage();
      position();
      hideTip();
      refreshTextAction();
    }
    if (
      message.type === "layout" &&
      Number.isFinite(message.inset) &&
      message.inset >= 0 &&
      message.inset <= 512
    ) {
      document.documentElement.style.setProperty("--reader-content-inset", `${message.inset}px`);
      if (Number.isFinite(message.scale) && message.scale >= 0.01 && message.scale <= 4)
        document.documentElement.style.setProperty("--reader-scale", String(message.scale));
      measure();
      position();
      hideTip();
    }
    if (message.type === "annotate" && typeof message.enabled === "boolean") {
      enabled = message.enabled;
      if (enabled) getSelection()?.removeAllRanges();
      if (!enabled) {
        drag = null;
        box.remove();
      }
      document.body.toggleAttribute("data-annotating", enabled);
      document.querySelectorAll<HTMLElement>("[data-reader-block]").forEach((element) => {
        element.tabIndex = enabled ? 0 : -1;
      });
      selectingText = null;
      refreshTextAction();
    }
    if (message.type === "track") {
      editing = message.editing === true;
      editingCommentId = typeof message.commentId === "string" ? message.commentId : "";
      if (editing) hideTip();
      refreshTextAction();
      tracked =
        /^za-reader-(?:page|block)-\d+$/.test(message.id) &&
        Number.isSafeInteger(message.page) &&
        (!message.region || validRegion(message.region, true))
          ? { id: message.id, page: message.page, region: message.region }
          : null;
      document.querySelectorAll<HTMLElement>("[data-reader-block]").forEach((element) => {
        element.toggleAttribute(
          "data-active",
          (!tracked?.region || element.dataset.readerKind === "image") &&
            tracked?.id === element.dataset.readerBlock,
        );
      });
      position();
    }
    if (message.type === "marks" && Array.isArray(message.ids) && message.ids.length <= 400) {
      const ids = new Set(message.ids.filter((id: unknown) => typeof id === "string"));
      document.querySelectorAll<HTMLElement>("[data-reader-block]").forEach((element) => {
        element.toggleAttribute("data-commented", ids.has(element.dataset.readerBlock));
        const item =
          Array.isArray(message.items) && message.items.length <= 20
            ? message.items.find((item: { id?: string }) => item.id === element.dataset.readerBlock)
            : null;
        element.querySelector(":scope > .za-reader-comment-pin")?.remove();
        if (item && typeof item.commentId === "string") addCommentPin(element, item);
        else noteIds.delete(element);
      });
    }
    if (message.type === "regions" && Array.isArray(message.items) && message.items.length <= 21) {
      document.querySelectorAll(".za-reader-saved-region").forEach((item) => {
        item.remove();
      });
      for (const item of message.items) {
        if (!Number.isSafeInteger(item.page) || !validRegion(item.region, true)) continue;
        const page = document.getElementById(`za-reader-page-${item.page}`);
        if (!page) continue;
        const mark = document.createElement("div");
        mark.className = "za-reader-region za-reader-saved-region";
        mark.toggleAttribute("data-point", item.region.width === 0 && item.region.height === 0);
        page.style.position = "relative";
        Object.assign(mark.style, {
          left: `${item.region.left * 100}%`,
          top: `${item.region.top * 100}%`,
          width: `${item.region.width * 100}%`,
          height: `${item.region.height * 100}%`,
        });
        if (typeof item.commentId === "string") addCommentPin(mark, item);
        page.append(mark);
      }
    }
  });
  if (typeof ResizeObserver === "function") new ResizeObserver(measure).observe(document.body);
  measure();
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
    element.removeAttribute("data-reader-kind");
    element.removeAttribute("data-reader-text");
    element.removeAttribute("data-commented");
    element.removeAttribute("data-active");
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
  const papers = [...root.querySelectorAll<HTMLElement>("section.docx")];
  let coverBudget = 6000;
  const styles = [...root.querySelectorAll("style")].map((node) => node.outerHTML).join("");
  for (const [index, page] of papers.entries()) {
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
    for (const [imageIndex, image] of [
      ...page.querySelectorAll<HTMLImageElement>("img"),
    ].entries()) {
      if (blocks.length >= 20000) break;
      const wrapper = root.ownerDocument.createElement("span");
      const id = `za-reader-block-${blocks.length + 1}`;
      const caption =
        image.getAttribute("alt")?.trim() ||
        image.closest("p")?.nextElementSibling?.textContent?.trim() ||
        "";
      const text = `图片 ${imageIndex + 1}${caption ? `：${caption.slice(0, 160)}` : ""}`;
      wrapper.id = id;
      wrapper.dataset.readerBlock = id;
      wrapper.dataset.readerKind = "image";
      wrapper.dataset.readerText = text;
      image.before(wrapper);
      wrapper.append(image);
      blocks.push({ id, page: index + 1, text, kind: "image" });
    }
    if (index < 80) {
      const count = page.querySelectorAll("*").length;
      let cover = "";
      if (count <= coverBudget) {
        coverBudget -= count;
        cover = docxCoverDocument(styles, page);
      }
      pages.push({ id: page.id, cover });
    }
  }
  const token = crypto.randomUUID().replaceAll("-", "");
  const script = `(${readerBridge.toString()})(${JSON.stringify(token)},${validDocumentRegion.toString()},${READER_COMMENT_PREVIEW_DELAY})`;
  const css = `<style>
html,body{overflow:hidden;scrollbar-width:none}
body{padding:0!important}
.docx-wrapper{padding:var(--reader-content-inset,20px) 20px 20px!important}
body[data-annotating]{cursor:${COMMENT_CURSOR};user-select:text}
body[data-annotating] [data-reader-block]{position:relative;cursor:${COMMENT_CURSOR};outline:1px solid transparent;outline-offset:5px;border-radius:2px}
body[data-annotating] [data-reader-block]:is(:hover,:focus-visible):not(:has([data-reader-block]:hover)){outline-color:#3478df}
[data-reader-kind="image"]{display:inline-block;max-width:100%;line-height:0;position:relative}
[data-reader-kind="image"] img{max-width:100%}
[data-reader-kind="image"][data-active]{outline:1px dashed #3478df;outline-offset:3px}
body[data-annotating] [data-reader-block][data-active]{background:#3478df1a;outline:2px dashed #3478df;outline-offset:5px}
[data-reader-block][data-commented],body[data-annotating] [data-reader-block][data-commented]{position:relative;background:#3478df1a;outline:2px dashed #3478df;outline-offset:5px}
body[data-annotating] [data-reader-block][data-active]:not([data-commented]):after,.za-reader-region:not(:has(.za-reader-comment-pin)):after,.za-reader-comment-pin{content:'';position:absolute;right:calc(-12px / var(--reader-scale,1));top:calc(-12px / var(--reader-scale,1));width:calc(28px / var(--reader-scale,1));height:calc(28px / var(--reader-scale,1));background:${COMMENT_PIN} center/contain no-repeat;filter:drop-shadow(0 2px 2px #0002)}
.za-reader-comment-pin{padding:0;border:0;border-radius:50%;pointer-events:auto;cursor:pointer;transition:scale 150ms ease}
.za-reader-comment-pin:hover{scale:1.08}
.za-reader-comment-pin:focus-visible{outline:2px solid #3478df;outline-offset:1px}
@media(prefers-reduced-motion:reduce){.za-reader-comment-pin{transition:none}}
body[data-annotating] [data-reader-block][data-commented]:hover{outline-color:#2563eb;background:#3478df24}
.za-reader-region{position:absolute;border:2px dashed #3478df;background:#3478df1a;pointer-events:none;box-sizing:border-box;z-index:5}
.za-reader-region[data-point]{border:0;background:none}
.za-reader-region-drawing{position:fixed}
::selection{background:#b8d9fa}
</style>`;
  const source = isolatedPreviewDocument(
    `${css}${root.outerHTML}<script nonce="${token}">${script}</script>`,
    "document",
  ).replace("script-src 'none'", `script-src 'nonce-${token}'`);
  return { source, token, headings, pages, blocks, pageCount: papers.length };
}

export function checkedDocumentSelection(
  value: unknown,
  blocks: readonly DocumentAnchor[],
  pageCount = 0,
): (DocumentSelection & { quote: string; page: number }) | null {
  if (!value || typeof value !== "object") return null;
  const selection = value as DocumentSelection;
  const pageNumber =
    typeof selection.id === "string" && /^za-reader-page-([1-9]\d*)$/.exec(selection.id);
  if (pageNumber) {
    const page = Number(pageNumber[1]);
    if (
      page > pageCount ||
      selection.anchors !== undefined ||
      selection.start !== 0 ||
      selection.end !== 0 ||
      !validDocumentRegion(selection.region, true) ||
      ![selection.x, selection.y].every(
        (value) => Number.isFinite(value) && Math.abs(value) <= 100_000,
      )
    )
      return null;
    return {
      id: selection.id,
      start: 0,
      end: 0,
      x: selection.x,
      y: selection.y,
      quote: "",
      page,
      region: selection.region,
    };
  }
  if (selection.region !== undefined && !validDocumentRegion(selection.region)) return null;
  if (selection.anchors !== undefined) {
    if (
      !Array.isArray(selection.anchors) ||
      !selection.anchors.length ||
      selection.anchors.length > 20 ||
      !validDocumentRegion(selection.region)
    )
      return null;
    const candidates = selection.anchors.map((anchor) =>
      checkedDocumentSelection(
        { id: anchor?.id, start: anchor?.start, end: anchor?.end, x: selection.x, y: selection.y },
        blocks,
      ),
    );
    const anchors = candidates.filter(
      (anchor): anchor is NonNullable<typeof anchor> => anchor !== null,
    );
    const first = anchors[0];
    if (
      !first ||
      anchors.length !== candidates.length ||
      anchors.some((anchor) => anchor.page !== first.page)
    )
      return null;
    if (
      anchors.reduce((sum, anchor) => sum + anchor.quote.length, 0) > 2000 ||
      new Set(anchors.map((anchor) => anchor.id)).size !== anchors.length
    )
      return null;
    const quote = anchors
      .map((anchor) => anchor.quote)
      .join("\n")
      .slice(0, 2000);
    return {
      ...first,
      kind: undefined,
      quote,
      region: selection.region,
      anchors: anchors.map((anchor) => ({
        id: anchor.id,
        start: anchor.start,
        end: anchor.end,
      })),
    };
  }
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
    id: block.id,
    start: selection.start,
    end: selection.end,
    x: selection.x,
    y: selection.y,
    ...(selection.region ? { region: selection.region } : {}),
    ...(block.kind ? { kind: block.kind } : {}),
    quote: block.text.slice(selection.start, selection.end),
    page: block.page,
  };
}

export function validDocumentRegion(region: unknown, allowPoint = false): region is DocumentRegion {
  if (!region || typeof region !== "object") return false;
  const r = region as DocumentRegion;
  return (
    [r.left, r.top, r.width, r.height].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ) &&
    ((r.width > 0 && r.height > 0) || (allowPoint && r.width === 0 && r.height === 0)) &&
    r.left + r.width <= 1.001 &&
    r.top + r.height <= 1.001
  );
}
