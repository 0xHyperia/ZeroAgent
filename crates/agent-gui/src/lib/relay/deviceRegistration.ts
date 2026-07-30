import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../settings";
import { getRelayAccessToken } from "./client";
import { desktopRequest } from "./desktopRequest";
import { getInstallationID } from "./installation";

export type CredentialRecord = {
  agentId?: string;
  token?: string;
  deviceId?: string;
  credential?: string;
};

function effectiveAgentId(record: CredentialRecord | null) {
  return record?.agentId?.trim() || record?.deviceId?.trim() || "";
}

function effectiveAgentToken(record: CredentialRecord | null) {
  return record?.token?.trim() || record?.credential?.trim() || "";
}

export async function registerDesktopDevice(settings: AppSettings) {
  const accessToken = getRelayAccessToken();
  if (!settings.remote.enabled || !settings.remote.gatewayUrl.trim() || !accessToken) return null;
  const existing = await invoke<CredentialRecord | null>("device_credential_get");
  const existingAgentId = effectiveAgentId(existing);
  const existingToken = effectiveAgentToken(existing);
  const hasCanonicalCredential = Boolean(existing?.agentId?.trim() && existing?.token?.trim());
  const defaultName = await invoke<string>("device_default_name");
  const payload = await desktopRequest<{
    device?: { id: string; agent_id?: string };
    agent_id?: string;
    agent_token?: string;
    device_id?: string;
    device_credential?: string;
    error?: string;
  }>(settings, "/api/desktop/devices/register", {
    method: "POST",
    body: JSON.stringify({
      installation_id: getInstallationID(),
      name: existing ? "" : defaultName,
      platform: navigator.platform || "desktop",
      version: await invoke<string>("zeroagent_app_version"),
      agent_id: hasCanonicalCredential ? existingAgentId : existing ? "" : settings.remote.agentId,
      agent_token: hasCanonicalCredential ? existingToken : "",
      device_id: hasCanonicalCredential ? "" : existingAgentId,
      device_credential: hasCanonicalCredential ? "" : existingToken,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!payload.device?.id) throw new Error(payload.error || "Gateway did not return a device");
  const agentId =
    payload.agent_id?.trim() ||
    payload.device.agent_id?.trim() ||
    payload.device.id.trim() ||
    payload.device_id?.trim() ||
    "";
  const token = payload.agent_token?.trim() || payload.device_credential?.trim() || existingToken;
  if (!agentId || !token) throw new Error("Gateway did not return or preserve an Agent token");
  await invoke("device_credential_set", {
    record: { agentId, token, deviceId: "", credential: "" },
  });
  await invoke("gateway_nudge_connection", {
    reason: "device_registered",
    force_reconnect: true,
  });
  return payload.device;
}

export async function rotateDesktopAgentToken(settings: AppSettings, agentId: string) {
  const accessToken = getRelayAccessToken();
  if (!accessToken) throw new Error("USA-Zero login has expired");
  const payload = await desktopRequest<{
    agent_id?: string;
    agent_token?: string;
    device_id?: string;
    device_credential?: string;
    error?: string;
  }>(settings, `/api/desktop/devices/${encodeURIComponent(agentId)}/rotate-token`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
  });
  const nextAgentId = payload.agent_id?.trim() || payload.device_id?.trim() || agentId.trim();
  const nextToken = payload.agent_token?.trim() || payload.device_credential?.trim() || "";
  if (!nextAgentId || !nextToken) {
    throw new Error(payload.error || "Gateway did not return an Agent token");
  }
  await invoke("device_credential_set", {
    record: { agentId: nextAgentId, token: nextToken, deviceId: "", credential: "" },
  });
}
