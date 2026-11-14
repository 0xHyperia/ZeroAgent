import { invoke } from "@tauri-apps/api/core";
import type { DesktopCloudHost } from "@/lib/desktopRemoteHost";
import { openUrl } from "../../shims/tauriOpener";
import { desktopAccountRequest } from "./desktopRemoteHost";
import { nativeSessionHandle, requireNativeSession } from "./nativeSession";

type Callbacks = Pick<DesktopCloudHost, "onLogout" | "onUserChange" | "registerNavigationGuard"> & {
  onLocationChange?: (href: string) => void;
};
type CloudResponse = { status: number; headers: Record<string, string> };
const locationEvent = "zeroagent:desktop-cloud-location";
const routeKey = (scope: string) => `zeroagent.desktop-cloud.location:${scope}`;
const conversationKey = (scope: string) => `${routeKey(scope)}:conversation`;
const skillReaderReturnKey = (scope: string) => `${routeKey(scope)}:skill-reader-return`;

export function desktopCloudNavigate(scope: string, href: string) {
  localStorage.removeItem(skillReaderReturnKey(scope));
  localStorage.setItem(routeKey(scope), href);
  window.dispatchEvent(new CustomEvent(locationEvent, { detail: scope }));
}

function encode(bytes: Uint8Array) {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(value);
}

export async function openDesktopCloudConnection(signal: AbortSignal) {
  const session = await requireNativeSession();
  const sessionHandle = session.sessionHandle;
  const { bridgeId, origin } = await invoke<{ bridgeId: string; origin: string }>(
    "account_cloud_open",
    { sessionHandle },
  );
  const closed = new AbortController();
  const isCurrent = () =>
    !closed.signal.aborted && !signal.aborted && nativeSessionHandle() === sessionHandle;
  const dispose = () => {
    if (closed.signal.aborted) return;
    closed.abort();
    void invoke("account_cloud_close", { sessionHandle, bridgeId }).catch(() => undefined);
  };
  signal.addEventListener("abort", dispose, { once: true });
  if (!isCurrent()) {
    dispose();
    throw new Error("Cloud workbench account changed");
  }
  return {
    session,
    origin,
    isCurrent,
    dispose,
    openExternal: async (url: string) => {
      const target = new URL(url);
      if (target.protocol !== "https:" || target.username || target.password)
        throw new Error("Invalid authorization URL");
      await openUrl(target.href);
    },
    async request(path: string, init?: RequestInit) {
      if (!isCurrent()) throw new Error("Cloud workbench account changed");
      if (path.startsWith("/api/usa-zero/") || path === "/api/auth/me")
        return desktopAccountRequest(path, init);
      const request = new Request(new URL(path, origin), init);
      const signal = AbortSignal.any([request.signal, closed.signal]);
      signal.throwIfAborted();
      const streamId = crypto.randomUUID();
      const transport = { sessionHandle, bridgeId, streamId };
      const cancel = () => void invoke("account_cloud_close", transport).catch(() => undefined);
      signal.addEventListener("abort", cancel, { once: true });
      const cleanup = () => {
        signal.removeEventListener("abort", cancel);
        cancel();
      };
      try {
        const headers = Object.fromEntries(request.headers);
        const bytes = request.body ? new Uint8Array(await request.arrayBuffer()) : null;
        signal.throwIfAborted();
        const response = await invoke<CloudResponse>("account_cloud_fetch", {
          request: {
            ...transport,
            method: request.method,
            path,
            headers,
            bodyBase64: bytes ? encode(bytes) : undefined,
          },
        });
        signal.throwIfAborted();
        if ([204, 205, 304].includes(response.status) || request.method === "HEAD") {
          cleanup();
          return new Response(null, response);
        }
        const body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              signal.throwIfAborted();
              const chunk = await invoke<string | null>("account_cloud_read", transport);
              signal.throwIfAborted();
              if (chunk === null) {
                cleanup();
                controller.close();
              } else
                controller.enqueue(Uint8Array.from(atob(chunk), (value) => value.charCodeAt(0)));
            } catch (cause) {
              cleanup();
              controller.error(cause);
            }
          },
          cancel: cleanup,
        });
        return new Response(body, response);
      } catch (cause) {
        cleanup();
        throw cause;
      }
    },
  };
}

export async function openDesktopCloudHost(callbacks: Callbacks, signal: AbortSignal) {
  const { session, origin, isCurrent, dispose, openExternal, request } =
    await openDesktopCloudConnection(signal);
  const host: DesktopCloudHost = {
    ...callbacks,
    kind: "cloud",
    accountScope: session.accountScope,
    accountUser: session.user,
    gatewayOrigin: origin,
    isCurrent,
    openExternal,
    request,
    readLocation: () => localStorage.getItem(routeKey(session.accountScope)) || "/",
    readConversation: () => localStorage.getItem(conversationKey(session.accountScope)) || "",
    readSkillReaderReturn: () =>
      localStorage.getItem(skillReaderReturnKey(session.accountScope)) ?? undefined,
    saveLocation: (href, conversation, skillReaderReturn) => {
      if (!isCurrent()) return;
      localStorage.setItem(routeKey(session.accountScope), href);
      localStorage.setItem(conversationKey(session.accountScope), conversation);
      if (skillReaderReturn)
        localStorage.setItem(skillReaderReturnKey(session.accountScope), skillReaderReturn);
      else localStorage.removeItem(skillReaderReturnKey(session.accountScope));
      callbacks.onLocationChange?.(href);
    },
    subscribeLocation: (listener) => {
      const handle = (event: Event) => {
        if (isCurrent() && (event as CustomEvent<string>).detail === session.accountScope)
          listener();
      };
      window.addEventListener(locationEvent, handle);
      return () => window.removeEventListener(locationEvent, handle);
    },
  };
  return { host, dispose };
}
