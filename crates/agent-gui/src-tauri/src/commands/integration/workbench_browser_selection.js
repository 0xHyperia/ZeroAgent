((allowSiteFeatures, startSitePreview) => {
  globalThis.__zaStopSelection?.();
  return new Promise((finish) => {
    const siteFeatures = allowSiteFeatures && isSecureContext;
    const host = document.createElement("div");
    if (siteFeatures) host.dataset.zeroagentAnnotationMode = "";
    const shadow = host.attachShadow({ mode: "closed" });
    const surface = document.createElement("div");
    const outline = document.createElement("div");
    const listeners = new AbortController();
    const options = { signal: listeners.signal, capture: true };
    let origin = null;
    let paused = false;
    let ended = false;
    let finishing = false;
    let surfaceHit = null;
    let hoverPoint = null;
    let hoveredVirtual = null;
    let hoverFrame = 0;
    const surfaces = new WeakMap();

    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;";
    surface.style.cssText = "position:absolute;inset:0;cursor:crosshair;pointer-events:auto;touch-action:none;";
    outline.style.cssText = "position:absolute;box-sizing:border-box;display:none;pointer-events:none;border:1px solid #3b82f6;background:#3b82f624;border-radius:3px;";
    shadow.append(surface, outline);
    document.documentElement.append(host);

    const end = (selection = null) => {
      if (ended) return;
      ended = true;
      clearHover();
      surfaceHit?.finish(null);
      listeners.abort();
      clearTimeout(timeout);
      host.remove();
      delete globalThis.__zaStopSelection;
      finish(selection);
    };
    const timeout = setTimeout(end, 5 * 60 * 1000);
    globalThis.__zaStopSelection = end;

    const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));
    const point = (event) => ({
      x: clamp(event.clientX, innerWidth),
      y: clamp(event.clientY, innerHeight),
    });
    const bounds = (start, endPoint) => ({
      x: Math.min(start.x, endPoint.x),
      y: Math.min(start.y, endPoint.y),
      width: Math.abs(start.x - endPoint.x),
      height: Math.abs(start.y - endPoint.y),
    });
    const pageElement = ({ x, y }) => {
      surface.style.pointerEvents = "none";
      const element = document.elementFromPoint(x, y);
      surface.style.pointerEvents = paused ? "none" : "auto";
      return element === host ? null : element;
    };
    const siteTarget = (element) => {
      if (!siteFeatures || element?.getRootNode() !== document) return null;
      while (element && element !== document.body && element !== document.documentElement) {
        if (element.hasAttribute("oai-annotation-container-text") || element.hasAttribute("oai-annotatable")) return element;
        if (element.hasAttribute("oai-annotation-container")) break;
        element = element.parentElement;
      }
      return null;
    };
    const siteContext = (element) => {
      if (!element || !siteFeatures) return {};
      const raw = element.getAttribute("oai-annotation-metadata");
      let metadata;
      try { if (raw && raw.length <= 4096) metadata = JSON.parse(raw); } catch { /* Invalid site metadata. */ }
      return {
        siteLabel: (element.getAttribute("oai-annotatable") || element.getAttribute("aria-label") || "").trim().slice(0, 120),
        siteMetadata: encodeMetadata(metadata),
      };
    };
    function encodeMetadata(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const entries = Object.entries(value).slice(0, 8).filter(([key, item]) => key.length <= 80 && (item === null || ["string", "number", "boolean"].includes(typeof item)));
      return entries.length ? JSON.stringify(Object.fromEntries(entries.map(([key, item]) => [key, typeof item === "string" ? item.slice(0, 128) : item]))) : undefined;
    }
    function readControls(element) {
      for (let node = element, depth = 0; node && node !== document.body && depth < 24; node = node.parentElement, depth++) {
        let data;
        const receive = (event) => {
          if (event.target === node && typeof event.detail === "string" && event.detail.length <= 8192) data = event.detail;
        };
        node.addEventListener("zeroagent:annotation-controls", receive);
        try { node.dispatchEvent(new CustomEvent("zeroagent:read-annotation-controls", { bubbles: true })); }
        finally { node.removeEventListener("zeroagent:annotation-controls", receive); }
        if (data) return { node, data };
      }
    }
    async function selected(marker, element, virtual) {
      if (finishing || ended) return;
      finishing = true;
      const declaration = siteFeatures ? readControls(virtual?.element || element) : null;
      const websitePreview = siteFeatures ? startSitePreview?.(declaration?.node || virtual?.element || element, declaration?.data, virtual) : null;
      const stylePreview = !websitePreview && !virtual ? startSitePreview?.(element, null, null, true) : null;
      const live = websitePreview || stylePreview;
      const siteCustomRender = !!websitePreview && await websitePreview.renderReady();
      if (ended) {
        if (live) globalThis.__zaSiteAnnotationPreview?.close(live.token);
        return;
      }
      end({ ...marker, siteControls: stylePreview?.controls ?? declaration?.data, sitePreviewToken: live?.token, siteCustomRender, localStylePreview: !!stylePreview });
    }
    const surfaceEvent = (target, detail) => target.dispatchEvent(new CustomEvent("codex:annotation-surface-request", { bubbles: true, detail: JSON.stringify(detail) }));
    const surfaceAt = (element) => {
      for (let node = element; node && node !== document.body; node = node.parentElement) {
        if (surfaces.has(node)) return node;
      }
      return null;
    };
    const readSurface = (element, point, kind = "select") => {
      const target = surfaceAt(element);
      const registration = target && surfaces.get(target);
      if (!target || !registration) return Promise.resolve(null);
      const requestId = crypto.randomUUID();
      const rect = target.getBoundingClientRect();
      return new Promise((resolve) => {
        const finish = (result) => {
          clearTimeout(timer);
          surfaceHit = null;
          resolve(result);
        };
        const timer = setTimeout(() => finish(null), 250);
        surfaceHit = { target, registrationId: registration.id, requestId, point, rect, finish, kind };
        surfaceEvent(target, { type: "hit-test", registrationId: registration.id, requestId, ...point });
      });
    };
    function listenForSurfaces(event) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target instanceof HTMLIFrameElement || target.getRootNode() !== document || target === host || !target.isConnected || typeof event.detail !== "string" || event.detail.length > 8192) return;
      let response;
      try { response = JSON.parse(event.detail); } catch { return; }
      const registrationId = response?.registrationId;
      if (typeof registrationId !== "string" || !registrationId.length || registrationId.length > 128) return;
      if (response.type === "registered") {
        if (hoveredVirtual?.element === target && hoveredVirtual.registrationId !== registrationId) clearHover();
        surfaces.set(target, { id: registrationId, customRendering: response.customRendering === true });
        return;
      }
      const registration = surfaces.get(target);
      if (registration?.id !== registrationId) return;
      if (response.type === "rendering-failed") registration.customRendering = false;
      if (response.type === "disposed") surfaces.delete(target);
      if (["rendering-failed", "disposed", "invalidated"].includes(response.type) && hoveredVirtual?.element === target) {
        clearHover();
        draw(target.getBoundingClientRect());
      }
      const pending = surfaceHit;
      if (!pending || pending.target !== target || pending.registrationId !== registrationId) return;
      if (response.type === "invalidated" || response.type === "disposed") { pending.finish(null); return; }
      if (response.type !== "result" || response.requestId !== pending.requestId) return;
      const rect = target.getBoundingClientRect();
      const hit = response.hit;
      if (!hit || typeof hit.id !== "string" || !hit.id.length || hit.id.length > 128 || ["x", "y", "width", "height"].some((axis) => rect[axis] !== pending.rect[axis]) || surfaceAt(pageElement(pending.point)) !== target) { pending.finish(null); return; }
      const proposed = hit.rect;
      let clipped;
      if (proposed && [proposed.x, proposed.y, proposed.width, proposed.height].every(Number.isFinite)) {
        const left = Math.max(0, rect.left, proposed.x);
        const right = Math.min(innerWidth, rect.right, proposed.x + proposed.width);
        const top = Math.max(0, rect.top, proposed.y);
        const bottom = Math.min(innerHeight, rect.bottom, proposed.y + proposed.height);
        if (left < right && top < bottom && pending.point.x >= left && pending.point.x <= right && pending.point.y >= top && pending.point.y <= bottom) clipped = { x: left / innerWidth, y: top / innerHeight, width: (right - left) / innerWidth, height: (bottom - top) / innerHeight };
      }
      pending.finish({
        marker: { ...clipped, target: `${describe(target)} · ${hit.id}`, siteLabel: typeof hit.name === "string" ? hit.name.slice(0, 120) : undefined, siteMetadata: encodeMetadata(hit.metadata) },
        virtual: { element: target, registrationId, id: hit.id, customRendering: registration.customRendering },
      });
    }
    function renderHover(target, hoveredId) {
      if (target.element.isConnected) surfaceEvent(target.element, { type: "render", registrationId: target.registrationId, hoveredId, selectedId: null });
    }
    function clearRenderedHover() {
      const target = hoveredVirtual;
      hoveredVirtual = null;
      if (target) renderHover(target, null);
    }
    function clearHover() {
      hoverPoint = null;
      cancelAnimationFrame(hoverFrame);
      hoverFrame = 0;
      if (surfaceHit?.kind === "hover") surfaceHit.finish(null);
      clearRenderedHover();
    }
    function scheduleHover() {
      if (hoverFrame || surfaceHit || !hoverPoint) return;
      hoverFrame = requestAnimationFrame(async () => {
        hoverFrame = 0;
        const current = hoverPoint;
        if (!current || ended || paused || origin || surfaceHit) return;
        const element = pageElement(current);
        const virtualHit = await readSurface(element, current, "hover");
        if (current !== hoverPoint || ended || origin || paused) { scheduleHover(); return; }
        const target = virtualHit?.virtual;
        if (hoveredVirtual?.element === target?.element && hoveredVirtual?.id === target?.id && target?.customRendering) return;
        clearRenderedHover();
        if (target?.customRendering) {
          hoveredVirtual = target;
          draw(null);
          renderHover(target, target.id);
        } else {
          draw((siteTarget(element) || element)?.getBoundingClientRect());
        }
      });
    }
    const caret = ({ x, y }, element) => {
      if (!element?.hasAttribute("oai-annotation-container-text")) return null;
      if (element.matches("input, textarea, select, [contenteditable]") || element.closest("[contenteditable]")) return null;
      surface.style.pointerEvents = "none";
      const range = document.caretRangeFromPoint(x, y);
      surface.style.pointerEvents = paused ? "none" : "auto";
      return range && element.contains(range.startContainer) ? range : null;
    };
    const textQuote = (start, endPoint, element) => {
      const first = start.caret;
      const last = first && caret(endPoint, element);
      if (!last) return "";
      const range = document.createRange();
      range.setStart(first.startContainer, first.startOffset);
      range.setEnd(last.startContainer, last.startOffset);
      if (range.collapsed) {
        range.setStart(last.startContainer, last.startOffset);
        range.setEnd(first.startContainer, first.startOffset);
      }
      if (Array.from(element.querySelectorAll("input, textarea, select, [contenteditable]")).some((field) => range.intersectsNode(field))) return "";
      return range.toString().trim().slice(0, 1400);
    };
    const draw = (rect) => {
      outline.style.display = rect ? "block" : "none";
      if (!rect) return;
      outline.style.left = `${rect.x}px`;
      outline.style.top = `${rect.y}px`;
      outline.style.width = `${rect.width}px`;
      outline.style.height = `${rect.height}px`;
    };
    const describe = (element) => {
      if (!element) return "";
      const name = (value) => value.slice(0, 64).replace(/[^\p{L}\p{N}_:-]/gu, "");
      const id = name(element.id);
      const classes = Array.from(element.classList).slice(0, 2).map(name).filter(Boolean);
      return [name(element.localName), id && `#${id}`, ...classes.map((item) => `.${item}`)].join("");
    };

    surface.addEventListener("pointerdown", (event) => {
      if (!event.isTrusted || event.button !== 0 || !event.isPrimary || paused || origin || finishing || surfaceHit?.kind === "select") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clearHover();
      const start = point(event);
      const target = siteTarget(pageElement(start));
      origin = { ...start, id: event.pointerId, target, caret: caret(start, target) };
      surface.setPointerCapture(event.pointerId);
      draw(null);
    }, options);
    surface.addEventListener("pointermove", (event) => {
      if (!event.isTrusted || paused || finishing) return;
      const current = point(event);
      if (origin) {
        if (event.pointerId === origin.id) draw(bounds(origin, current));
        return;
      }
      const element = pageElement(current);
      if (siteFeatures && surfaceAt(element)) {
        hoverPoint = current;
        scheduleHover();
        return;
      }
      clearHover();
      const rect = (siteTarget(element) || element)?.getBoundingClientRect();
      draw(rect);
    }, options);
    surface.addEventListener("pointerup", async (event) => {
      if (!event.isTrusted || !origin || event.pointerId !== origin.id || paused) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const current = point(event);
      const rect = bounds(origin, current);
      const width = innerWidth;
      const height = innerHeight;
      if (width <= 0 || height <= 0) return end();
      if (rect.width >= 5 && rect.height >= 5) {
        const target = origin.target;
        const selectedText = textQuote(origin, current, target);
        await selected({ x: rect.x / width, y: rect.y / height, width: rect.width / width, height: rect.height / height, ...(selectedText ? { ...siteContext(target), selectedText } : {}) }, selectedText ? target : null);
      } else {
        const element = pageElement(current);
        const target = siteTarget(element);
        origin = null;
        const hit = siteFeatures ? await readSurface(element, current) : null;
        if (ended) return;
        await selected({ x: current.x / width, y: current.y / height, target: describe(target || element), ...siteContext(target || element), ...hit?.marker }, target || element, hit?.virtual);
      }
    }, options);
    if (siteFeatures) {
      document.addEventListener("codex:annotation-surface-response", listenForSurfaces, options);
      surfaceEvent(document, { type: "list" });
      document.addEventListener("codex:open-annotation", (event) => {
        const element = event.target;
        if (origin || surfaceHit || finishing || !navigator.userActivation?.isActive || !(element instanceof HTMLElement) || element.getRootNode() !== document || !element.isConnected) return;
        const rect = element.getBoundingClientRect();
        const left = clamp(rect.left, innerWidth);
        const right = clamp(rect.right, innerWidth);
        const top = clamp(rect.top, innerHeight);
        const bottom = clamp(rect.bottom, innerHeight);
        if (right <= left || bottom <= top || !innerWidth || !innerHeight) return;
        const descriptor = event.detail && Object.getOwnPropertyDescriptor(event.detail, "initialComment");
        const comment = descriptor && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value.slice(0, 1200) : undefined;
        event.preventDefault();
        void selected({ x: (left + right) / 2 / innerWidth, y: (top + bottom) / 2 / innerHeight, target: describe(element), ...siteContext(siteTarget(element)), siteSuggestedComment: comment }, element);
      }, options);
    }
    surface.addEventListener("pointercancel", () => { origin = null; draw(null); }, options);
    window.addEventListener("resize", () => { origin = null; clearHover(); draw(null); }, options);
    surface.addEventListener("pointerleave", clearHover, options);
    window.addEventListener("blur", () => {
      paused = false;
      origin = null;
      clearHover();
      surface.style.pointerEvents = "auto";
      draw(null);
    }, options);
    window.addEventListener("keydown", (event) => {
      if (!event.isTrusted) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        end();
      } else if (event.code === "Space" && !event.repeat && !origin) {
        event.preventDefault();
        event.stopImmediatePropagation();
        paused = true;
        clearHover();
        surface.style.pointerEvents = "none";
        draw(null);
      }
    }, options);
    window.addEventListener("keyup", (event) => {
      if (event.isTrusted && event.code === "Space" && paused) {
        event.preventDefault();
        event.stopImmediatePropagation();
        paused = false;
        surface.style.pointerEvents = "auto";
      }
    }, options);
  });
})
