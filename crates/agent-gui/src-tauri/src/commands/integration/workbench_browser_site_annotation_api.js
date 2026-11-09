(() => {
  if (!isSecureContext || window !== window.top) return;
  const namespace = Object.getOwnPropertyDescriptor(document, "oai");
  if (namespace && (!("value" in namespace) || !namespace.value || typeof namespace.value !== "object")) return;
  const oai = namespace?.value ?? {};
  if (Object.hasOwn(oai, "annotation")) return;
  const controlsByTarget = new WeakMap();
  const declarations = (options) => {
    if (!options || !Array.isArray(options.controls) || options.controls.length > 12) throw new TypeError("Invalid annotation controls");
    const data = JSON.stringify(options.controls);
    if (data.length > 8192) throw new RangeError("Annotation controls exceed the maximum size");
    return data;
  };
  const targets = (elements) => {
    if (!Array.isArray(elements) || !elements.length || elements.length > 128 || !elements.every((element) => element instanceof HTMLElement && element.getRootNode() === document)) throw new TypeError("Invalid annotation control targets");
    return new Set(elements);
  };
  const api = Object.freeze({
    isActive() {
      return !!document.querySelector("[data-zeroagent-annotation-mode]");
    },
    request(element, options = {}) {
      if (!(element instanceof HTMLElement) || !element.isConnected || element.getRootNode() !== document || !navigator.userActivation?.isActive) return { accepted: false };
      const property = options && typeof options === "object" ? Object.getOwnPropertyDescriptor(options, "initialComment") : undefined;
      const initialComment = property && "value" in property && typeof property.value === "string" ? property.value.slice(0, 1200) : undefined;
      const event = new CustomEvent("codex:open-annotation", { bubbles: true, cancelable: true, detail: { initialComment } });
      return { accepted: !element.dispatchEvent(event) };
    },
    registerControls(options) {
      const registration = { data: declarations(options), elements: targets(options.targets) };
      let disposed = false;
      const clear = () => {
        for (const element of registration.elements) {
          if (controlsByTarget.get(element) === registration) controlsByTarget.delete(element);
        }
      };
      const assign = () => {
        for (const element of registration.elements) controlsByTarget.set(element, registration);
      };
      assign();
      return Object.freeze({
        update(next) {
          if (disposed) throw new TypeError("Annotation controls have been disposed");
          const data = next.controls === undefined ? registration.data : declarations(next);
          const elements = next.targets === undefined ? registration.elements : targets(next.targets);
          clear();
          Object.assign(registration, { data, elements });
          assign();
        },
        dispose() {
          disposed = true;
          clear();
        },
      });
    },
  });
  try {
    Object.defineProperty(oai, "annotation", { configurable: true, value: api });
    if (!namespace) Object.defineProperty(document, "oai", { configurable: true, value: oai });
    document.addEventListener("zeroagent:read-annotation-controls", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const entry = controlsByTarget.get(target);
      if (entry) target.dispatchEvent(new CustomEvent("zeroagent:annotation-controls", { detail: entry.data }));
    });
  } catch { /* Respect any pre-existing site integration. */ }
})();
