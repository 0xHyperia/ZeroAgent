import { PLATFORM_BACK_EVENT } from "@liveagent/ui/lib/platformBack";

type TauriCore = {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
};

type TauriEvent = {
  listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
};

type MobileGatewayResponse = {
  status: number;
  headers?: Record<string, string>;
  body: string;
  cached?: boolean;
};

type MobileGatewayStreamItem =
  | { kind: "headers"; status: number; headers: Record<string, string> }
  | { kind: "chunk"; data: string };

const activeHttpStreams = new Set<() => void>();

type MobileGatewayMultipartPart = {
  name: string;
  value?: string;
  fileName?: string;
  contentType?: string;
  data?: string;
};

type MobileSafeAreaInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  imeBottom?: number;
  imeVisible?: boolean;
};

declare global {
  const __ZEROAGENT_EMBEDDED_MOBILE__: boolean;
  interface Window {
    __TAURI__?: {
      core?: TauriCore;
      event?: TauriEvent;
      app?: {
        onBackButtonPress(
          handler: (payload: { canGoBack: boolean }) => void,
        ): Promise<{ unregister(): Promise<void> }>;
      };
    };
    __ZEROAGENT_ANDROID__?: {
      getSafeAreaInsets(): string;
      moveTaskToBack(): void;
      getPendingOAuthCallback(): string | null;
      acknowledgeOAuthCallback(url: string): void;
    };
    __ZEROAGENT_NATIVE_INSETS__?: MobileSafeAreaInsets;
  }
}

export const MOBILE_BACK_EVENT = PLATFORM_BACK_EVENT;

let bootstrapped = false;
let socketSequence = 0;
const MOBILE_NATIVE_INSETS_EVENT = "zeroagent:native-insets";
const MOBILE_NATIVE_BACK_EVENT = "zeroagent:native-back";

let mobileSafeAreaBottom = 0;
let mobileImeBottom = 0;
let mobileImeVisible = false;
let mobileStableViewportHeight = 0;
let mobileViewportWidth = 0;

type NativeSocketEvent = {
  id: string;
  kind: "open" | "message" | "error" | "close";
  data?: string;
  message?: string;
};

type NativeSocketHandler = (event: NativeSocketEvent) => void;
const nativeSocketHandlers = new Map<string, NativeSocketHandler>();

export function isEmbeddedMobileRuntime() {
  return (
    typeof window !== "undefined" &&
    typeof __ZEROAGENT_EMBEDDED_MOBILE__ !== "undefined" &&
    __ZEROAGENT_EMBEDDED_MOBILE__ === true &&
    typeof window.__TAURI__?.core?.invoke === "function"
  );
}

function nativeInvoke<T>(command: string, args?: Record<string, unknown>) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) throw new Error("Android native bridge is unavailable");
  return invoke<T>(command, args);
}

function updateMobileViewport() {
  const viewport = window.visualViewport;
  const rawHeight = viewport?.height ?? window.innerHeight;
  const width = viewport?.width ?? window.innerWidth;
  const offsetTop = viewport?.offsetTop ?? 0;
  if (Math.abs(width - mobileViewportWidth) > 1) {
    mobileViewportWidth = width;
    mobileStableViewportHeight = 0;
  }

  const nativeKeyboardInset = mobileImeVisible
    ? Math.max(0, mobileImeBottom - mobileSafeAreaBottom)
    : 0;
  if (!mobileImeVisible) {
    mobileStableViewportHeight = Math.max(rawHeight + offsetTop, window.innerHeight);
  } else if (mobileStableViewportHeight <= 0) {
    mobileStableViewportHeight = Math.max(
      window.innerHeight,
      rawHeight + offsetTop + nativeKeyboardInset,
    );
  }
  const nativeViewportHeight = Math.max(0, mobileStableViewportHeight - nativeKeyboardInset);
  const height = mobileImeVisible ? Math.min(rawHeight, nativeViewportHeight) : rawHeight;
  const visualKeyboardInset = Math.max(0, mobileStableViewportHeight - rawHeight - offsetTop);
  const keyboardInset = Math.max(nativeKeyboardInset, visualKeyboardInset);
  const root = document.documentElement;
  root.style.setProperty("--zeroagent-visual-viewport-height", `${Math.round(height)}px`);
  root.style.setProperty("--zeroagent-visual-viewport-offset-top", `${Math.round(offsetTop)}px`);
  root.style.setProperty("--zeroagent-keyboard-inset", `${Math.round(keyboardInset)}px`);
  root.dataset.zeroagentKeyboard = keyboardInset >= 96 ? "open" : "closed";
}

function applyMobileSafeAreaInsets(value: Partial<MobileSafeAreaInsets> | undefined) {
  if (!value) return;
  const root = document.documentElement;
  for (const edge of ["top", "right", "bottom", "left"] as const) {
    const inset = Number(value[edge]);
    if (!Number.isFinite(inset)) continue;
    root.style.setProperty(`--zeroagent-safe-area-${edge}`, `${Math.max(0, Math.round(inset))}px`);
    if (edge === "bottom") mobileSafeAreaBottom = Math.max(0, inset);
  }
  mobileImeBottom = Math.max(0, Number(value.imeBottom) || 0);
  mobileImeVisible = value.imeVisible === true;
  updateMobileViewport();
}

function installMobileSafeAreaBridge() {
  try {
    const serialized = window.__ZEROAGENT_ANDROID__?.getSafeAreaInsets();
    applyMobileSafeAreaInsets(
      serialized
        ? (JSON.parse(serialized) as MobileSafeAreaInsets)
        : window.__ZEROAGENT_NATIVE_INSETS__,
    );
  } catch {
    applyMobileSafeAreaInsets(window.__ZEROAGENT_NATIVE_INSETS__);
  }
  window.addEventListener(MOBILE_NATIVE_INSETS_EVENT, (event) => {
    applyMobileSafeAreaInsets((event as CustomEvent<MobileSafeAreaInsets>).detail);
  });
}

function syncMobileThemeColor() {
  const dark = document.documentElement.classList.contains("dark");
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.append(meta);
  }
  meta.content = dark ? "#09090B" : "#FFFFFF";
}

export function handleMobileBack() {
  // Let Base UI dismiss its topmost layer through the same guarded Escape path
  // as a keyboard. A floating IME can keep reporting visible after a sheet opens;
  // blurring the sheet's focus in that state must not swallow every Back press.
  const overlay = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-open]:is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"])',
    ),
  ).at(-1);
  if (overlay) {
    // Touch-opened menus may leave focus on body. Dispatching there lets the
    // parent sheet consume the same Escape, closing two layers in one Back.
    const focused = document.activeElement;
    (focused && overlay.contains(focused) ? focused : overlay).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    return;
  }
  if (document.documentElement.dataset.zeroagentKeyboard === "open") {
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) activeElement.blur();
    return;
  }
  const handled = !window.dispatchEvent(new Event(MOBILE_BACK_EVENT, { cancelable: true }));
  if (!handled) window.__ZEROAGENT_ANDROID__?.moveTaskToBack();
}

export async function installMobileBackBridge() {
  window.addEventListener(MOBILE_NATIVE_BACK_EVENT, (nativeEvent) => {
    nativeEvent.preventDefault();
    handleMobileBack();
  });
  // Tauri's AppPlugin otherwise consumes Back with WebView.goBack before the
  // Activity fallback, bypassing page guards whenever history contains settings.
  const listen = window.__TAURI__?.app?.onBackButtonPress;
  if (listen) {
    const listener = await listen(() => handleMobileBack());
    window.addEventListener("pagehide", () => void listener.unregister(), { once: true });
  }
}

async function installMobileExperience() {
  document.documentElement.dataset.zeroagentPlatform = "android";
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  viewport?.setAttribute(
    "content",
    "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover",
  );
  installMobileSafeAreaBridge();
  updateMobileViewport();
  window.addEventListener("resize", updateMobileViewport, { passive: true });
  window.visualViewport?.addEventListener("resize", updateMobileViewport, { passive: true });
  window.visualViewport?.addEventListener("scroll", updateMobileViewport, { passive: true });
  syncMobileThemeColor();
  new MutationObserver(syncMobileThemeColor).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  await installMobileBackBridge();
}

function bytesToBase64(bytes: Uint8Array) {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(text);
}

function base64ToBytes(value: string) {
  const text = atob(value);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index);
  }
  return bytes;
}

function nextSocketId() {
  socketSequence += 1;
  return `mobile-${Date.now()}-${socketSequence}`;
}

function isNativeGatewaySocketURL(url: URL) {
  return url.pathname === "/ws/v2" || url.pathname.startsWith("/ws/v2/");
}

function installGatewayWebSocketBridge() {
  const eventApi = window.__TAURI__?.event;
  if (!eventApi) throw new Error("Android native event bridge is unavailable");
  const BrowserWebSocket = window.WebSocket;
  return eventApi
    .listen<NativeSocketEvent>("mobile-gateway-socket", ({ payload }) => {
      nativeSocketHandlers.get(payload.id)?.(payload);
    })
    .then(() => {
      class NativeGatewayWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;
        readonly CONNECTING = NativeGatewayWebSocket.CONNECTING;
        readonly OPEN = NativeGatewayWebSocket.OPEN;
        readonly CLOSING = NativeGatewayWebSocket.CLOSING;
        readonly CLOSED = NativeGatewayWebSocket.CLOSED;
        binaryType: BinaryType = "arraybuffer";
        readyState = NativeGatewayWebSocket.CONNECTING;
        onopen: ((event: Event) => void) | null = null;
        onclose: ((event: CloseEvent) => void) | null = null;
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null = null;
        private readonly id = nextSocketId();

        constructor(url: string | URL, protocols?: string | string[]) {
          const parsed = new URL(url.toString());
          const path = `${parsed.pathname}${parsed.search}`;
          const selectedProtocols = Array.isArray(protocols)
            ? protocols
            : typeof protocols === "string"
              ? [protocols]
              : [];
          nativeSocketHandlers.set(this.id, (event) => this.handleNativeEvent(event));
          void nativeInvoke("mobile_gateway_socket_connect", {
            request: { id: this.id, path, protocols: selectedProtocols },
          }).catch((cause) => this.fail(cause));
        }

        send(data: ArrayBuffer | ArrayBufferView) {
          if (this.readyState !== NativeGatewayWebSocket.OPEN) {
            throw new Error("Gateway WebSocket is not connected");
          }
          const bytes =
            data instanceof ArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          void nativeInvoke("mobile_gateway_socket_send", {
            request: { id: this.id, data: bytesToBase64(bytes) },
          }).catch((cause) => this.fail(cause));
        }

        close() {
          if (this.readyState === NativeGatewayWebSocket.CLOSED) return;
          this.readyState = NativeGatewayWebSocket.CLOSING;
          void nativeInvoke("mobile_gateway_socket_close", { id: this.id });
        }

        private handleNativeEvent(event: NativeSocketEvent) {
          if (event.kind === "open") {
            if (this.readyState !== NativeGatewayWebSocket.CONNECTING) return;
            this.readyState = NativeGatewayWebSocket.OPEN;
            this.onopen?.(new Event("open"));
            return;
          }
          if (event.kind === "message" && event.data) {
            const bytes = base64ToBytes(event.data);
            this.onmessage?.(new MessageEvent("message", { data: bytes.buffer }));
            return;
          }
          if (event.kind === "error") {
            this.onerror?.(new Event("error"));
            return;
          }
          if (event.kind === "close") {
            this.readyState = NativeGatewayWebSocket.CLOSED;
            nativeSocketHandlers.delete(this.id);
            this.onclose?.({
              code: 1000,
              wasClean: true,
              reason: event.message ?? "",
            } as CloseEvent);
          }
        }

        private fail(cause: unknown) {
          if (this.readyState === NativeGatewayWebSocket.CLOSED) return;
          this.onerror?.(new Event("error"));
          this.handleNativeEvent({
            id: this.id,
            kind: "close",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      const RoutedWebSocket = function (
        this: unknown,
        url: string | URL,
        protocols?: string | string[],
      ) {
        const parsed = new URL(url.toString(), window.location.href);
        if (!isNativeGatewaySocketURL(parsed)) {
          return protocols === undefined
            ? new BrowserWebSocket(url)
            : new BrowserWebSocket(url, protocols);
        }
        return new NativeGatewayWebSocket(parsed, protocols);
      } as unknown as typeof WebSocket;
      Object.defineProperties(RoutedWebSocket, {
        CONNECTING: { value: BrowserWebSocket.CONNECTING },
        OPEN: { value: BrowserWebSocket.OPEN },
        CLOSING: { value: BrowserWebSocket.CLOSING },
        CLOSED: { value: BrowserWebSocket.CLOSED },
      });
      window.WebSocket = RoutedWebSocket;
    });
}

function isGatewayRequest(input: RequestInfo | URL) {
  const value =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  try {
    return new URL(value, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function requestPath(input: RequestInfo | URL) {
  const value =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(value, window.location.href);
  return `${url.pathname}${url.search}`;
}

async function fetchGatewayStream(
  request: { path: string; method: string; headers: Record<string, string>; body: string },
  signal: AbortSignal | null | undefined,
) {
  const abortError = () =>
    signal?.reason ?? new DOMException("The request was aborted", "AbortError");
  if (signal?.aborted) throw abortError();
  let id: string | undefined;
  let closed = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  const closeNative = () => {
    if (id) void nativeInvoke("mobile_gateway_stream_close", { id }).catch(() => {});
  };
  const dispose = () => {
    closed = true;
    signal?.removeEventListener("abort", abort);
    activeHttpStreams.delete(abort);
    closeNative();
  };
  const abort = () => {
    if (closed) return;
    const reason = abortError();
    dispose();
    rejectAbort(reason);
    controller?.error(reason);
  };
  signal?.addEventListener("abort", abort, { once: true });
  activeHttpStreams.add(abort);
  try {
    const opening = nativeInvoke<string>("mobile_gateway_stream_open", { request });
    // Open only registers a native request. A late result after abort is immediately closed.
    void opening.then(
      (value) => {
        id = value;
        if (closed) closeNative();
      },
      () => {},
    );
    id = await Promise.race([opening, aborted]);
    const head = await Promise.race([
      nativeInvoke<MobileGatewayStreamItem | null>("mobile_gateway_stream_read", { id }),
      aborted,
    ]);
    if (!head || head.kind !== "headers") throw new Error("Gateway stream response is invalid");
    if ([204, 205, 304].includes(head.status)) {
      dispose();
      return new Response(null, { status: head.status, headers: head.headers });
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start(value) {
          controller = value;
        },
        async pull(value) {
          try {
            const item = await nativeInvoke<MobileGatewayStreamItem | null>(
              "mobile_gateway_stream_read",
              { id },
            );
            if (closed) return;
            if (item === null) {
              dispose();
              value.close();
            } else if (item.kind === "chunk") {
              value.enqueue(base64ToBytes(item.data));
            } else {
              throw new Error("Gateway stream chunk is invalid");
            }
          } catch (cause) {
            if (closed) return;
            dispose();
            value.error(cause);
          }
        },
        cancel() {
          dispose();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status: head.status, headers: head.headers });
  } catch (cause) {
    dispose();
    throw cause;
  }
}

export function installGatewayFetchBridge() {
  const browserFetch = window.fetch.bind(window);
  window.addEventListener("pagehide", () => {
    for (const abort of [...activeHttpStreams]) abort();
  });
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isGatewayRequest(input)) return browserFetch(input, init);

    const source = input instanceof Request ? input : undefined;
    const headers = new Headers(init?.headers ?? source?.headers);
    const method = init?.method ?? source?.method ?? "GET";
    const signal = init?.signal ?? source?.signal;
    if (signal?.aborted)
      throw signal.reason ?? new DOMException("The request was aborted", "AbortError");
    let body = init?.body;
    const streaming = headers
      .get("Accept")
      ?.split(",")
      .some(
        (type) =>
          type.split(";")[0].trim().toLowerCase() === "text/event-stream" ||
          (type.split(";")[0].trim().toLowerCase() === "application/octet-stream" &&
            requestPath(input).startsWith("/api/web-chat/")),
      );
    if (streaming) {
      if (body === undefined && source?.body) body = await source.clone().text();
      if (body !== undefined && body !== null && typeof body !== "string") {
        throw new TypeError("Gateway stream body must be text");
      }
      return fetchGatewayStream(
        {
          path: requestPath(input),
          method,
          headers: Object.fromEntries(headers.entries()),
          body: body ?? "",
        },
        signal,
      );
    }
    if (body instanceof FormData) {
      const parts: MobileGatewayMultipartPart[] = [];
      for (const [name, value] of body.entries()) {
        if (typeof value === "string") {
          parts.push({ name, value });
          continue;
        }
        parts.push({
          name,
          fileName: value.name,
          contentType: value.type,
          data: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
        });
      }
      const response = await nativeInvoke<MobileGatewayResponse>(
        "mobile_gateway_multipart_request",
        {
          request: {
            path: requestPath(input),
            method: init?.method ?? source?.method ?? "POST",
            headers: Object.fromEntries(headers.entries()),
            parts,
          },
        },
      );
      return new Response(response.body, {
        status: response.status,
        headers: response.headers,
      });
    }
    if (body !== undefined && typeof body !== "string") {
      return browserFetch(input, init);
    }
    const response = await nativeInvoke<MobileGatewayResponse>("mobile_gateway_request", {
      request: {
        path: requestPath(input),
        method,
        headers: Object.fromEntries(headers.entries()),
        body: body ?? "",
      },
    });
    const result = new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
    if (response.cached) result.headers.set("X-ZeroAgent-Cache", "hit");
    return result;
  };
}

export async function bootstrapEmbeddedMobileRuntime() {
  if (!isEmbeddedMobileRuntime() || bootstrapped) return;
  await installMobileExperience();
  await nativeInvoke("mobile_gateway_bootstrap");
  installGatewayFetchBridge();
  await installGatewayWebSocketBridge();
  bootstrapped = true;
}

export function mobileHaptic(duration = 12) {
  if (!isEmbeddedMobileRuntime() || typeof navigator.vibrate !== "function") return;
  navigator.vibrate(Math.max(1, Math.min(50, duration)));
}

export async function openEmbeddedExternalUrl(url: string) {
  if (!isEmbeddedMobileRuntime()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  await nativeInvoke("mobile_open_external_url", { url });
}

export async function clearEmbeddedMobileGatewaySession() {
  if (!isEmbeddedMobileRuntime()) return;
  for (const abort of [...activeHttpStreams]) abort();
  await nativeInvoke("mobile_gateway_logout");
}

export async function openEmbeddedOAuth(url: string): Promise<string> {
  if (!isEmbeddedMobileRuntime()) throw new Error("Android native bridge is unavailable");
  const events = window.__TAURI__?.event;
  if (!events) throw new Error("Android event bridge is unavailable");
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let unlisten: (() => void) | undefined;
    const timer = window.setTimeout(() => finish(new Error("授权已超时，请重试")), 5 * 60_000);
    const finish = (value: string | Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      unlisten?.();
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    void events
      .listen<string>("mobile-oauth-callback", ({ payload }) => finish(payload))
      .then((stop) => {
        unlisten = stop;
        return nativeInvoke("mobile_oauth_open", { url });
      })
      .catch((cause) => finish(cause instanceof Error ? cause : new Error(String(cause))));
  });
}

export async function getPendingEmbeddedOAuthCallback(): Promise<string | null> {
  if (!isEmbeddedMobileRuntime()) return null;
  return window.__ZEROAGENT_ANDROID__?.getPendingOAuthCallback()?.trim() || null;
}

export async function acknowledgeEmbeddedOAuthCallback(url: string): Promise<void> {
  if (!isEmbeddedMobileRuntime()) return;
  window.__ZEROAGENT_ANDROID__?.acknowledgeOAuthCallback(url);
}

export function isOfflineCacheResponse(response: Response) {
  return response.headers.get("X-ZeroAgent-Cache") === "hit";
}
