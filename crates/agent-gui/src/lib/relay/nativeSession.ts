import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RelayUser } from "./client";

export type NativeAccountSession = {
  sessionHandle: string;
  user: RelayUser;
  authKind: "oauth" | "password";
  expiresAtMs: number;
  accountScope: string;
};

const legacyKeys = [
  "zeroagent.relay.access-token",
  "zeroagent.relay.refresh-token",
  "zeroagent.relay.expires-at",
  "zeroagent.relay.auth-kind",
  "zeroagent.relay.oauth-client-id",
];
let current: NativeAccountSession | null = null;
let initialization: Promise<NativeAccountSession | null> | undefined;
let listening: Promise<unknown> | undefined;
let authenticationRejected = false;
let generation = 0;

function clearLegacy() {
  for (const key of legacyKeys) localStorage.removeItem(key);
}

function validate(value: NativeAccountSession): NativeAccountSession {
  if (
    !/^za-session-[a-f0-9]{64}$/.test(value?.sessionHandle ?? "") ||
    !Number.isSafeInteger(value.user?.id) ||
    value.user.id <= 0 ||
    !["oauth", "password"].includes(value.authKind) ||
    typeof value.accountScope !== "string" ||
    !Number.isFinite(value.expiresAtMs) ||
    !value.accountScope.endsWith(`|user:${value.user.id}`) ||
    "access_token" in value ||
    "refresh_token" in value
  )
    throw new Error("Native account session response is incompatible");
  return value;
}

export function nativeSessionHandle() {
  return current?.sessionHandle ?? "";
}
export function nativeSessionSummary() {
  return current;
}

export function acceptNativeSession(value: NativeAccountSession) {
  const next = validate(value);
  const previous = current?.sessionHandle;
  generation += 1;
  current = next;
  authenticationRejected = false;
  clearLegacy();
  initialization = Promise.resolve(next);
  if (previous !== next.sessionHandle)
    window.dispatchEvent(new Event("zeroagent:relay-token-changed"));
}

export function clearNativeSession(expectedHandle?: string | null): boolean {
  if (expectedHandle && current?.sessionHandle !== expectedHandle) return false;
  generation += 1;
  current = null;
  clearLegacy();
  initialization = Promise.resolve(null);
  window.dispatchEvent(new Event("zeroagent:relay-token-changed"));
  return true;
}

export function nativeAuthenticationError(error: unknown): boolean {
  return (error instanceof Error ? error.message : error) === "USA_ZERO_PROFILE_AUTH_REQUIRED";
}

export async function initializeNativeAccount(): Promise<NativeAccountSession | null> {
  if (!initialization) {
    const ticket = generation;
    initialization = (async () => {
      listening ??= listen<string>("account-session-ended", ({ payload }) => {
        if (clearNativeSession(payload))
          window.dispatchEvent(new Event("zeroagent:relay-session-changed"));
      });
      await listening;
      if (generation !== ticket) return current;
      let value = await invoke<NativeAccountSession | null>("account_session_bootstrap");
      if (generation !== ticket) return current;
      if (!value) {
        const accessToken = localStorage.getItem(legacyKeys[0])?.trim() ?? "";
        const refreshToken = localStorage.getItem(legacyKeys[1])?.trim() || null;
        if (accessToken || refreshToken) {
          value = await invoke<NativeAccountSession>("account_session_import_legacy", {
            legacy: {
              accessToken,
              refreshToken,
              expiresAtMs: Number(localStorage.getItem(legacyKeys[2])) || 0,
              authKind: localStorage.getItem(legacyKeys[3]) === "oauth" ? "oauth" : "password",
            },
          });
        }
      }
      if (generation !== ticket) return current;
      if (value) acceptNativeSession(value);
      return current;
    })().catch((error) => {
      if (generation !== ticket) return current;
      initialization = undefined;
      if (nativeAuthenticationError(error)) {
        authenticationRejected = true;
        clearLegacy();
      }
      throw error;
    });
  }
  return initialization;
}

export async function requireNativeSession(forceRefresh = false): Promise<NativeAccountSession> {
  const value = await initializeNativeAccount();
  if (!value) throw new Error("USA_ZERO_PROFILE_AUTH_REQUIRED");
  const handle = value.sessionHandle;
  if (forceRefresh || value.expiresAtMs <= Date.now() + 60_000) {
    try {
      const next = await invoke<NativeAccountSession>("account_session_current", {
        sessionHandle: handle,
        forceRefresh,
      });
      if (current?.sessionHandle !== handle || next.sessionHandle !== handle)
        throw new Error("USA-Zero account session changed");
      acceptNativeSession(next);
    } catch (error) {
      if (nativeAuthenticationError(error) && clearNativeSession(handle)) {
        authenticationRejected = true;
        window.dispatchEvent(new Event("zeroagent:relay-session-changed"));
      }
      throw error;
    }
  }
  if (!current || current.sessionHandle !== handle)
    throw new Error("USA-Zero account session changed");
  return current;
}

export function rejectNativeSession(handle: string | null): boolean {
  if (handle ? !clearNativeSession(handle) : !authenticationRejected) return false;
  authenticationRejected = false;
  if (!handle) clearNativeSession();
  window.dispatchEvent(new Event("zeroagent:relay-session-changed"));
  return true;
}

export async function nativeAccountRequest<T>(
  path: string,
  method: string,
  body: unknown,
  authenticated: boolean,
  app: boolean,
): Promise<T> {
  const value = authenticated ? await requireNativeSession() : null;
  const handle = value?.sessionHandle;
  try {
    const response = await invoke<{
      status: number;
      body: { code?: number; success?: boolean; data?: T; message?: string };
    }>("account_session_http", {
      request: {
        sessionHandle: handle ?? null,
        path: `/api/v1${path.startsWith("/") ? path : `/${path}`}`,
        method,
        body: body ?? null,
      },
    });
    if (handle && current?.sessionHandle !== handle)
      throw new Error("USA-Zero account session changed");
    if (
      response.status < 200 ||
      response.status >= 300 ||
      (app ? response.body.success !== true : response.body.code !== 0) ||
      response.body.data === undefined
    ) {
      throw new Error(response.body.message || `USA-Zero request failed (HTTP ${response.status})`);
    }
    return response.body.data;
  } catch (error) {
    if (handle && nativeAuthenticationError(error)) rejectNativeSession(handle);
    throw error;
  }
}

export async function nativeRevealKey(id: number, password: string): Promise<string> {
  const value = await requireNativeSession();
  const key = await invoke<string>("account_session_reveal_key", {
    sessionHandle: value.sessionHandle,
    keyId: id,
    password,
  });
  if (current?.sessionHandle !== value.sessionHandle)
    throw new Error("USA-Zero account session changed");
  return key;
}

export async function logoutNativeAccount() {
  const value = await initializeNativeAccount();
  if (value) await invoke("account_session_logout", { sessionHandle: value.sessionHandle });
  if (!value || clearNativeSession(value.sessionHandle))
    window.dispatchEvent(new Event("zeroagent:relay-session-changed"));
}
