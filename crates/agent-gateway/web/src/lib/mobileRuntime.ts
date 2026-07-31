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

type MobileSafeAreaInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

declare global {
  const __ZEROAGENT_EMBEDDED_MOBILE__: boolean;
  interface Window {
    __TAURI__?: { core?: TauriCore; event?: TauriEvent };
    __ZEROAGENT_ANDROID__?: { getSafeAreaInsets(): string };
    __ZEROAGENT_NATIVE_INSETS__?: MobileSafeAreaInsets;
  }
}

export const MOBILE_BACK_EVENT = "zeroagent:mobile-back";
export const MOBILE_EXIT_HINT_EVENT = "zeroagent:mobile-exit-hint";

let bootstrapped = false;
let socketSequence = 0;
let lastUnhandledBackAt = 0;

const MOBILE_HISTORY_GUARD = "zeroagent-mobile-history-guard";
const MOBILE_NATIVE_INSETS_EVENT = "zeroagent:native-insets";

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
  const height = viewport?.height ?? window.innerHeight;
  const offsetTop = viewport?.offsetTop ?? 0;
  const keyboardInset = Math.max(0, window.innerHeight - height - offsetTop);
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
  }
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

function armMobileHistoryGuard() {
  const state =
    window.history.state && typeof window.history.state === "object" ? window.history.state : {};
  if (state[MOBILE_HISTORY_GUARD]) return;
  window.history.pushState({ ...state, [MOBILE_HISTORY_GUARD]: true }, "", window.location.href);
}

function installMobileBackBridge() {
  armMobileHistoryGuard();
  window.addEventListener("popstate", () => {
    const handled = !window.dispatchEvent(new Event(MOBILE_BACK_EVENT, { cancelable: true }));
    if (handled) {
      lastUnhandledBackAt = 0;
      armMobileHistoryGuard();
      return;
    }

    const now = Date.now();
    if (now - lastUnhandledBackAt <= 2_000) {
      void nativeInvoke("mobile_app_exit");
      return;
    }
    lastUnhandledBackAt = now;
    window.dispatchEvent(new Event(MOBILE_EXIT_HINT_EVENT));
    armMobileHistoryGuard();
  });
}

function installMobileExperience() {
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
  installMobileBackBridge();
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

function installGatewayWebSocketBridge() {
  const eventApi = window.__TAURI__?.event;
  if (!eventApi) throw new Error("Android native event bridge is unavailable");
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
      window.WebSocket = NativeGatewayWebSocket as unknown as typeof WebSocket;
    });
}

function isGatewayRequest(input: RequestInfo | URL) {
  const value =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  return value.startsWith("/") || value.startsWith(window.location.origin);
}

function requestPath(input: RequestInfo | URL) {
  const value =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  if (value.startsWith("/")) return value;
  const url = new URL(value);
  return `${url.pathname}${url.search}`;
}

function installGatewayFetchBridge() {
  const browserFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!isGatewayRequest(input)) return browserFetch(input, init);

    const headers = new Headers(init?.headers);
    const body = init?.body;
    if (body !== undefined && typeof body !== "string") {
      return browserFetch(input, init);
    }
    const response = await nativeInvoke<MobileGatewayResponse>("mobile_gateway_request", {
      request: {
        path: requestPath(input),
        method: init?.method ?? "GET",
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
  installMobileExperience();
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

export function isOfflineCacheResponse(response: Response) {
  return response.headers.get("X-ZeroAgent-Cache") === "hit";
}
