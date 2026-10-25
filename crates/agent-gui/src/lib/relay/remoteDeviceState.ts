import type { DesktopEnvironment } from "./desktopExecution";

export const LOCAL_ONLY_DEVICE_ID = "zeroagent-local";

export type DesktopExecutionState = {
  environments: DesktopEnvironment[];
  localDeviceId: string;
  selectedDeviceId: string;
};

export function localDesktopExecutionState(
  environments: DesktopEnvironment[],
  localDeviceId: string,
): DesktopExecutionState {
  return { environments, localDeviceId, selectedDeviceId: localDeviceId };
}

export function refreshDesktopExecutionState(
  current: DesktopExecutionState,
  environments: DesktopEnvironment[],
  localDeviceId: string,
): DesktopExecutionState {
  const selectedLocal =
    !current.selectedDeviceId ||
    current.selectedDeviceId === current.localDeviceId ||
    current.selectedDeviceId === LOCAL_ONLY_DEVICE_ID;
  if (selectedLocal) return localDesktopExecutionState(environments, localDeviceId);
  if (!environments.some((item) => item.device_id === current.selectedDeviceId)) {
    const previous = current.environments.find(
      (item) => item.device_id === current.selectedDeviceId,
    );
    environments = [
      ...environments,
      {
        ...(previous ?? {
          runtime_kind: "device_agent",
          device_id: current.selectedDeviceId,
          name: "所选设备",
          workspaces: [],
        }),
        online: false,
      },
    ];
  }
  return { environments, localDeviceId, selectedDeviceId: current.selectedDeviceId };
}

export function unavailableDesktopExecutionState(
  current: DesktopExecutionState,
  localEnvironments: DesktopEnvironment[],
): DesktopExecutionState {
  if (
    !current.selectedDeviceId ||
    current.selectedDeviceId === current.localDeviceId ||
    current.selectedDeviceId === LOCAL_ONLY_DEVICE_ID
  ) {
    return localDesktopExecutionState(localEnvironments, LOCAL_ONLY_DEVICE_ID);
  }
  return refreshDesktopExecutionState(
    current,
    current.environments.map((item) =>
      item.device_id === current.localDeviceId ? item : { ...item, online: false },
    ),
    current.localDeviceId,
  );
}

export function selectDesktopExecutionState(
  current: DesktopExecutionState,
  environment: DesktopEnvironment,
): DesktopExecutionState {
  if (
    environment.device_id === current.localDeviceId ||
    environment.device_id === LOCAL_ONLY_DEVICE_ID
  ) {
    return { ...current, selectedDeviceId: current.localDeviceId };
  }
  return refreshDesktopExecutionState(
    { ...current, selectedDeviceId: environment.device_id },
    current.environments,
    current.localDeviceId,
  );
}

export function remoteProjectStorageKey(deviceId: string) {
  return `zeroagent.remote-project:${deviceId}`;
}

export function remoteConversationStorageKey(deviceId: string, projectId: string | null) {
  return `zeroagent.remote-conversation:${deviceId}:${projectId || "plain-chat"}`;
}
