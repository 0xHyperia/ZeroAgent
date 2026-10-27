import type {
  KBrainComputerStatus,
  KBrainSettingsAdapter,
  KBrainSettingsDocument,
} from "@liveagent/ui/pages/settings/kbrainSettingsAdapter";
import { getKBrainRuntimeConnection } from "../lib/kbrain/runtimeConnection";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const connection = getKBrainRuntimeConnection();
  if (!connection) throw new Error("ZeroAgent engine connection is not ready");
  const response = await fetch(`${connection.baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(connection.token ? { Authorization: `Bearer ${connection.token}` } : {}),
      ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok)
    throw new Error(
      (await response.text()) || `ZeroAgent engine request failed (${response.status})`,
    );
  const document = await response.json();
  if (
    path === "/v1/settings" &&
    response.headers.get("X-ZeroAgent-Configuration") === "zeroagent.configuration.v1"
  ) {
    document.configurationVersion = response.headers.get("ETag");
  }
  return document as T;
}

export const kbrainSettingsAdapter: KBrainSettingsAdapter = {
  isKbrain: true,
  runtimeConnection: getKBrainRuntimeConnection,
  getConnection: getKBrainRuntimeConnection,
  getSettings: () => request<KBrainSettingsDocument>("/v1/settings"),
  getComputerStatus: () => request<KBrainComputerStatus>("/v1/computer"),
  getCapabilities: () =>
    request<{ capabilities?: Record<string, unknown> }>("/v1/health").then(
      (health) => health.capabilities ?? {},
    ),
  updateSettings: (update, baseline) =>
    request<KBrainSettingsDocument>("/v1/settings", {
      method: "PUT",
      body: JSON.stringify(update),
      headers: baseline?.configurationVersion ? { "If-Match": baseline.configurationVersion } : {},
    }),
};

export const settingsHostAdapter = {
  isKbrain: true as const,
  runtimeConnection: getKBrainRuntimeConnection,
  kbrain: kbrainSettingsAdapter,
};
