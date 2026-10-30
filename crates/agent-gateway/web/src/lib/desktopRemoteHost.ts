import type { WorkbenchNavigationPortal } from "@liveagent/ui/application/workbenchNavigationPortal";
import type { ExecutionEnvironment, ExecutionSelection } from "./executionTargets";
import type { RelayUser } from "./relay/client";

/** Public host capabilities. Account and device credentials remain in Native. */
export type DesktopRemoteHost = {
  sessionHandle: string;
  accountScope: string;
  gatewayOrigin: string;
  accountUser: RelayUser;
  environment: ExecutionEnvironment;
  environments: ExecutionEnvironment[];
  selection: ExecutionSelection;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  isCurrent: () => boolean;
  revealKey?: (keyId: number, password: string) => Promise<string>;
  logout?: () => Promise<void>;
  openExternal?: (url: string) => Promise<void>;
  accountSecurityUrl?: string;
  onHeaderTarget?: (element: HTMLElement | null) => void;
  onAccountTarget?: (element: HTMLElement | null) => void;
  onWindowControlsTarget?: (element: HTMLElement | null) => void;
  onUpdateTarget?: (element: HTMLElement | null) => void;
  settingsNavigation?: WorkbenchNavigationPortal;
  onSelectionInvalid: (reason: string) => void;
};

// The desktop loads a new, single-file module instance for each target mount.
// Retain a disposed host as a tombstone: delayed work must never fall through
// to browser requests or borrow a subsequent account/target's capabilities.
let desktopHost: DesktopRemoteHost | undefined;
let disposed = false;
let invalidNotified = false;

export function getDesktopRemoteHost(): DesktopRemoteHost | undefined {
  return desktopHost;
}

export function installDesktopRemoteHost(host: DesktopRemoteHost): () => void {
  if (desktopHost) throw new Error("Desktop remote modules cannot be reused across targets");
  const origin = new URL(host.gatewayOrigin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !host.sessionHandle.trim() ||
    !host.accountScope.trim() ||
    !Number.isSafeInteger(host.accountUser.id) ||
    host.accountUser.id <= 0 ||
    host.environment.runtime_kind !== "device_agent" ||
    !host.environment.device_id?.trim() ||
    host.selection.runtime_kind !== "device_agent" ||
    host.selection.device_id !== host.environment.device_id ||
    !host.selection.selection_lease.trim()
  )
    throw new Error("Invalid desktop remote host");
  desktopHost = host;
  return () => {
    disposed = true;
  };
}

export function requireCurrentDesktopRemoteHost(): DesktopRemoteHost {
  const host = desktopHost;
  const expiresAt = host?.selection.expires_at ? Date.parse(host.selection.expires_at) : NaN;
  if (
    !host ||
    disposed ||
    !host.isCurrent() ||
    !host.environment.online ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now()
  ) {
    if (host && !disposed && !invalidNotified) {
      invalidNotified = true;
      host.onSelectionInvalid("设备连接或控制权限已失效，请重新选择设备。");
    }
    throw new Error("Desktop remote target is no longer authorized");
  }
  return host;
}

export function gatewayOrigin(): string {
  return (
    desktopHost?.gatewayOrigin ?? (typeof window === "undefined" ? "" : window.location.origin)
  );
}

export function desktopStorageKey(key: string): string {
  if (!desktopHost) return key;
  return `zeroagent.desktop-remote:${JSON.stringify([
    desktopHost.accountScope,
    desktopHost.gatewayOrigin,
    desktopHost.environment.device_id,
  ])}:${key}`;
}

/** Route only this WebUI module's requests through its captured desktop host. */
export const desktopRemoteFetch: typeof fetch = async (input, init) => {
  if (!desktopHost) return globalThis.fetch(input, init);
  const host = requireCurrentDesktopRemoteHost();
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const target = new URL(raw, host.gatewayOrigin);
  if (
    target.origin !== new URL(host.gatewayOrigin).origin ||
    !target.pathname.startsWith("/api/")
  ) {
    throw new Error("Desktop remote request is outside the configured Gateway");
  }
  let request = init;
  if (typeof Request !== "undefined" && input instanceof Request) {
    request = {
      method: input.method,
      headers: input.headers,
      signal: input.signal,
      ...(input.method !== "GET" && input.method !== "HEAD"
        ? { body: await input.clone().arrayBuffer() }
        : {}),
      ...init,
    };
  }
  if (request?.signal?.aborted) throw request.signal.reason;
  const response = await host.request(`${target.pathname}${target.search}`, request);
  requireCurrentDesktopRemoteHost();
  if (request?.signal?.aborted) throw request.signal.reason;
  return response;
};
