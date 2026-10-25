import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { nativeSessionHandle } from "./nativeSession";

type SocketEvent = { id: string; kind: "open" | "message" | "close" | "error"; data?: string };
const handlers = new Map<string, (event: SocketEvent) => void>();
let installed: Promise<void> | undefined;

function encode(bytes: Uint8Array): string {
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  }
  return btoa(text);
}
function decode(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export function installNativeGatewaySockets(): Promise<void> {
  installed ??= (async () => {
    const BrowserSocket = window.WebSocket;
    await listen<SocketEvent>("account-gateway-socket", ({ payload }) =>
      handlers.get(payload.id)?.(payload),
    );
    class AccountSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readyState = 0;
      binaryType: BinaryType = "arraybuffer";
      bufferedAmount = 0;
      extensions = "";
      protocol = "liveagent.v2.pb";
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      private readonly id = crypto.randomUUID();
      private readonly handle = nativeSessionHandle();
      private writes: Promise<unknown> = Promise.resolve();
      constructor(
        readonly url: string,
        protocols?: string | string[],
      ) {
        super();
        const parsed = new URL(url);
        const origin = new URL(url);
        origin.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
        handlers.set(this.id, (event) => this.receive(event));
        void Promise.resolve()
          .then(async () => {
            if (this.readyState !== 0) return;
            await invoke("account_gateway_socket_connect", {
              request: {
                id: this.id,
                sessionHandle: this.handle,
                origin: origin.origin,
                path: `${parsed.pathname}${parsed.search}`,
                protocols: typeof protocols === "string" ? [protocols] : (protocols ?? []),
              },
            });
            if (this.readyState >= 2)
              await invoke("account_gateway_socket_close", {
                id: this.id,
                sessionHandle: this.handle,
              });
          })
          .catch(() => this.fail());
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (this.readyState !== 1) throw new Error("Gateway WebSocket is not connected");
        if (typeof data === "string") throw new Error("Gateway WebSocket requires binary frames");
        const payload =
          data instanceof Blob
            ? data
            : (ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data)
              ).slice();
        const size = payload instanceof Blob ? payload.size : payload.byteLength;
        this.bufferedAmount += size;
        this.writes = this.writes
          .then(async () => {
            const bytes =
              payload instanceof Blob ? new Uint8Array(await payload.arrayBuffer()) : payload;
            if (this.readyState !== 1 || nativeSessionHandle() !== this.handle)
              throw new Error("Account socket expired");
            await invoke("account_gateway_socket_send", {
              request: { id: this.id, sessionHandle: this.handle, data: encode(bytes) },
            });
          })
          .catch(() => this.fail())
          .finally(() => {
            this.bufferedAmount = Math.max(0, this.bufferedAmount - size);
          });
      }
      close() {
        if (this.readyState >= 2) return;
        this.readyState = 2;
        void invoke("account_gateway_socket_close", { id: this.id, sessionHandle: this.handle })
          .catch(() => undefined)
          .finally(() => this.receive({ id: this.id, kind: "close" }));
      }
      private receive(event: SocketEvent) {
        if (event.kind !== "close" && nativeSessionHandle() !== this.handle) {
          this.fail();
          return;
        }
        if (event.kind === "open") {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          const opened = new Event("open");
          this.onopen?.(opened);
          this.dispatchEvent(opened);
        } else if (event.kind === "message" && event.data && this.readyState === 1) {
          const bytes = decode(event.data);
          const message = new MessageEvent("message", {
            data: this.binaryType === "blob" ? new Blob([bytes]) : bytes.buffer,
          });
          this.onmessage?.(message);
          this.dispatchEvent(message);
        } else if (event.kind === "close") {
          if (this.readyState === 3) return;
          this.readyState = 3;
          handlers.delete(this.id);
          const closed = new CloseEvent("close", { code: 1000, wasClean: true });
          this.onclose?.(closed);
          this.dispatchEvent(closed);
        } else if (event.kind === "error") this.fail();
      }
      private fail() {
        if (this.readyState === 3) return;
        const error = new Event("error");
        this.onerror?.(error);
        this.dispatchEvent(error);
        void invoke("account_gateway_socket_close", {
          id: this.id,
          sessionHandle: this.handle,
        }).catch(() => undefined);
        this.receive({ id: this.id, kind: "close" });
      }
    }
    const Routed = function (this: unknown, input: string | URL, protocols?: string | string[]) {
      const url = new URL(input.toString(), window.location.href);
      if (url.pathname === "/ws/v2" || url.pathname.startsWith("/ws/v2/"))
        return new AccountSocket(url.toString(), protocols);
      return protocols === undefined
        ? new BrowserSocket(input)
        : new BrowserSocket(input, protocols);
    } as unknown as typeof WebSocket;
    for (const [key, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }))
      Object.defineProperty(Routed, key, { value });
    window.WebSocket = Routed;
  })();
  return installed;
}
