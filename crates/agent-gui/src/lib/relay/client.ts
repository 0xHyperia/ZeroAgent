import { invoke } from "@tauri-apps/api/core";
import { isTauriHost } from "../host";
import type { NativeProfileCredential } from "../kbrain/profile";
import { prepareAccountRequest } from "./accountProxy";
import { getInstallationID } from "./installation";
import {
  acceptNativeSession,
  clearNativeSession,
  initializeNativeAccount,
  logoutNativeAccount,
  type NativeAccountSession,
  nativeAccountRequest,
  nativeRevealKey,
  nativeSessionHandle,
  nativeSessionSummary,
  rejectNativeSession,
  requireNativeSession,
} from "./nativeSession";

const DEFAULT_RELAY_ORIGIN = "https://usa0.top";

function normalizeRelayOrigin(value: string) {
  const url = new URL(value.trim());
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !url.hostname ||
    url.username ||
    url.password
  ) {
    throw new Error("USA-零服务地址必须是有效的 HTTP 或 HTTPS 地址");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function initialRelayOrigin() {
  const buildDefault =
    typeof __ZEROAGENT_USA_ZERO_ORIGIN__ === "string" ? __ZEROAGENT_USA_ZERO_ORIGIN__.trim() : "";
  try {
    return normalizeRelayOrigin(buildDefault || DEFAULT_RELAY_ORIGIN);
  } catch {
    return DEFAULT_RELAY_ORIGIN;
  }
}

export const RELAY_ORIGIN = initialRelayOrigin();
export const RELAY_API_BASE_URL = `${RELAY_ORIGIN}/api/v1`;
export const RELAY_SESSION_CHANGED_EVENT = "zeroagent:relay-session-changed";
export const RELAY_TOKEN_CHANGED_EVENT = "zeroagent:relay-token-changed";

const ACCESS_TOKEN_KEY = "zeroagent.relay.access-token";
const REFRESH_TOKEN_KEY = "zeroagent.relay.refresh-token";
const EXPIRES_AT_KEY = "zeroagent.relay.expires-at";
const AUTH_KIND_KEY = "zeroagent.relay.auth-kind";
const OAUTH_CLIENT_ID_KEY = "zeroagent.relay.oauth-client-id";
let relaySessionExpiryNotified = false;
let refreshRelaySessionPromise: Promise<boolean> | null = null;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const TOKEN_REFRESH_RETRY_MS = 30_000;

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
  auth_kind?: "oauth" | "password";
  oauth_client_id?: string;
};

export type RelayAuthResponse = RelaySessionTokens & {
  user: RelayUser;
};

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
  platform: "anthropic" | "openai" | "gemini" | "antigravity" | "grok" | string;
  rate_multiplier: number;
  subscription_type?: "standard" | "subscription" | string;
  status: "active" | "inactive" | string;
};

export type RelayApiKey = {
  id: number;
  key: string;
  name: string;
  group_id: number | null;
  status: "active" | "inactive" | "disabled" | "quota_exhausted" | "expired" | string;
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

function readAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY)?.trim() ?? "";
}

export function getRelayAccessToken() {
  if (isTauriHost()) return nativeSessionHandle();
  return readAccessToken();
}

function readRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY)?.trim() ?? "";
}

function saveSession(response: RelaySessionTokens) {
  if (isTauriHost()) throw new Error("Native account tokens must stay in the system vault");
  relaySessionExpiryNotified = false;
  const previousAccessToken = readAccessToken();
  localStorage.setItem(ACCESS_TOKEN_KEY, response.access_token.trim());
  if (response.refresh_token?.trim()) {
    localStorage.setItem(REFRESH_TOKEN_KEY, response.refresh_token.trim());
  }
  if (response.expires_in && response.expires_in > 0) {
    localStorage.setItem(EXPIRES_AT_KEY, String(Date.now() + response.expires_in * 1000));
  } else {
    localStorage.removeItem(EXPIRES_AT_KEY);
  }
  if (response.auth_kind) localStorage.setItem(AUTH_KIND_KEY, response.auth_kind);
  if (response.oauth_client_id) localStorage.setItem(OAUTH_CLIENT_ID_KEY, response.oauth_client_id);
  if (previousAccessToken !== response.access_token.trim()) {
    window.dispatchEvent(new Event(RELAY_TOKEN_CHANGED_EVENT));
  }
}

function isOAuthSession() {
  if (isTauriHost()) return nativeSessionSummary()?.authKind === "oauth";
  return localStorage.getItem(AUTH_KIND_KEY) === "oauth";
}

export function requiresWebsiteAccountSecurity() {
  return isTauriHost() && isOAuthSession();
}

export function clearRelaySession() {
  if (isTauriHost()) {
    clearNativeSession();
    return;
  }
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(EXPIRES_AT_KEY);
  localStorage.removeItem(AUTH_KIND_KEY);
  localStorage.removeItem(OAUTH_CLIENT_ID_KEY);
}

function expireRelaySession() {
  clearRelaySession();
  if (relaySessionExpiryNotified) return;
  relaySessionExpiryNotified = true;
  window.dispatchEvent(new Event(RELAY_SESSION_CHANGED_EVENT));
}

export function hasStoredRelaySession() {
  if (isTauriHost()) return Boolean(nativeSessionHandle());
  return Boolean(readAccessToken() || readRefreshToken());
}

function accessTokenExpiresAt() {
  if (isTauriHost()) return nativeSessionSummary()?.expiresAtMs ?? 0;
  const value = Number(localStorage.getItem(EXPIRES_AT_KEY) ?? "");
  return Number.isFinite(value) && value > 0 ? value : 0;
}

async function requireValidRelayAccessToken(forceRefresh = false) {
  if (isTauriHost()) return (await requireNativeSession(forceRefresh)).sessionHandle;
  const accessToken = readAccessToken();
  const expiresAt = accessTokenExpiresAt();
  if (
    !forceRefresh &&
    accessToken &&
    (!expiresAt || expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS)
  ) {
    return accessToken;
  }
  if (await refreshRelaySession()) {
    const refreshed = readAccessToken();
    if (refreshed) return refreshed;
  }
  throw new RelayApiError("请先登录 USA-零", 401);
}

export async function getValidRelayAccessToken(forceRefresh = false) {
  return requireValidRelayAccessToken(forceRefresh);
}

export async function getNativeProfileCredential(): Promise<NativeProfileCredential | null> {
  if (isTauriHost()) {
    const session = await initializeNativeAccount();
    return session ? { sessionHandle: session.sessionHandle } : null;
  }
  return null;
}

export function nativeProfileCredentialMatches(
  credential: NativeProfileCredential | null,
): boolean {
  if (credential === null) return !hasStoredRelaySession();
  return credential.sessionHandle === nativeSessionHandle();
}

export function rejectNativeProfileCredential(credential: NativeProfileCredential | null): boolean {
  if (isTauriHost()) return rejectNativeSession(credential?.sessionHandle ?? null);
  if (credential === null || !nativeProfileCredentialMatches(credential)) return false;
  expireRelaySession();
  return true;
}

export function installRelaySessionLifecycle() {
  let stopped = false;
  let timer: number | null = null;

  const clearTimer = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    clearTimer();
    if (stopped || !hasStoredRelaySession()) return;
    const expiresAt = accessTokenExpiresAt();
    if (!expiresAt) return;
    const delay = Math.max(0, expiresAt - Date.now() - TOKEN_REFRESH_SKEW_MS);
    timer = window.setTimeout(() => void refreshAndSchedule(), delay);
  };
  const refreshAndSchedule = async () => {
    clearTimer();
    try {
      await getValidRelayAccessToken();
      schedule();
    } catch {
      if (!stopped && hasStoredRelaySession()) {
        timer = window.setTimeout(() => void refreshAndSchedule(), TOKEN_REFRESH_RETRY_MS);
      }
    }
  };
  const handleWake = () => void refreshAndSchedule();
  const handleVisibility = () => {
    if (document.visibilityState === "visible") handleWake();
  };

  window.addEventListener(RELAY_TOKEN_CHANGED_EVENT, schedule);
  window.addEventListener("online", handleWake);
  window.addEventListener("focus", handleWake);
  window.addEventListener("pageshow", handleWake);
  document.addEventListener("visibilitychange", handleVisibility);
  schedule();
  return () => {
    stopped = true;
    clearTimer();
    window.removeEventListener(RELAY_TOKEN_CHANGED_EVENT, schedule);
    window.removeEventListener("online", handleWake);
    window.removeEventListener("focus", handleWake);
    window.removeEventListener("pageshow", handleWake);
    document.removeEventListener("visibilitychange", handleVisibility);
  };
}

type RelayRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  authenticated?: boolean;
  retryAfterRefresh?: boolean;
};

async function requestRelay<T>(path: string, options: RelayRequestOptions = {}): Promise<T> {
  if (isTauriHost())
    return nativeAccountRequest<T>(
      path,
      options.method ?? "GET",
      options.body,
      Boolean(options.authenticated),
      false,
    );
  const method = options.method ?? "GET";
  let requestAccessToken = "";
  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (options.authenticated) {
    requestAccessToken = await requireValidRelayAccessToken();
    headers.Authorization = `Bearer ${requestAccessToken}`;
  }

  const proxyRequest = await prepareAccountRequest(RELAY_API_BASE_URL, headers);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  let response: Response;
  try {
    response = await fetch(`${proxyRequest.baseUrl}${normalizedPath}`, {
      method,
      headers: proxyRequest.headers,
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
    if (options.retryAfterRefresh !== false) {
      if (readAccessToken() && readAccessToken() !== requestAccessToken) {
        return requestRelay<T>(path, { ...options, retryAfterRefresh: false });
      }
      const refreshed = await refreshRelaySession();
      if (refreshed) return requestRelay<T>(path, { ...options, retryAfterRefresh: false });
    }
    expireRelaySession();
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

type AppRelayEnvelope<T> = {
  success: boolean;
  data?: T;
  message?: string;
  error?: { code?: string; message?: string };
};

async function requestAppRelay<T>(path: string, options: RelayRequestOptions = {}): Promise<T> {
  if (isTauriHost())
    return nativeAccountRequest<T>(path, options.method ?? "GET", options.body, true, true);
  const accessToken = await requireValidRelayAccessToken();

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };
  const proxyRequest = await prepareAccountRequest(RELAY_API_BASE_URL, headers);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  let response: Response;
  try {
    response = await fetch(`${proxyRequest.baseUrl}${normalizedPath}`, {
      method: options.method ?? "GET",
      headers: proxyRequest.headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new RelayApiError(
      `无法连接 USA-零：${error instanceof Error ? error.message : String(error)}`,
      0,
    );
  }

  if (response.status === 401) {
    if (options.retryAfterRefresh !== false) {
      if (readAccessToken() && readAccessToken() !== accessToken) {
        return requestAppRelay<T>(path, { ...options, retryAfterRefresh: false });
      }
      const refreshed = await refreshRelaySession();
      if (refreshed) return requestAppRelay<T>(path, { ...options, retryAfterRefresh: false });
    }
    expireRelaySession();
  }

  let envelope: AppRelayEnvelope<T>;
  try {
    envelope = (await response.json()) as AppRelayEnvelope<T>;
  } catch {
    throw new RelayApiError(`USA-零返回了无效响应 (HTTP ${response.status})`, response.status);
  }
  if (!response.ok || !envelope.success || envelope.data === undefined) {
    throw new RelayApiError(
      envelope.error?.message || envelope.message || "授权资源请求失败",
      response.status,
      undefined,
      envelope.error?.code,
    );
  }
  return envelope.data;
}

async function refreshRelaySession() {
  if (isTauriHost()) {
    await requireNativeSession(true);
    return true;
  }
  if (refreshRelaySessionPromise) return refreshRelaySessionPromise;
  refreshRelaySessionPromise = refreshRelaySessionInternal().finally(() => {
    refreshRelaySessionPromise = null;
  });
  return refreshRelaySessionPromise;
}

async function refreshRelaySessionInternal() {
  const refreshToken = readRefreshToken();
  if (!refreshToken) {
    expireRelaySession();
    return false;
  }
  try {
    if (isOAuthSession()) {
      const clientId = localStorage.getItem(OAUTH_CLIENT_ID_KEY) || "zeroagent-desktop";
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      };
      const proxyRequest = await prepareAccountRequest(RELAY_API_BASE_URL, headers);
      const response = await fetch(`${proxyRequest.baseUrl}/app-auth/token`, {
        method: "POST",
        headers: proxyRequest.headers,
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: clientId,
          refresh_token: refreshToken,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new RelayApiError("OAuth refresh failed", response.status);
      }
      const tokens = (await response.json()) as RelaySessionTokens;
      saveSession({ ...tokens, auth_kind: "oauth", oauth_client_id: clientId });
      return true;
    }
    const response = await requestRelay<RelaySessionTokens>("/auth/refresh", {
      method: "POST",
      body: { refresh_token: refreshToken },
      retryAfterRefresh: false,
    });
    saveSession(response);
    return true;
  } catch (error) {
    if (error instanceof RelayApiError && (error.status === 400 || error.status === 401)) {
      expireRelaySession();
      return false;
    }
    throw error;
  }
}

export async function loginRelayOAuth() {
  if (isTauriHost()) {
    const response = await invoke<NativeAccountSession>("desktop_oauth_login", {
      relayOrigin: RELAY_ORIGIN,
      installationId: getInstallationID(),
    });
    acceptNativeSession(response);
    window.dispatchEvent(new Event(RELAY_SESSION_CHANGED_EVENT));
    return { user: response.user };
  }
  const response = await invoke<
    RelayAuthResponse & { auth_kind: "oauth"; oauth_client_id: string }
  >("desktop_oauth_login", { relayOrigin: RELAY_ORIGIN, installationId: getInstallationID() });
  saveSession(response);
  return response;
}

function isFullAuthResponse(response: RelayLoginResponse): response is RelayAuthResponse {
  return "access_token" in response && typeof response.access_token === "string";
}

export async function getRelayPublicSettings() {
  return requestRelay<RelayPublicSettings>("/settings/public");
}

export async function loginRelay(email: string, password: string) {
  if (isTauriHost()) throw new RelayApiError("请使用 USA-Zero OAuth 登录。", 400);
  const response = await requestRelay<RelayLoginResponse>("/auth/login", {
    method: "POST",
    body: { email: email.trim(), password },
  });
  if (isFullAuthResponse(response)) saveSession(response);
  return response;
}

export async function verifyRelayPassword(email: string, password: string) {
  if (isTauriHost()) throw new Error("使用指定密钥的原生密码验证入口。");
  await requireValidRelayAccessToken();
  const sessionIdentity = () =>
    JSON.stringify([
      readAccessToken(),
      localStorage.getItem(AUTH_KIND_KEY),
      localStorage.getItem(OAUTH_CLIENT_ID_KEY),
    ]);
  const expectedSession = sessionIdentity();
  const currentUser = await getRelayCurrentUser();
  const requireCurrentSession = () => {
    if (sessionIdentity() !== expectedSession) {
      throw new RelayApiError("登录状态已变化，请重新验证密码", 409);
    }
  };
  requireCurrentSession();
  if (email.trim().toLowerCase() !== currentUser.email.trim().toLowerCase()) {
    throw new RelayApiError("请验证当前账号的密码", 403);
  }
  // Password proof must not install the temporary password-login tokens over OAuth.
  const response = await requestRelay<RelayLoginResponse>("/auth/login", {
    method: "POST",
    body: { email: currentUser.email.trim(), password },
  });
  requireCurrentSession();
  if (isFullAuthResponse(response)) {
    if (!response.access_token.trim() || response.user?.id !== currentUser.id) {
      throw new RelayApiError("密码验证失败", 403);
    }
  } else if (response.requires_2fa !== true || !response.temp_token?.trim()) {
    throw new RelayApiError("密码验证失败", 403);
  }
}

export async function loginRelay2FA(tempToken: string, totpCode: string) {
  if (isTauriHost()) throw new RelayApiError("请使用 USA-Zero OAuth 登录。", 400);
  const response = await requestRelay<RelayAuthResponse>("/auth/login/2fa", {
    method: "POST",
    body: { temp_token: tempToken, totp_code: totpCode.trim() },
  });
  saveSession(response);
  return response;
}

export async function registerRelay(input: {
  email: string;
  password: string;
  verifyCode?: string;
  invitationCode?: string;
}) {
  if (isTauriHost()) throw new RelayApiError("请在 USA-Zero 完成注册后使用 OAuth 登录。", 400);
  const response = await requestRelay<RelayAuthResponse>("/auth/register", {
    method: "POST",
    body: {
      email: input.email.trim(),
      password: input.password,
      verify_code: input.verifyCode?.trim() ?? "",
      invitation_code: input.invitationCode?.trim() ?? "",
    },
  });
  saveSession(response);
  return response;
}

export async function sendRelayVerifyCode(email: string) {
  return requestRelay<{ message: string; countdown: number }>("/auth/send-verify-code", {
    method: "POST",
    body: { email: email.trim() },
  });
}

export async function getRelayCurrentUser() {
  if (isOAuthSession()) return requestAppRelay<RelayUser>("/app/me", { authenticated: true });
  return requestRelay<RelayUser>("/auth/me", { authenticated: true });
}

export async function getRelayProfile() {
  if (isOAuthSession()) return requestAppRelay<RelayUser>("/app/me", { authenticated: true });
  return requestRelay<RelayUser>("/user/profile", { authenticated: true });
}

export async function getRelayDashboardStats() {
  if (isOAuthSession())
    return requestAppRelay<RelayDashboardStats>("/app/usage", { authenticated: true });
  return requestRelay<RelayDashboardStats>("/usage/dashboard/stats", { authenticated: true });
}

export async function updateRelayProfile(profile: {
  username?: string;
  avatar_url?: string | null;
}) {
  if (isOAuthSession())
    return requestAppRelay<RelayUser>("/app/me", {
      method: "PATCH",
      authenticated: true,
      body: profile,
    });
  return requestRelay<RelayUser>("/user", {
    method: "PUT",
    authenticated: true,
    body: profile,
  });
}

export async function sendRelayEmailBindingCode(email: string) {
  return requestRelay<{ message?: string }>("/user/account-bindings/email/send-code", {
    method: "POST",
    authenticated: true,
    body: { email: email.trim() },
  });
}

export async function bindRelayEmail(email: string, verifyCode: string, password: string) {
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

export async function changeRelayPassword(oldPassword: string, newPassword: string) {
  return requestRelay<{ message?: string }>("/user/password", {
    method: "PUT",
    authenticated: true,
    body: { old_password: oldPassword, new_password: newPassword },
  });
}

export async function listRelayApiKeys() {
  if (isOAuthSession()) {
    const page = await requestAppRelay<{ items: RelayApiKey[]; total: number }>(
      "/app/keys?page=1&page_size=100",
      { authenticated: true },
    );
    return page.items;
  }
  const page = await requestRelay<RelayPaginated<RelayApiKey>>("/keys?page=1&page_size=1000", {
    authenticated: true,
  });
  return page.items;
}

export async function revealRelayApiKey(id: number, password: string): Promise<string> {
  if (isTauriHost()) return nativeRevealKey(id, password);
  const user = await getRelayCurrentUser();
  await verifyRelayPassword(user.email, password);
  const key = (await listRelayApiKeys()).find((key) => key.id === id);
  if (!key) throw new Error("密钥已不可用。");
  return key.key;
}

export async function listRelayGroups() {
  if (isOAuthSession())
    return requestAppRelay<RelayGroup[]>("/app/groups", { authenticated: true });
  return requestRelay<RelayGroup[]>("/groups/available", { authenticated: true });
}

export async function createRelayApiKey(name: string, groupId: number) {
  if (isOAuthSession())
    return requestAppRelay<RelayApiKey>(`/app/groups/${groupId}/keys`, {
      method: "POST",
      authenticated: true,
      body: { name: name.trim() },
    });
  return requestRelay<RelayApiKey>("/keys", {
    method: "POST",
    authenticated: true,
    body: { name: name.trim(), group_id: groupId },
  });
}

export async function createRelayApiKeys(name: string, groupIds: number[], groups: RelayGroup[]) {
  const uniqueGroupIds = [...new Set(groupIds)].filter((groupId) =>
    groups.some((group) => group.id === groupId && group.status === "active"),
  );
  if (uniqueGroupIds.length === 0) {
    throw new RelayApiError("请选择至少一个可用分组", 400);
  }

  const created: RelayApiKey[] = [];
  for (const groupId of uniqueGroupIds) {
    const group = groups.find((item) => item.id === groupId);
    const keyName = uniqueGroupIds.length === 1 ? name : `${name} / ${group?.name ?? groupId}`;
    created.push(await createRelayApiKey(keyName, groupId));
  }
  return created;
}

export async function logoutRelay() {
  if (isTauriHost()) return logoutNativeAccount();
  const refreshToken = readRefreshToken();
  if (refreshToken) {
    try {
      if (isOAuthSession()) {
        const headers: Record<string, string> = {
          "Content-Type": "application/x-www-form-urlencoded",
        };
        const proxyRequest = await prepareAccountRequest(RELAY_API_BASE_URL, headers);
        await fetch(`${proxyRequest.baseUrl}/app-auth/revoke`, {
          method: "POST",
          headers: proxyRequest.headers,
          body: new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" }),
        });
        clearRelaySession();
        window.dispatchEvent(new Event(RELAY_SESSION_CHANGED_EVENT));
        return;
      }
      await requestRelay<{ message: string }>("/auth/logout", {
        method: "POST",
        body: { refresh_token: refreshToken },
        retryAfterRefresh: false,
      });
    } catch {
      // Local logout must still complete when the relay is temporarily unavailable.
    }
  }
  clearRelaySession();
  window.dispatchEvent(new Event(RELAY_SESSION_CHANGED_EVENT));
}
