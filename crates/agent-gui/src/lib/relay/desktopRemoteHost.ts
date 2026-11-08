import { invoke } from "@tauri-apps/api/core";
import type { DesktopRemoteHost } from "@/lib/desktopRemoteHost";
import type { ExecutionSelection } from "@/lib/executionTargets";
import { openUrl } from "../../shims/tauriOpener";
import type { AppSettings } from "../settings";
import {
  bindRelayEmail,
  changeRelayPassword,
  createRelayApiKey,
  getRelayDashboardStats,
  getRelayProfile,
  listRelayApiKeys,
  listRelayGroups,
  logoutRelay,
  RELAY_ORIGIN,
  revealRelayApiKey,
  sendRelayEmailBindingCode,
  updateRelayProfile,
} from "./client";
import {
  type DesktopEnvironment,
  desktopGatewayOrigin,
  getDesktopEnvironments,
} from "./desktopExecution";
import { desktopRequest } from "./desktopRequest";
import {
  type NativeAccountSession,
  nativeSessionHandle,
  requireNativeSession,
} from "./nativeSession";

type RemoteOpen = { bridgeId: string; selection: ExecutionSelection };
type RemoteHttp = { status: number; headers: Record<string, string>; bodyBase64: string };
type HostInput = {
  initialView?: DesktopRemoteHost["initialView"];
  settings: AppSettings;
  environment: DesktopEnvironment;
  environments: DesktopEnvironment[];
  selectionLease: string;
  workspaceId?: string;
  expiresAt: number;
  signal?: AbortSignal;
  onHeaderTarget?: DesktopRemoteHost["onHeaderTarget"];
  onWindowControlsTarget?: DesktopRemoteHost["onWindowControlsTarget"];
  onUpdateTarget?: DesktopRemoteHost["onUpdateTarget"];
  settingsNavigation?: DesktopRemoteHost["settingsNavigation"];
  accountNavigation?: DesktopRemoteHost["accountNavigation"];
  onAccountSurface?: DesktopRemoteHost["onAccountSurface"];
  onSelectionInvalid: DesktopRemoteHost["onSelectionInvalid"];
};
type Dependencies = {
  invoke?: typeof invoke;
  session?: () => Promise<NativeAccountSession>;
  currentSession?: () => string;
  accountRequest?: (path: string, init?: RequestInit) => Promise<Response>;
};

export function isDesktopRemoteTargetAuthorized(
  environment: Pick<DesktopEnvironment, "device_id" | "online">,
  selectionLease: string,
  expiresAt: number,
  now = Date.now(),
) {
  return Boolean(
    environment.device_id.trim() &&
      environment.online &&
      selectionLease.trim() &&
      Number.isFinite(expiresAt) &&
      expiresAt > now,
  );
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function objectBody(init?: RequestInit): Record<string, unknown> {
  if (!init?.body) return {};
  if (typeof init.body !== "string") throw new Error("账号请求格式无效。");
  const value: unknown = JSON.parse(init.body);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("账号请求格式无效。");
  return value as Record<string, unknown>;
}

/** Account actions retain the existing Native masking and password-proof boundary. */
export async function desktopAccountRequest(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(path, "http://account.invalid");
  const method = (init?.method ?? "GET").toUpperCase();
  const body = objectBody(init);
  let value: unknown;
  if (url.pathname === "/api/auth/me" && method === "GET") {
    const session = await requireNativeSession();
    const user = await getRelayProfile();
    return jsonResponse({ user: { ...user, auth_kind: session.authKind } });
  }
  if (url.pathname === "/api/auth/logout" && method === "POST") {
    await logoutRelay();
    return jsonResponse(null, 204);
  }
  switch (`${method} ${url.pathname}`) {
    case "GET /api/usa-zero/user/profile": {
      const session = await requireNativeSession();
      value = { ...(await getRelayProfile()), auth_kind: session.authKind };
      break;
    }
    case "GET /api/usa-zero/usage/dashboard/stats":
      value = await getRelayDashboardStats();
      break;
    case "PUT /api/usa-zero/user":
      value = await updateRelayProfile(body);
      break;
    case "GET /api/usa-zero/keys": {
      const items = await listRelayApiKeys();
      value = { items, total: items.length, page: 1, pages: 1, page_size: items.length };
      break;
    }
    case "GET /api/usa-zero/groups/available":
      value = await listRelayGroups();
      break;
    case "POST /api/usa-zero/keys":
      value = await createRelayApiKey(String(body.name ?? ""), Number(body.group_id));
      break;
    case "POST /api/usa-zero/user/account-bindings/email/send-code":
      value = await sendRelayEmailBindingCode(String(body.email ?? ""));
      break;
    case "POST /api/usa-zero/user/account-bindings/email":
      value = await bindRelayEmail(
        String(body.email ?? ""),
        String(body.verify_code ?? ""),
        String(body.password ?? ""),
      );
      break;
    case "PUT /api/usa-zero/user/password":
      value = await changeRelayPassword(
        String(body.old_password ?? ""),
        String(body.new_password ?? ""),
      );
      break;
    default:
      throw new Error("此账号操作请通过桌面账号入口或 USA-Zero 完成。");
  }
  return jsonResponse({ code: 0, data: value });
}

function base64(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384)
    value += String.fromCharCode(...bytes.subarray(offset, offset + 16_384));
  return btoa(value);
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
  const raw = atob(value);
  const result = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) result[index] = raw.charCodeAt(index);
  return result;
}

/** One captured Native account, device and lease. Never falls back to local execution. */
export async function createDesktopRemoteHost(input: HostInput, dependencies: Dependencies = {}) {
  const call = dependencies.invoke ?? invoke;
  const currentSession = dependencies.currentSession ?? nativeSessionHandle;
  const session = await (dependencies.session ?? requireNativeSession)();
  const gatewayOrigin = desktopGatewayOrigin(input.settings);
  let disposed = false;
  let bridgeId = "";
  const isCurrent = () =>
    !disposed &&
    !input.signal?.aborted &&
    currentSession() === session.sessionHandle &&
    isDesktopRemoteTargetAuthorized(input.environment, input.selectionLease, input.expiresAt);
  const requireCurrent = () => {
    if (!isCurrent()) throw new Error("远程设备连接或控制权限已失效，请重新选择设备。");
  };
  const close = () => {
    if (!bridgeId) return;
    const closing = bridgeId;
    bridgeId = "";
    void call("account_remote_close", {
      request: { sessionHandle: session.sessionHandle, bridgeId: closing },
    }).catch(() => undefined);
  };
  const dispose = () => {
    disposed = true;
    close();
  };
  input.signal?.addEventListener("abort", dispose, { once: true });
  try {
    requireCurrent();
    const opened = await call<RemoteOpen>("account_remote_open", {
      request: {
        sessionHandle: session.sessionHandle,
        origin: gatewayOrigin,
        deviceId: input.environment.device_id,
        selectionLease: input.selectionLease,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      },
    });
    bridgeId = opened.bridgeId;
    requireCurrent();
    if (
      !bridgeId ||
      !opened.selection.selection_lease?.trim() ||
      opened.selection.runtime_kind !== "device_agent" ||
      opened.selection.device_id !== input.environment.device_id ||
      (opened.selection.workspace_id ?? "") !== (input.workspaceId ?? "")
    )
      throw new Error("远程设备授权响应无效。");
    const selection: ExecutionSelection = {
      ...opened.selection,
      expires_at: new Date(input.expiresAt).toISOString(),
    };
    const host: DesktopRemoteHost = {
      sessionHandle: session.sessionHandle,
      accountScope: session.accountScope,
      accountSecurityUrl: `${RELAY_ORIGIN}/profile/security`,
      accountUser: { ...session.user, auth_kind: session.authKind },
      gatewayOrigin,
      environment: {
        ...input.environment,
        capabilities: ["agent", "files", "terminal", "git", "mcp", "hooks", "cron"],
      },
      environments: input.environments.map((item) => ({
        ...item,
        capabilities: ["agent", "files", "terminal", "git", "mcp", "hooks", "cron"],
      })),
      selection,
      isCurrent,
      onHeaderTarget: input.onHeaderTarget,
      onWindowControlsTarget: input.onWindowControlsTarget,
      onUpdateTarget: input.onUpdateTarget,
      settingsNavigation: input.settingsNavigation,
      accountNavigation: input.accountNavigation,
      onAccountSurface: input.onAccountSurface,
      initialView: input.initialView,
      onSelectionInvalid: input.onSelectionInvalid,
      logout: async () => {
        requireCurrent();
        await logoutRelay();
      },
      openExternal: async (url) => {
        requireCurrent();
        await openUrl(url);
      },
      revealKey: async (id, password) => {
        requireCurrent();
        const value = await revealRelayApiKey(id, password);
        requireCurrent();
        return value;
      },
      async request(path, init) {
        requireCurrent();
        if (init?.signal?.aborted) throw init.signal.reason;
        const url = new URL(path, gatewayOrigin);
        if (url.origin !== gatewayOrigin || !url.pathname.startsWith("/api/"))
          throw new Error("远程请求超出已配置 Gateway。");
        let response: Response;
        if (url.pathname.startsWith("/api/usa-zero/") || url.pathname.startsWith("/api/auth/")) {
          response = await (dependencies.accountRequest ?? desktopAccountRequest)(
            `${url.pathname}${url.search}`,
            init,
          );
        } else if (url.pathname === "/api/environments") {
          const latest = await getDesktopEnvironments(input.settings);
          requireCurrent();
          response = jsonResponse({
            environments: (latest?.environments ?? []).map((item) => ({
              ...item,
              name: item.device_name || item.name,
              capabilities: ["agent", "files", "terminal", "git", "mcp", "hooks", "cron"],
            })),
          });
        } else if (/^\/api\/devices\/[^/]+$/.test(url.pathname)) {
          const value = await desktopRequest(
            input.settings,
            url.pathname.replace("/api/devices/", "/api/desktop/devices/"),
            {
              method: init?.method,
              body: init?.body,
              signal: init?.signal,
            },
          );
          response = jsonResponse(value, init?.method === "DELETE" ? 204 : 200);
        } else {
          const request = new Request(url.href, { ...init, signal: undefined });
          const headers: Record<string, string> = {};
          for (const name of ["content-type", "authorization", "x-zeroagent-workspace-path"]) {
            const value = request.headers.get(name);
            if (value) headers[name] = value;
          }
          const body =
            request.method === "GET" || request.method === "HEAD"
              ? undefined
              : new Uint8Array(await request.arrayBuffer());
          requireCurrent();
          const result = await call<RemoteHttp>("account_remote_http", {
            request: {
              sessionHandle: session.sessionHandle,
              bridgeId,
              path: `${url.pathname}${url.search}`,
              method: request.method,
              headers,
              bodyBase64: body ? base64(body) : null,
            },
          });
          response = new Response(
            result.status === 204 || result.status === 304 ? null : bytes(result.bodyBase64),
            {
              status: result.status,
              headers: result.headers,
            },
          );
        }
        requireCurrent();
        if (init?.signal?.aborted) throw init.signal.reason;
        return response;
      },
    };
    return { host, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
