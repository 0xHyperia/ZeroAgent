((element, declaredControls, virtual, localStyles = false) => {
  if (!element?.isConnected || element.getRootNode() !== document || (!localStyles && !isSecureContext)) return null;
  let controls = [];
  const inline = new Map();
  if (localStyles) {
    if (!(element instanceof HTMLElement) || element.matches("html,body,iframe,input,textarea,select,[contenteditable]")) return null;
    const computed = getComputedStyle(element);
    const longhands = {
      padding: ["padding-top", "padding-right", "padding-bottom", "padding-left"],
      "border-radius": ["border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius"],
    };
    const add = (callback, label, type, value, unit = "", min = 0, max = 1, step = 0.05) => {
      if (type === "color" ? !value : !Number.isFinite(value) || value < min || value > max) return;
      controls.push({ callback, label, type, currentValue: value, min, max, step });
      const properties = (longhands[callback] ?? [callback]).map((name) => ({
        name, value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name),
      }));
      inline.set(callback, { properties, unit });
    };
    const hex = (value) => {
      const rgb = /^rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)$/.exec(value);
      if (!rgb || (rgb[4] && Number(rgb[4]) !== 1)) return null;
      return `#${rgb.slice(1, 4).map((value) => Number(value).toString(16).padStart(2, "0")).join("")}`;
    };
    const px = (value) => /^\d+(?:\.\d+)?px$/.test(value) ? Number.parseFloat(value) : NaN;
    add("color", "Text color", "color", hex(computed.color));
    add("background-color", "Background color", "color", hex(computed.backgroundColor) ?? "#ffffff");
    add("font-size", "Font size (px)", "range", px(computed.fontSize), "px", 1, 192, 1);
    add("font-weight", "Font weight", "range", Number(computed.fontWeight), "", 100, 900, 100);
    add("padding", "Padding (px)", "range", px(computed.padding), "px", 0, 128, 1);
    add("border-radius", "Corner radius (px)", "range", px(computed.borderRadius), "px", 0, 128, 1);
    add("opacity", "Opacity", "range", Number(computed.opacity));
  } else {
    try { controls = declaredControls ? JSON.parse(declaredControls) : []; } catch { /* Invalid site declaration. */ }
  }
  if (!Array.isArray(controls) || controls.length > 12) controls = [];
  const supported = new Map();
  for (const control of controls) {
    const { type, callback } = control ?? {};
    if (typeof callback !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(callback) || supported.has(callback)) continue;
    const color = (value) => typeof value === "string" && /^#[a-f0-9]{6}$/i.test(value);
    const finite = (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 10_000;
    let verify;
    let fallback;
    if (type === "toggle") {
      verify = (value) => typeof value === "boolean";
      fallback = false;
    } else if (type === "color") {
      verify = color;
      fallback = "#ffffff";
    } else if (type === "range" && [control.min, control.max, control.step].every(finite) && control.min < control.max && control.step >= 0.001 && control.step <= control.max - control.min) {
      verify = (value) => finite(value) && value >= control.min && value <= control.max;
      fallback = control.min;
    } else if (type === "select" && Array.isArray(control.options) && control.options.length > 0 && control.options.length <= 12) {
      const choices = new Set(control.options.map((option) => option?.value));
      if (choices.size !== control.options.length || ![...choices].every((value) => typeof value === "string" && value.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(value))) continue;
      verify = (value) => choices.has(value);
      fallback = control.options[0].value;
    } else {
      continue;
    }
    const initial = control.currentValue ?? control.defaultValue ?? fallback;
    if (verify(initial)) supported.set(callback, { initial, verify });
  }
  if (!supported.size && !virtual?.customRendering) return null;
  globalThis.__zaSiteAnnotationPreview?.close();
  const makeToken = () => {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  };
  const token = makeToken();
  const documentUrl = location.href;
  const virtualTarget = virtual ? { surfaceId: virtual.registrationId, targetId: virtual.id } : undefined;
  let customRendering = !!virtual?.customRendering;
  let disposed = false;
  let revision = 0;
  const active = new Map();
  const events = new AbortController();
  const validDocument = () => location.href === documentUrl && element.isConnected && element.getRootNode() === document;
  const dispatch = (callback, value, action) => {
    if (localStyles) {
      const original = inline.get(callback);
      if (action === "preview") element.style.setProperty(callback, `${value}${original.unit}`, "important");
      else {
        element.style.removeProperty(callback);
        for (const { name, value, priority } of original.properties) {
          if (value) element.style.setProperty(name, value, priority);
        }
      }
      return;
    }
    element.dispatchEvent(new CustomEvent("oaiannotationcontrolchange", {
      bubbles: true,
      detail: { callback, value, action, ...(virtualTarget ? { virtualTarget } : {}) },
    }));
  };
  const draw = (selectedId) => virtual.element.dispatchEvent(new CustomEvent("codex:annotation-surface-request", {
    bubbles: true,
    detail: JSON.stringify({ type: "render", registrationId: virtual.registrationId, hoveredId: null, selectedId }),
  }));
  const paint = () => new Promise((resolve) => {
    const fallback = setTimeout(resolve, 120);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(fallback); resolve(); }));
  });
  const close = (currentToken) => {
    if (disposed || (currentToken && currentToken !== token)) return;
    disposed = true;
    events.abort();
    if (element.isConnected && element.getRootNode() === document) {
      for (const [callback] of active) dispatch(callback, supported.get(callback).initial, "reset");
    }
    if (virtual?.customRendering && virtual.element.isConnected) draw(null);
    active.clear();
    if (globalThis.__zaSiteAnnotationPreview?.close === close) delete globalThis.__zaSiteAnnotationPreview;
  };
  globalThis.__zaSiteAnnotationPreview = {
    close,
    async apply(currentToken, nextRevision, changes, original) {
      if (disposed || currentToken !== token || !validDocument() || !Number.isSafeInteger(nextRevision) || nextRevision <= revision || !Array.isArray(changes) || changes.length > 12) return false;
      const next = new Map();
      for (const change of changes) {
        const control = supported.get(change.callback);
        if (!control?.verify(change.value) || next.has(change.callback)) return false;
        if (change.value !== control.initial) next.set(change.callback, change.value);
      }
      revision = nextRevision;
      for (const [callback] of active) {
        if (!next.has(callback)) dispatch(callback, supported.get(callback).initial, "reset");
      }
      for (const [callback, proposed] of next) {
        const value = original ? supported.get(callback).initial : proposed;
        const action = original ? "preview-original" : "preview";
        const previous = active.get(callback);
        if (previous?.value !== value || previous?.action !== action) dispatch(callback, value, action);
        next.set(callback, { value, action });
      }
      active.clear();
      for (const [callback, update] of next) active.set(callback, update);
      await paint();
      return !disposed && validDocument() && revision === nextRevision;
    },
  };
  window.addEventListener("pagehide", () => close(), { once: true, signal: events.signal });
  if (customRendering) {
    document.addEventListener("codex:annotation-surface-response", (event) => {
      if (event.target !== virtual.element || typeof event.detail !== "string" || event.detail.length > 8192) return;
      try {
        const response = JSON.parse(event.detail);
        if (response?.registrationId !== virtual.registrationId) return;
        if (response.type === "rendering-failed" || response.type === "invalidated" || response.type === "disposed") customRendering = false;
      } catch { /* Invalid site message. */ }
    }, { signal: events.signal, capture: true });
    draw(virtual.id);
  }
  return { token, controls: localStyles ? JSON.stringify(controls) : undefined, renderReady: async () => { await paint(); return customRendering; } };
})
