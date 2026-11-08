import type {
  WorkbenchAccountLayout,
  WorkbenchAccountNavigation,
  WorkbenchAccountSurface,
} from "@liveagent/ui/application/workbenchAccountSurface";
import type { WorkbenchNavigationPortal } from "@liveagent/ui/application/workbenchNavigationPortal";
import type { AppSettings } from "@liveagent/ui/lib/settings/types";
import type { CloudChatPresentationResource } from "./cloudChatPresentation";
import type { CloudTaskReaderRoute } from "./cloudChatRoute";
import type { CloudTaskConversationSelection } from "./cloudSchedules";
import type { ExecutionEnvironment, ExecutionSelection } from "./executionTargets";
import type { RelayUser } from "./relay/client";
import type { WorkspaceHandoff } from "./workspaceHandoff";

export type DesktopTaskConversation = CloudTaskConversationSelection & {
  resource?: CloudChatPresentationResource;
  reader?: CloudTaskReaderRoute;
  onReaderChange?: (reader?: CloudTaskReaderRoute) => void;
  onChromeTarget?: (element: HTMLDivElement | null) => void;
};

export type DesktopAccountLayout = WorkbenchAccountLayout;

export type DesktopCloudHost = {
  kind: "cloud";
  accountScope: string;
  gatewayOrigin: string;
  accountUser: RelayUser;
  taskConversation?: DesktopTaskConversation;
  accountLayout?: DesktopAccountLayout;
  initialActive?: boolean;
  onMountReady?: () => void;
  onMountError?: () => void;
  getHandoffEnvironments?: () => ExecutionEnvironment[];
  sendWorkspaceHandoff?: (request: WorkspaceHandoff) => Promise<string | null>;
  clientPreferences?: () => Pick<AppSettings, "locale" | "theme">;
  updateClientPreferences?: (preferences: Pick<AppSettings, "locale" | "theme">) => void;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  isCurrent: () => boolean;
  onOpenDeviceSettings?: (section: "skills" | "mcp") => void;
  onUserChange: (user: RelayUser) => void;
  onLogout: () => void;
  openExternal: (url: string) => Promise<void>;
  readLocation: () => string;
  readConversation: () => string;
  readSkillReaderReturn?: () => string | undefined;
  saveLocation: (href: string, conversation: string, skillReaderReturn?: string) => void;
  subscribeLocation: (listener: () => void) => () => void;
  registerNavigationGuard?: (guard: (navigate: () => void) => void) => () => void;
};

/** Public host capabilities. Account and device credentials remain in Native. */
export type DesktopRemoteHost = {
  initialView?: "cron-hub";
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
  accountNavigation?: WorkbenchAccountNavigation;
  onAccountSurface?: (surface: WorkbenchAccountSurface | null) => void;
  onSelectionInvalid: (reason: string) => void;
};

// The desktop loads a new, single-file module instance for each target mount.
// Retain a disposed host as a tombstone: delayed work must never fall through
// to browser requests or borrow a subsequent account/target's capabilities.
let desktopHost: DesktopRemoteHost | undefined;
let cloudHost: DesktopCloudHost | undefined;
let disposed = false;
let invalidNotified = false;

export function getDesktopRemoteHost(): DesktopRemoteHost | undefined {
  return desktopHost;
}

export function getDesktopCloudHost(): DesktopCloudHost | undefined {
  return cloudHost;
}

export function installDesktopCloudHost(host: DesktopCloudHost): () => void {
  const origin = new URL(host.gatewayOrigin);
  if (
    desktopHost ||
    cloudHost ||
    !host.isCurrent() ||
    !host.accountScope ||
    !Number.isSafeInteger(host.accountUser.id) ||
    host.accountUser.id <= 0 ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Invalid desktop cloud host");
  cloudHost = host;
  return () => {
    disposed = true;
  };
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
    desktopHost?.gatewayOrigin ??
    cloudHost?.gatewayOrigin ??
    (typeof window === "undefined" ? "" : window.location.origin)
  );
}

export function desktopStorageKey(key: string): string {
  if (cloudHost)
    return `zeroagent.desktop-cloud:${JSON.stringify([cloudHost.accountScope, cloudHost.gatewayOrigin])}:${key}`;
  if (!desktopHost) return key;
  return `zeroagent.desktop-remote:${JSON.stringify([
    desktopHost.accountScope,
    desktopHost.gatewayOrigin,
    desktopHost.environment.device_id,
  ])}:${key}`;
}

/** Route only this WebUI module's requests through its captured desktop host. */
export const desktopRemoteFetch: typeof fetch = async (input, init) => {
  if (!desktopHost && !cloudHost) return globalThis.fetch(input, init);
  if (cloudHost && (disposed || !cloudHost.isCurrent()))
    throw new Error("Desktop cloud account changed");
  const host = cloudHost ?? requireCurrentDesktopRemoteHost();
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
  if (cloudHost) {
    if (disposed || !cloudHost.isCurrent()) throw new Error("Desktop cloud account changed");
  } else requireCurrentDesktopRemoteHost();
  if (request?.signal?.aborted) throw request.signal.reason;
  return response;
};
