import { invoke } from "@liveagent/app/shims/tauriCore";
import type {
  DevicePluginList,
  DevicePluginsClient,
} from "@liveagent/ui/lib/plugins/devicePlugins";
import type {
  DeviceUiDocument,
  DeviceUiHistory,
  DeviceUiSurfaceClient,
} from "@liveagent/ui/lib/plugins/deviceUiSurface";
import { useMemo, useSyncExternalStore } from "react";
import { getKBrainSessionId } from "../lib/kbrain/mapping";
import {
  getKBrainRuntimeConnection,
  subscribeKBrainRuntimeConnection,
} from "../lib/kbrain/runtimeConnection";

const readDesktopDeviceUiSurface: DeviceUiSurfaceClient = async (input) => {
  const connection = getKBrainRuntimeConnection();
  if (!connection?.managedLocal) throw new Error("DEVICE_UI_SURFACE_UNAVAILABLE");
  let result: DeviceUiDocument | DeviceUiHistory;
  if (input.action === "panel") {
    result = await invoke<DeviceUiDocument>("device_ui_surface_operation", { request: input });
  } else {
    const { conversationId, ...request } = input;
    const backendSessionId = getKBrainSessionId(conversationId);
    if (!backendSessionId) throw new Error("DEVICE_UI_SURFACE_UNAVAILABLE");
    result = await invoke<DeviceUiDocument | DeviceUiHistory>("device_ui_surface_operation", {
      request,
      backendSessionId,
    });
  }
  if (getKBrainRuntimeConnection() !== connection) throw new Error("DEVICE_UI_SURFACE_UNAVAILABLE");
  return result;
};

export function useDesktopDeviceUiSurface() {
  const connection = useSyncExternalStore(
    subscribeKBrainRuntimeConnection,
    getKBrainRuntimeConnection,
    getKBrainRuntimeConnection,
  );
  return useMemo<DeviceUiSurfaceClient | undefined>(() => {
    if (!connection?.managedLocal) return undefined;
    return (request) => {
      if (getKBrainRuntimeConnection() !== connection)
        return Promise.reject(new Error("DEVICE_UI_SURFACE_UNAVAILABLE"));
      return readDesktopDeviceUiSurface(request);
    };
  }, [connection]);
}
export const desktopDevicePlugins: DevicePluginsClient = {
  installSource: "native",
  longPoll: true,
  operation: (request) => invoke<DevicePluginList | null>("device_plugins_operation", { request }),
  readSurface: readDesktopDeviceUiSurface,
};

export function useDesktopDevicePlugins(): DevicePluginsClient | undefined {
  const connection = useSyncExternalStore(
    subscribeKBrainRuntimeConnection,
    getKBrainRuntimeConnection,
    getKBrainRuntimeConnection,
  );
  return useMemo(() => {
    if (!connection?.managedLocal) return undefined;
    const assertCurrent = () => {
      if (getKBrainRuntimeConnection() !== connection)
        throw new Error("DEVICE_PLUGIN_SCOPE_CHANGED");
    };
    return {
      ...desktopDevicePlugins,
      async operation(request) {
        assertCurrent();
        const result = await desktopDevicePlugins.operation(request);
        assertCurrent();
        return result;
      },
      async readSurface(request) {
        assertCurrent();
        return readDesktopDeviceUiSurface(request);
      },
    } satisfies DevicePluginsClient;
  }, [connection]);
}
