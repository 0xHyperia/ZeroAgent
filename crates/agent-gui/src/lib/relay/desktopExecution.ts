import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../settings";
import { desktopRequest } from "./desktopRequest";

export type DesktopWorkspace = {
  id: string;
  name: string;
  path?: string;
  kind?: "managed" | "folder" | "history";
  is_pinned?: boolean;
  pinned_at?: number;
  archived?: boolean;
  missing?: boolean;
  updated_at?: number;
};
export type DesktopEnvironment = {
  runtime_kind: "device_agent";
  device_id: string;
  agent_id?: string;
  device_name?: string;
  name: string;
  online: boolean;
  platform?: string;
  version?: string;
  last_seen_at?: string;
  workspaces: DesktopWorkspace[];
};

type CredentialRecord = { agentId?: string; deviceId?: string };

function gatewayURL(settings: AppSettings) {
  const url = new URL(settings.remote.gatewayUrl.trim());
  if (settings.remote.gatewayPort > 0) url.port = String(settings.remote.gatewayPort);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url;
}

export async function getDesktopEnvironments(settings: AppSettings) {
  if (!settings.remote.enabled || !settings.remote.gatewayUrl.trim()) return null;
  const credential = await invoke<CredentialRecord | null>("device_credential_get");
  const localAgentId = credential?.agentId?.trim() || credential?.deviceId?.trim() || "";
  if (!localAgentId) return null;
  const searchParams = new URLSearchParams({
    local_agent_id: localAgentId,
    local_device_id: localAgentId,
  });
  const response = await desktopRequest<{ environments: DesktopEnvironment[] }>(
    settings,
    "/api/desktop/environments",
    undefined,
    searchParams,
  );
  return { environments: response.environments, localDeviceId: localAgentId };
}

export async function renameDesktopDevice(settings: AppSettings, deviceId: string, name: string) {
  const response = await desktopRequest<{ device: DesktopEnvironment }>(
    settings,
    `/api/desktop/devices/${encodeURIComponent(deviceId)}`,
    { method: "PATCH", body: JSON.stringify({ name }) },
  );
  return response.device;
}

export async function revokeDesktopDevice(settings: AppSettings, deviceId: string) {
  await desktopRequest<void>(settings, `/api/desktop/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
}
export async function switchDesktopEnvironment(
  settings: AppSettings,
  environment: DesktopEnvironment,
  workspace: DesktopWorkspace,
) {
  const target = `device_agent:${environment.device_id}:${workspace.id}`;
  const selection = await desktopRequest<{ selection_lease: string }>(
    settings,
    "/api/desktop/execution-target/select",
    {
      method: "POST",
      body: JSON.stringify({
        runtime_kind: "device_agent",
        device_id: environment.device_id,
        workspace_id: workspace.id,
        target_fingerprint: target,
      }),
    },
  );
  return selection;
}

export function desktopGatewayOrigin(settings: AppSettings) {
  return gatewayURL(settings).origin;
}

export function encodeDesktopSelectionCredential(
  lease: string,
  deviceId: string,
  workspaceId = "",
) {
  const json = JSON.stringify({
    lease,
    runtimeKind: "device_agent",
    deviceId,
    workspaceId,
  });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `selection.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export type DesktopConversationRoute = {
  conversation_id: string;
  device_id: string;
  workspace_id: string;
  title: string;
  summary: string;
  created_at: string;
  updated_at: string;
  device_name?: string;
  device_online: boolean;
};

export async function getDesktopConversationRoutes(settings: AppSettings, deviceId: string) {
  const searchParams = new URLSearchParams({ device_id: deviceId });
  const response = await desktopRequest<{ conversations: DesktopConversationRoute[] }>(
    settings,
    "/api/desktop/conversation-routes",
    undefined,
    searchParams,
  );
  return response.conversations;
}

export async function switchDesktopDevice(settings: AppSettings, environment: DesktopEnvironment) {
  const target = `device_agent:${environment.device_id}:`;
  return desktopRequest<{
    selection_lease: string;
    scope: "device";
    device_id: string;
    expires_at: string;
  }>(settings, "/api/desktop/execution-target/select", {
    method: "POST",
    body: JSON.stringify({
      runtime_kind: "device_agent",
      device_id: environment.device_id,
      workspace_id: "",
      scope: "device",
      target_fingerprint: target,
    }),
  });
}
