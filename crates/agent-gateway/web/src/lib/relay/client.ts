import { createUuid } from "@liveagent/ui/lib/shared/id";
import type { ProviderId } from "@/lib/settings";
import {
  ACCOUNT_SESSION_STORAGE_KEY,
  accountFetch,
  accountOwnerHeaders,
  captureAccountRequestGuard,
  invalidateAccountRequests,
} from "../accountRequest";
import { getDesktopRemoteHost, requireCurrentDesktopRemoteHost } from "../desktopRemoteHost";
import {
  acknowledgeEmbeddedOAuthCallback,
  clearEmbeddedMobileGatewaySession,
  getPendingEmbeddedOAuthCallback,
  isEmbeddedMobileRuntime,
  openEmbeddedOAuth,
} from "../mobileRuntime";
import { loadToken } from "../storage";

export const RELAY_ORIGIN = "https://usa0.top";
export const RELAY_SESSION_CHANGED_EVENT = "zeroagent:relay-session-changed";
export const RELAY_SESSION_EXPIRED_EVENT = "zeroagent:relay-session-expired";

const RELAY_PROXY_BASE = "/api/usa-zero";
let relaySessionExpiryNotified = false;
let sessionMutationTail: Promise<unknown> = Promise.resolve();
const OAUTH_INSTALLATION_ID_KEY = "zeroagent.oauth.installation-id";

function changeRelaySession<T>(change: () => Promise<T>): Promise<T> {
  // Responses can set/clear the same HttpOnly cookie even when their UI result is stale.
  // In particular, logout (including Android secure storage cleanup) must finish before login.
  invalidateAccountRequests();
  const lockedChange = () =>
    typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request("zeroagent:account-cookie", change)
      : change();
  const pending = sessionMutationTail.then(lockedChange, lockedChange);
  sessionMutationTail = pending.catch(() => undefined);
  return pending;
}

function oauthInstallationID() {
  const current = localStorage.getItem(OAUTH_INSTALLATION_ID_KEY)?.trim();
  if (current) return current;
  const created = createUuid();
  localStorage.setItem(OAUTH_INSTALLATION_ID_KEY, created);
  return created;
}

type RelayEnvelope<T> = {
  code: number;
  message: string;
  reason?: string;
  data?: T;
};

export type RelayUser = {
  id: number;
  email: string;
  username?: string;
  role?: string;
  balance?: number;
  frozen_balance?: number;
  concurrency?: number;
  status?: string;
  created_at?: string;
  total_recharged?: number;
  avatar_url?: string;
  email_bound?: boolean;
  auth_kind?: "password" | "oauth";
};

export type RelayDashboardStats = {
  today_tokens: number;
  today_input_tokens?: number;
  today_output_tokens?: number;
  today_cache_creation_tokens?: number;
  today_cache_read_tokens?: number;
};

export function formatRelayBalance(balance?: number) {
  return Number.isFinite(balance) ? `$${Number(balance).toFixed(2)}` : "--";
}

export function formatRelayTokenCount(tokens?: number) {
  if (!Number.isFinite(tokens)) return "--";
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(tokens));
}

type RelaySessionTokens = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

export type RelayAuthResponse = RelaySessionTokens & { user: RelayUser };

export type RelayLoginResponse =
  | RelayAuthResponse
  | {
      requires_2fa: true;
      temp_token: string;
      user_email_masked?: string;
    };

export type RelayPublicSettings = {
  registration_enabled: boolean;
  email_verify_enabled: boolean;
  invitation_code_enabled: boolean;
  turnstile_enabled: boolean;
  site_name?: string;
  site_subtitle?: string;
};

export type RelayGroup = {
  id: number;
  name: string;
  description?: string | null;
  platform: string;
  rate_multiplier: number;
  subscription_type?: string;
  status: string;
};

export type RelayApiKey = {
  id: number;
  key: string;
  key_masked?: boolean;
  key_configured?: boolean;
  name: string;
  group_id: number | null;
  status: string;
  quota: number;
  quota_used: number;
  created_at: string;
  group?: RelayGroup;
};

type RelayPaginated<T> = {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  pages: number;
};

export class RelayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
    public readonly reason?: string,
  ) {
    super(message);
    this.name = "RelayApiError";
  }
}

export function clearRelaySession() {
  // Tokens remain server-side and are represented only by an HttpOnly cookie.
}

export function hasStoredRelaySession() {
  return true;
}

export function notifyRelaySessionExpired() {
  if (relaySessionExpiryNotified) return;
  relaySessionExpiryNotified = true;
  window.dispatchEvent(new Event(RELAY_SESSION_EXPIRED_EVENT));
}

function markRelaySessionAuthenticated() {
  relaySessionExpiryNotified = false;
}

function publishCookieSessionChange() {
  try {
    // A nonce wakes other same-origin tabs without putting account data or credentials in storage.
    localStorage.setItem(ACCOUNT_SESSION_STORAGE_KEY, createUuid());
  } catch {
    // Account assertions still reject mismatched cookies when browser storage is unavailable.
  }
}

type RelayRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  authenticated?: boolean;
  retryAfterRefresh?: boolean;
};

async function requestRelay<T>(path: string, options: RelayRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  let response: Response;
  try {
    response = await accountFetch(`${RELAY_PROXY_BASE}${normalizedPath}`, {
      method: options.method ?? "GET",
      headers,
      credentials: "include",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new RelayApiError(
      `无法连接 USA-零：${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }

  if (response.status === 401 && options.authenticated) {
    notifyRelaySessionExpired();
  }

  let envelope: RelayEnvelope<T> | null = null;
  try {
    envelope = (await response.json()) as RelayEnvelope<T>;
  } catch {
    throw new RelayApiError(`USA-零返回了无效响应 (HTTP ${response.status})`, response.status);
  }

  if (!response.ok || envelope.code !== 0 || envelope.data === undefined) {
    throw new RelayApiError(
      envelope.message || `请求失败 (HTTP ${response.status})`,
      response.status,
      envelope.code,
      envelope.reason,
    );
  }
  return envelope.data;
}

export function getRelayPublicSettings() {
  return requestGatewayAccount<RelayPublicSettings>("/api/auth/settings");
}

export async function startRelayOAuth(): Promise<boolean> {
  const embedded = isEmbeddedMobileRuntime();
  const response = await requestGatewayAccount<{ authorize_url: string }>("/api/auth/oauth/start", {
    method: "POST",
    body: {
      surface: embedded ? "android" : "web",
      return_path: `${window.location.pathname}${window.location.search}`,
      installation_id: oauthInstallationID(),
    },
  });
  if (!embedded) {
    window.location.assign(response.authorize_url);
    return false;
  }
  const callbackURL = await openEmbeddedOAuth(response.authorize_url);
  await completeEmbeddedRelayOAuth(callbackURL);
  return true;
}

const embeddedOAuthCompletions = new Map<string, Promise<void>>();

async function completeEmbeddedRelayOAuth(callbackURL: string): Promise<void> {
  const current = embeddedOAuthCompletions.get(callbackURL);
  if (current) return current;
  const completion = (async () => {
    const callback = new URL(callbackURL);
    try {
      await changeRelaySession(async () => {
        await requestGatewayAccount<{ user: RelayUser }>("/api/auth/oauth/complete", {
          method: "POST",
          body: {
            code: callback.searchParams.get("code") ?? "",
            state: callback.searchParams.get("state") ?? "",
            error: callback.searchParams.get("error") ?? "",
          },
        });
        markRelaySessionAuthenticated();
        publishCookieSessionChange();
        await acknowledgeEmbeddedOAuthCallback(callbackURL);
      });
    } catch (cause) {
      if (cause instanceof RelayApiError && cause.status >= 400 && cause.status < 500) {
        await acknowledgeEmbeddedOAuthCallback(callbackURL);
      }
      throw cause;
    }
  })().finally(() => {
    embeddedOAuthCompletions.delete(callbackURL);
  });
  embeddedOAuthCompletions.set(callbackURL, completion);
  return completion;
}

export async function resumeRelayOAuth(onPending?: () => void): Promise<boolean> {
  if (!isEmbeddedMobileRuntime()) return false;
  const callbackURL = await getPendingEmbeddedOAuthCallback();
  if (!callbackURL) return false;
  onPending?.();
  await completeEmbeddedRelayOAuth(callbackURL);
  return true;
}

export async function loginRelay(email: string, password: string) {
  return changeRelaySession(async () => {
    const response = await requestGatewayAccount<
      { user: RelayUser } | { requires_2fa: true; temp_token: string; user_email_masked?: string }
    >("/api/auth/login", {
      method: "POST",
      body: { email: email.trim(), password },
    });
    if ("requires_2fa" in response) return response;
    markRelaySessionAuthenticated();
    publishCookieSessionChange();
    return {
      access_token: "cookie-session",
      token_type: "Cookie",
      user: response.user,
    } satisfies RelayAuthResponse;
  });
}

export async function verifyRelayPassword(email: string, password: string) {
  const response = await requestGatewayAccount<{ verified: boolean }>("/api/auth/verify-password", {
    method: "POST",
    body: { email: email.trim(), password },
    authenticated: true,
  });
  if (response.verified !== true) {
    throw new RelayApiError("密码验证失败", 403);
  }
}

export async function loginRelay2FA(tempToken: string, totpCode: string) {
  return changeRelaySession(async () => {
    const response = await requestGatewayAccount<{ user: RelayUser }>("/api/auth/2fa", {
      method: "POST",
      body: { temp_token: tempToken, totp_code: totpCode.trim() },
    });
    markRelaySessionAuthenticated();
    publishCookieSessionChange();
    return {
      access_token: "cookie-session",
      token_type: "Cookie",
      user: response.user,
    } satisfies RelayAuthResponse;
  });
}

export async function registerRelay(input: {
  email: string;
  password: string;
  verifyCode?: string;
  invitationCode?: string;
}) {
  return changeRelaySession(async () => {
    const response = await requestGatewayAccount<{ user: RelayUser }>("/api/auth/register", {
      method: "POST",
      body: {
        email: input.email.trim(),
        password: input.password,
        verify_code: input.verifyCode?.trim() ?? "",
        invitation_code: input.invitationCode?.trim() ?? "",
      },
    });
    markRelaySessionAuthenticated();
    publishCookieSessionChange();
    return {
      access_token: "cookie-session",
      token_type: "Cookie",
      user: response.user,
    } satisfies RelayAuthResponse;
  });
}

export function sendRelayVerifyCode(email: string) {
  return requestGatewayAccount<{ message: string; countdown: number }>(
    "/api/auth/send-verify-code",
    {
      method: "POST",
      body: { email: email.trim() },
    },
  );
}

export function getRelayCurrentUser() {
  return requestGatewayAccount<{ user: RelayUser }>("/api/auth/me", {
    authenticated: true,
  }).then((response) => {
    markRelaySessionAuthenticated();
    return response.user;
  });
}

export function getRelayProfile() {
  return requestRelay<RelayUser>("/user/profile", { authenticated: true });
}

export function getRelayDashboardStats() {
  return requestRelay<RelayDashboardStats>("/usage/dashboard/stats", { authenticated: true });
}

export function updateRelayProfile(profile: { username?: string; avatar_url?: string | null }) {
  return requestRelay<RelayUser>("/user", {
    method: "PUT",
    authenticated: true,
    body: profile,
  });
}

export function sendRelayEmailBindingCode(email: string) {
  return requestRelay<{ message?: string }>("/user/account-bindings/email/send-code", {
    method: "POST",
    authenticated: true,
    body: { email: email.trim() },
  });
}

export function bindRelayEmail(email: string, verifyCode: string, password: string) {
  return requestRelay<RelayUser>("/user/account-bindings/email", {
    method: "POST",
    authenticated: true,
    body: {
      email: email.trim(),
      verify_code: verifyCode.trim(),
      password,
    },
  });
}

export function changeRelayPassword(oldPassword: string, newPassword: string) {
  return requestRelay<{ message?: string }>("/user/password", {
    method: "PUT",
    authenticated: true,
    body: { old_password: oldPassword, new_password: newPassword },
  });
}

export async function listRelayApiKeys() {
  const page = await requestRelay<RelayPaginated<RelayApiKey>>("/keys?page=1&page_size=1000", {
    authenticated: true,
  });
  return page.items.map(managedKeySummary);
}

function managedKeySummary(key: RelayApiKey): RelayApiKey {
  const configured = key.key_configured ?? Boolean(key.key?.trim());
  return {
    id: key.id, name: key.name, group_id: key.group_id, status: key.status,
    quota: key.quota, quota_used: key.quota_used, created_at: key.created_at,
    group: key.group, key: configured ? "••••••••" : "",
    key_masked: true, key_configured: configured,
  };
}

/** Return a key only for this operation; never put it in settings or component state. */
export async function revealRelayApiKey(keyId: number, password: string): Promise<string> {
  if (!Number.isSafeInteger(keyId) || keyId <= 0 || !password)
    throw new RelayApiError("请选择密钥并输入当前账户密码", 400);
  const requireCurrent = captureAccountRequestGuard();
  const response = await requestGatewayAccount<{ key: string }>(
    `/api/managed-provider-keys/${keyId}/reveal`,
    { method: "POST", authenticated: true, body: { password } },
  );
  requireCurrent();
  if (typeof response.key !== "string" || !response.key.trim())
    throw new RelayApiError("账户服务未返回密钥", 502);
  return response.key;
}

export function listRelayGroups() {
  return requestRelay<RelayGroup[]>("/groups/available", { authenticated: true });
}

export async function createRelayApiKey(name: string, groupId: number) {
  const key = await requestRelay<RelayApiKey>("/keys", {
    method: "POST",
    authenticated: true,
    body: { name: name.trim(), group_id: groupId },
  });
  return managedKeySummary(key);
}

export async function createRelayApiKeys(name: string, groupIds: number[], groups: RelayGroup[]) {
  const validIds = [...new Set(groupIds)].filter((id) =>
    groups.some((group) => group.id === id && group.status === "active"),
  );
  if (validIds.length === 0) throw new RelayApiError("请选择至少一个可用分组", 400);

  const created: RelayApiKey[] = [];
  for (const groupId of validIds) {
    const group = groups.find((item) => item.id === groupId);
    const keyName = validIds.length === 1 ? name : `${name} / ${group?.name ?? groupId}`;
    created.push(await createRelayApiKey(keyName, groupId));
  }
  return created;
}

export async function getRelayProviderModels(keyId: number, providerType?: ProviderId) {
  if (getDesktopRemoteHost()) {
    if (!providerType) return Promise.reject(new Error("无法识别托管模型协议。"));
    const { getGatewayWebSocketClient } = await import("../gatewaySocket");
    return getGatewayWebSocketClient(loadToken().trim()).getProviderModels(
      providerType,
      "",
      "",
      false,
      undefined,
      `relay-key-${keyId}`,
    );
  }
  return requestGatewayAccount<{ models: unknown }>(
    `/api/web-chat/provider-keys/${encodeURIComponent(String(keyId))}/models`,
    { authenticated: true },
  ).then((response) => response.models);
}

async function requestGatewayAccount<T>(
  path: string,
  options: {
    method?: "GET" | "POST";
    body?: unknown;
    authenticated?: boolean;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await accountFetch(path, {
      method: options.method ?? "GET",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new RelayApiError(
      `无法连接账户服务：${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }
  if (response.status === 401 && options.authenticated) {
    notifyRelaySessionExpired();
  }
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string; reason?: string })
    | null;
  if (!response.ok || !payload) {
    throw new RelayApiError(
      payload?.error || `请求失败 (HTTP ${response.status})`,
      response.status,
      undefined,
      payload?.reason,
    );
  }
  return payload;
}

export async function logoutRelay() {
  const host = getDesktopRemoteHost();
  if (host) {
    requireCurrentDesktopRemoteHost();
    if (!host.logout) throw new Error("桌面退出登录暂不可用。");
    await host.logout();
    return;
  }
  const ownerHeaders = accountOwnerHeaders();
  return changeRelaySession(async () => {
    await requestGatewayAccount<void>("/api/auth/logout", {
      method: "POST",
      headers: ownerHeaders,
    });
    if (isEmbeddedMobileRuntime()) {
      await clearEmbeddedMobileGatewaySession();
    }
    clearRelaySession();
    publishCookieSessionChange();
    window.dispatchEvent(new Event(RELAY_SESSION_CHANGED_EVENT));
  });
}
