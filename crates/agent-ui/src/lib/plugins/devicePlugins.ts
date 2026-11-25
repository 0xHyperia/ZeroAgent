import type { WorkspaceFolderTrustClient } from "../../contracts/workspaceFolderTrust";
import type { DeviceUiSurfaceClient } from "./deviceUiSurface";

// The device-scoped subset of the K-brain plugin protocol. Panel
// entries are descriptors. A host must resolve trusted contents separately.
export type DevicePlugin = {
  id: string;
  name: string;
  version: string;
  description: string;
  source: "user" | "workspace";
  enabled: boolean;
  contributes: {
    tools: string[];
    toolDetails?: { name: string; modelName: string; description: string }[];
    hooks: string[];
    prompt: boolean;
    ui: { id: string; title: string; placement: "settings" | "sidePane" }[];
  };
};

export type DevicePluginList = {
  available: boolean;
  trustAvailable: boolean;
  installAvailable: boolean;
  workdir: string;
  trusted: boolean;
  trustSource?: string;
  trustInherited?: boolean;
  revision: number;
  plugins: DevicePlugin[];
  errors: string[];
};

export type DevicePluginRequest =
  | { action: "list"; workdir?: string; since?: number }
  | { action: "reload" | "trust" | "revokeTrust"; workdir?: string }
  | { action: "enable" | "disable" | "remove"; workdir?: string; pluginId: string }
  | { action: "install"; workdir?: string; sourcePath?: string };

export type DevicePluginsClient = {
  installSource: "native" | "workspace";
  longPoll?: boolean;
  operation: (request: DevicePluginRequest) => Promise<DevicePluginList | null>;
  readSurface?: DeviceUiSurfaceClient;
};

const trustListeners = new WeakMap<DevicePluginsClient, Set<() => void>>();

export function subscribeDeviceTrust(client: DevicePluginsClient, listener: () => void) {
  let listeners = trustListeners.get(client);
  if (!listeners) {
    listeners = new Set();
    trustListeners.set(client, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function performDevicePluginOperation(
  client: DevicePluginsClient,
  request: DevicePluginRequest,
) {
  const result = await client.operation(request);
  if (
    result?.available &&
    result.trustAvailable &&
    (request.action === "trust" || request.action === "revokeTrust")
  ) {
    for (const listener of trustListeners.get(client) ?? []) listener();
  }
  return result;
}

export function workspaceTrustFromDevicePlugins(
  client: DevicePluginsClient,
  workdir: string,
): WorkspaceFolderTrustClient {
  const read = async () => client.operation({ action: "list", workdir });
  let snapshot: Awaited<ReturnType<typeof read>>;
  const status = (list: DevicePluginList | null) => {
    if (!list?.available || !list.trustAvailable) throw new Error("DEVICE_TRUST_UNAVAILABLE");
    return {
      workdir: list.workdir,
      trusted: list.trusted,
      source: list.trustSource,
      inherited: list.trustInherited,
    };
  };
  const change = async (action: "trust" | "revokeTrust") => {
    snapshot = await performDevicePluginOperation(client, { action, workdir });
    return status(snapshot);
  };
  return {
    supported: async () => {
      snapshot = await read();
      return Boolean(snapshot?.available && snapshot.trustAvailable);
    },
    get: async () => status(snapshot ?? (await read())),
    trust: () => change("trust"),
    revoke: () => change("revokeTrust"),
  };
}

export function shouldAdoptDevicePluginList(
  current: DevicePluginList | null,
  next: DevicePluginList,
) {
  // A restarted backend can report a lower revision. Do not assume its
  // counters are monotonic across connections.
  return (
    !current ||
    current.revision !== next.revision ||
    current.workdir !== next.workdir ||
    current.available !== next.available ||
    current.trustAvailable !== next.trustAvailable ||
    current.installAvailable !== next.installAvailable ||
    current.trusted !== next.trusted ||
    current.errors.join("\u0000") !== next.errors.join("\u0000") ||
    JSON.stringify(current.plugins) !== JSON.stringify(next.plugins)
  );
}
