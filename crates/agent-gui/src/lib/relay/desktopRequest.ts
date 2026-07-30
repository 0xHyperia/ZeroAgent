import { prepareProxyRequest } from "../providers/proxy";
import type { AppSettings } from "../settings";
import { getRelayAccessToken } from "./client";

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
  const token = getRelayAccessToken();
  if (!token) throw new Error("USA-零登录已失效");

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    ...init?.headers,
  };
  const proxyRequest = await prepareProxyRequest("codex", gatewayBaseURL(settings), headers);
  const response = await fetch(`${proxyRequest.baseUrl}${requestPath(pathname, searchParams)}`, {
    ...init,
    headers: proxyRequest.headers,
  });
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `Gateway 请求失败 (HTTP ${response.status})`);
  }
  return payload;
}
