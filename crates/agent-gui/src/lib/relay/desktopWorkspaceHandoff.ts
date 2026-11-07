import { invoke } from "@tauri-apps/api/core";
import { sendWorkspaceHandoff, type WorkspaceHandoff } from "@/lib/workspaceHandoff";
import type { AppSettings } from "../settings";
import { switchDesktopDevice, type DesktopEnvironment } from "./desktopExecution";
import { createDesktopRemoteHost } from "./desktopRemoteHost";
import { nativeSessionHandle, requireNativeSession } from "./nativeSession";

export async function sendDesktopWorkspaceHandoff(
  request: WorkspaceHandoff,
  settings: AppSettings,
  environments: DesktopEnvironment[],
  localDeviceId: string,
) {
  const session = await requireNativeSession();
  const environment = environments.find((item) => item.device_id === request.deviceId);
  const workspace = environment?.workspaces.find((item) => item.id === request.workspaceId);
  if (!environment?.online || !workspace) throw new Error("Workspace is unavailable");
  const ensureCurrent = () => {
    request.signal.throwIfAborted();
    if (nativeSessionHandle() !== session.sessionHandle)
      throw new Error("Cloud workbench account changed");
  };
  ensureCurrent();
  if (environment.device_id === localDeviceId) {
    const bytes = new Uint8Array(await request.blob.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 32768)
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    ensureCurrent();
    const path = await invoke<string>("account_workspace_handoff", {
      sessionHandle: session.sessionHandle,
      workspaceId: workspace.id,
      operationId: request.operationId,
      fileName: request.filename,
      bodyBase64: btoa(binary),
    });
    ensureCurrent();
    return path;
  }
  const selection = await switchDesktopDevice(settings, environment);
  ensureCurrent();
  const bridge = await createDesktopRemoteHost({
    settings,
    environment,
    environments,
    signal: request.signal,
    selectionLease: selection.selection_lease,
    expiresAt: Date.parse(selection.expires_at),
    onSelectionInvalid: () => undefined,
  });
  try {
    ensureCurrent();
    return await sendWorkspaceHandoff(request, bridge.host.selection, bridge.host.request);
  } finally {
    bridge.dispose();
  }
}
