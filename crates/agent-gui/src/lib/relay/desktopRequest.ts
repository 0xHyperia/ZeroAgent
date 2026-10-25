import { invoke } from "@tauri-apps/api/core";
import { isTauriHost } from "../host";
import type { AppSettings } from "../settings";
import { prepareAccountRequest } from "./accountProxy";
import { getValidRelayAccessToken } from "./client";
import { nativeSessionHandle, requireNativeSession } from "./nativeSession";

type DesktopRequestInit = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
};

function gatewayBaseURL(settings: AppSettings) {
  const url = new URL(settings.remote.gatewayUrl.trim());
  if (settings.remote.gatewayPort > 0) url.port = String(settings.remote.gatewayPort);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString();
}

function requestPath(pathname: string, searchParams?: URLSearchParams) {
  const normalizedPathname = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const search = searchParams?.toString();
  return search ? `${normalizedPathname}?${search}` : normalizedPathname;
}

export async function desktopRequest<T>(
  settings: AppSettings,
  pathname: string,
  init?: DesktopRequestInit,
  searchParams?: URLSearchParams,
) {
  if (isTauriHost()) {
    if (init?.signal?.aborted) throw init.signal.reason;
    const session = await requireNativeSession();
    const response = await invoke<{ status: number; body: T & { error?: string } }>(
      "account_gateway_http",
      {
        request: {
          sessionHandle: session.sessionHandle,
          origin: new URL(gatewayBaseURL(settings)).origin,
          path: requestPath(pathname, searchParams),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        },
      },
    );
    if (init?.signal?.aborted) throw init.signal.reason;
    if (nativeSessionHandle() !== session.sessionHandle)
      throw new Error("USA-Zero account session changed");
    if (response.status === 204) return undefined as T;
    if (response.status < 200 || response.status >= 300)
      throw new Error(response.body?.error || `Gateway 请求失败 (HTTP ${response.status})`);
    return response.body;
  }
  const request = async (forceRefresh: boolean) => {
    const token = await getValidRelayAccessToken(forceRefresh);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...init?.headers,
    };
    const proxyRequest = await prepareAccountRequest(gatewayBaseURL(settings), headers);
    const response = await fetch(`${proxyRequest.baseUrl}${requestPath(pathname, searchParams)}`, {
      ...init,
      headers: proxyRequest.headers,
    });
    return { response, token };
  };
  let attempt = await request(false);
  if (attempt.response.status === 401) {
    const currentToken = await getValidRelayAccessToken(false);
    attempt = await request(currentToken === attempt.token);
  }
  const response = attempt.response;
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `Gateway 请求失败 (HTTP ${response.status})`);
  }
  return payload;
}
