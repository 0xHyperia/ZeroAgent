import { accountFetch } from "./accountRequest";
import { notifyRelaySessionExpired } from "./relay/client";

export type ExecutionWorkspace = {
  id: string;
  name: string;
  path?: string;
};

export type ExecutionEnvironment = {
  runtime_kind: "web_chat" | "device_agent";
  device_id?: string;
  agent_id?: string;
  device_name?: string;
  name: string;
  online: boolean;
  platform?: string;
  version?: string;
  last_seen_at?: string;
  workspaces: ExecutionWorkspace[];
  target_fingerprint?: string;
  capabilities: string[];
};

export type ExecutionPresence = {
  agent_id?: string;
  online: boolean;
};

export const EXECUTION_PRESENCE_EVENT = "zeroagent:execution-presence";

export function mergeExecutionPresence(
  environments: readonly ExecutionEnvironment[],
  presence: readonly ExecutionPresence[],
): ExecutionEnvironment[] {
  const onlineByAgent = new Map(
    presence
      .map((item) => [item.agent_id?.trim() ?? "", item.online] as const)
      .filter(([agentId]) => agentId !== ""),
  );
  if (onlineByAgent.size === 0) return [...environments];
  return environments.map((environment) => {
    if (environment.runtime_kind !== "device_agent") return environment;
    const agentId = (environment.agent_id ?? environment.device_id ?? "").trim();
    const online = onlineByAgent.get(agentId);
    return online === undefined || online === environment.online
      ? environment
      : { ...environment, online };
  });
}

export function publishExecutionPresence(presence: readonly ExecutionPresence[]) {
  window.dispatchEvent(
    new CustomEvent<ExecutionPresence[]>(EXECUTION_PRESENCE_EVENT, {
      detail: [...presence],
    }),
  );
}

export function subscribeExecutionPresence(
  listener: (presence: readonly ExecutionPresence[]) => void,
): () => void {
  const handle = (event: Event) => {
    listener((event as CustomEvent<ExecutionPresence[]>).detail ?? []);
  };
  window.addEventListener(EXECUTION_PRESENCE_EVENT, handle);
  return () => window.removeEventListener(EXECUTION_PRESENCE_EVENT, handle);
}

export type ExecutionSelection = {
  selection_lease: string;
  runtime_kind: "web_chat" | "device_agent";
  device_id?: string;
  agent_id?: string;
  workspace_id: string;
  scope?: "workspace" | "device";
  target_fingerprint: string;
  conversation_id: string;
  expires_at: string;
};

export function resolveExecutionTarget(
  environments: readonly ExecutionEnvironment[],
  selection: ExecutionSelection | null,
  activeWorkspaceId = "",
) {
  const environment = environments.find(
    (item) =>
      item.runtime_kind === selection?.runtime_kind &&
      (item.device_id ?? "") === (selection?.device_id ?? ""),
  );
  const workspaceId =
    selection?.runtime_kind === "device_agent" ? activeWorkspaceId : selection?.workspace_id;
  const workspace = environment?.workspaces.find((item) => item.id === workspaceId);
  return { environment, workspace };
}

export function canReuseDeviceSelection(
  selection: ExecutionSelection | null,
  environment: ExecutionEnvironment,
): selection is ExecutionSelection {
  if (
    selection?.runtime_kind !== "device_agent" ||
    environment.runtime_kind !== "device_agent" ||
    environment.device_id !== selection.device_id ||
    !selection.selection_lease.trim()
  ) {
    return false;
  }
  return !selection.expires_at || Date.parse(selection.expires_at) > Date.now();
}

async function accountRequest<T>(
  path: string,
  init?: RequestInit,
  expireSessionOnUnauthorized = true,
): Promise<T> {
  const response = await accountFetch(path, {
    ...init,
    credentials: "include",
    headers: { Accept: "application/json", "Content-Type": "application/json", ...init?.headers },
  });
  if (response.status === 401 && expireSessionOnUnauthorized) {
    notifyRelaySessionExpired();
  }
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error || `请求失败 (HTTP ${response.status})`);
  }
  return payload;
}

export async function getExecutionEnvironments(
  surface: "web" | "desktop" = "web",
  localDeviceId = "",
) {
  const query = new URLSearchParams({ surface });
  if (localDeviceId) query.set("local_device_id", localDeviceId);
  const response = await accountRequest<{ environments: ExecutionEnvironment[] }>(
    `/api/environments?${query.toString()}`,
  );
  return response.environments;
}

export async function renameExecutionDevice(deviceId: string, name: string) {
  const response = await accountRequest<{ device: ExecutionEnvironment }>(
    `/api/devices/${encodeURIComponent(deviceId)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  return response.device;
}

export async function revokeExecutionDevice(deviceId: string) {
  await accountRequest<void>(`/api/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
}

export async function selectExecutionTarget(
  environment: ExecutionEnvironment,
  workspace: ExecutionWorkspace,
  scope: "workspace" | "device" = environment.runtime_kind === "device_agent"
    ? "device"
    : "workspace",
): Promise<ExecutionSelection> {
  const workspaceId = scope === "device" ? "" : workspace.id;
  const target = [environment.runtime_kind, environment.device_id ?? "", workspaceId].join(":");
  return accountRequest<ExecutionSelection>(
    "/api/execution-target/select",
    {
      method: "POST",
      body: JSON.stringify({
        runtime_kind: environment.runtime_kind,
        device_id: environment.device_id ?? "",
        workspace_id: workspaceId,
        scope,
        target_fingerprint: target,
      }),
    },
    false,
  );
}

export function encodeSelectionCredential(selection: ExecutionSelection) {
  const json = JSON.stringify({
    lease: selection.selection_lease,
    runtimeKind: selection.runtime_kind,
    deviceId: selection.device_id ?? "",
    agentId: selection.agent_id ?? selection.device_id ?? "",
    workspaceId: selection.workspace_id,
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `selection.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export async function validateExecutionSelection(selection: ExecutionSelection): Promise<boolean> {
  if (selection.runtime_kind !== "device_agent" || !selection.selection_lease.trim()) return false;
  try {
    const response = await accountFetch("/api/status", {
      credentials: "include",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${encodeSelectionCredential(selection)}`,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function decodeSelectionCredential(value: string): {
  lease: string;
  runtimeKind: string;
  deviceId: string;
  agentId: string;
  workspaceId: string;
} | null {
  if (!value.startsWith("selection.")) return null;
  try {
    const encoded = value.slice("selection.".length).replaceAll("-", "+").replaceAll("_", "/");
    const padded = encoded + "=".repeat((4 - (encoded.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as {
      lease: string;
      runtimeKind: string;
      deviceId: string;
      agentId: string;
      workspaceId: string;
    };
  } catch {
    return null;
  }
}
