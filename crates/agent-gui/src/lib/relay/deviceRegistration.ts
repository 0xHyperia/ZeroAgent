import { invoke } from "@tauri-apps/api/core";
import type { AppSettings } from "../settings";
import { workspaceProjectPathKey } from "../settings";
import { getRelayAccessToken } from "./client";

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

function registrationURL(settings: AppSettings) {
  const url = new URL(settings.remote.gatewayUrl.trim());
  if (settings.remote.gatewayPort > 0) url.port = String(settings.remote.gatewayPort);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/api/desktop/devices/register`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function installationID() {
  const key = "zerobox.installation-id";
  const current = localStorage.getItem(key)?.trim();
  if (current) return current;
  const created = crypto.randomUUID();
  localStorage.setItem(key, created);
  return created;
}

export async function registerDesktopDevice(settings: AppSettings) {
  const accessToken = getRelayAccessToken();
  if (!settings.remote.enabled || !settings.remote.gatewayUrl.trim() || !accessToken) return null;
  const existing = await invoke<CredentialRecord | null>("device_credential_get");
  const existingAgentId = effectiveAgentId(existing);
  const existingToken = effectiveAgentToken(existing);
  const hasCanonicalCredential = Boolean(existing?.agentId?.trim() && existing?.token?.trim());
  const defaultName = await invoke<string>("device_default_name");
  const response = await fetch(registrationURL(settings), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      installation_id: installationID(),
      name: existing ? "" : defaultName,
      platform: navigator.platform || "desktop",
      version: await invoke<string>("zeroagent_app_version"),
      agent_id: hasCanonicalCredential ? existingAgentId : existing ? "" : settings.remote.agentId,
      agent_token: hasCanonicalCredential ? existingToken : "",
      device_id: hasCanonicalCredential ? "" : existingAgentId,
      device_credential: hasCanonicalCredential ? "" : existingToken,
      workspaces: settings.system.workspaceProjects.map((workspace) => {
        const pathKey = workspaceProjectPathKey(workspace.path);
        return {
          id: workspace.id,
          name: workspace.name,
          path: workspace.path,
          kind: workspace.kind,
          is_pinned: workspace.isPinned === true,
          pinned_at: workspace.pinnedAt ?? 0,
          archived: settings.system.archivedWorkspaceProjectPaths.some(
            (path) => workspaceProjectPathKey(path) === pathKey,
          ),
          missing: settings.system.missingWorkspaceProjectPaths.some(
            (path) => workspaceProjectPathKey(path) === pathKey,
          ),
          updated_at: workspace.updatedAt,
        };
      }),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    device?: { id: string; agent_id?: string };
    agent_id?: string;
    agent_token?: string;
    device_id?: string;
    device_credential?: string;
    error?: string;
  } | null;
  if (!response.ok || !payload?.device?.id) {
    throw new Error(payload?.error || `设备注册失败 (HTTP ${response.status})`);
  }
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
  const url = registrationURL(settings).replace(
    /\/register$/,
    `/${encodeURIComponent(agentId)}/rotate-token`,
  );
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(30_000),
  });
  const payload = (await response.json().catch(() => null)) as {
    agent_id?: string;
    agent_token?: string;
    device_id?: string;
    device_credential?: string;
    error?: string;
  } | null;
  const nextAgentId = payload?.agent_id?.trim() || payload?.device_id?.trim() || agentId.trim();
  const nextToken = payload?.agent_token?.trim() || payload?.device_credential?.trim() || "";
  if (!response.ok || !nextAgentId || !nextToken) {
    throw new Error(payload?.error || `Agent token rotation failed (HTTP ${response.status})`);
  }
  await invoke("device_credential_set", {
    record: { agentId: nextAgentId, token: nextToken, deviceId: "", credential: "" },
  });
}
