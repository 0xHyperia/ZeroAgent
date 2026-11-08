import { invoke } from "@tauri-apps/api/core";
import {
  sendWorkspaceHandoff,
  type WorkspaceHandoff,
  WorkspaceHandoffRejected,
} from "@/lib/workspaceHandoff";
import type { AppSettings } from "../settings";
import { type DesktopEnvironment, switchDesktopEnvironment } from "./desktopExecution";
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
  if (!environment?.online || !workspace) throw new WorkspaceHandoffRejected("target");
  if (workspace.path !== request.workspacePath)
    throw new WorkspaceHandoffRejected("target-changed");
  const ensureCurrent = () => {
    request.signal.throwIfAborted();
    if (nativeSessionHandle() !== session.sessionHandle)
      throw new Error("Cloud workbench account changed");
  };
  ensureCurrent();
  if (environment.device_id === localDeviceId) {
    let binary = "";
    if (!request.checkOnly) {
      const bytes = new Uint8Array(await request.blob.arrayBuffer());
      for (let offset = 0; offset < bytes.length; offset += 32768)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
    }
    ensureCurrent();
    const path = await invoke<string | null>("account_workspace_handoff", {
      sessionHandle: session.sessionHandle,
      workspaceId: workspace.id,
      expectedWorkspacePath: request.workspacePath,
      operationId: request.operationId,
      fileName: request.checkOnly ? "" : request.filename,
      bodyBase64: btoa(binary),
      checkOnly: !!request.checkOnly,
    }).catch((cause) => {
      if (cause === "workspace_target_changed")
        throw new WorkspaceHandoffRejected("target-changed");
      throw cause;
    });
    ensureCurrent();
    return path;
  }
  const selection = await switchDesktopEnvironment(settings, environment, workspace).catch(() => {
    throw new WorkspaceHandoffRejected("authorization");
  });
  ensureCurrent();
  const bridge = await createDesktopRemoteHost({
    settings,
    environment,
    environments,
    signal: request.signal,
    selectionLease: selection.selection_lease,
    workspaceId: workspace.id,
    expiresAt: Date.parse(selection.expires_at),
    onSelectionInvalid: () => undefined,
  }).catch(() => {
    throw new WorkspaceHandoffRejected("authorization");
  });
  try {
    ensureCurrent();
    return await sendWorkspaceHandoff(request, bridge.host.selection, bridge.host.request);
  } finally {
    bridge.dispose();
  }
}
