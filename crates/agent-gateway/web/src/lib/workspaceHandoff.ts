import { accountFetch, captureAccountRequestGuard } from "./accountRequest";
import {
  encodeSelectionCredential,
  type ExecutionEnvironment,
  type ExecutionSelection,
  selectExecutionTarget,
} from "./executionTargets";

export type WorkspaceHandoff = {
  deviceId: string;
  workspaceId: string;
  operationId: string;
  filename: string;
  blob: Blob;
  signal: AbortSignal;
};

export async function sendWorkspaceHandoff(
  request: WorkspaceHandoff,
  selection: ExecutionSelection,
  transport: (path: string, init?: RequestInit) => Promise<Response> = accountFetch,
) {
  if (selection.device_id !== request.deviceId || selection.runtime_kind !== "device_agent")
    throw new Error("Workspace transfer target changed");
  request.signal.throwIfAborted();
  const query = new URLSearchParams({
    workspace_id: request.workspaceId,
    operation_id: request.operationId,
    name: request.filename,
  });
  const response = await transport(`/api/files/handoff?${query}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${encodeSelectionCredential(selection)}`,
      "Content-Type": "application/octet-stream",
    },
    body: request.blob,
    signal: request.signal,
  });
  const receipt = await response.json();
  if (!response.ok)
    throw new Error(receipt.message || receipt.error || "Workspace transfer failed");
  if (typeof receipt.relative_path !== "string" || !receipt.relative_path)
    throw new Error("Workspace transfer result is unknown");
  return receipt.relative_path as string;
}

export async function sendBrowserWorkspaceHandoff(
  request: WorkspaceHandoff,
  environments: readonly ExecutionEnvironment[],
) {
  const guard = captureAccountRequestGuard();
  const environment = environments.find(
    (item) => item.device_id === request.deviceId && item.online,
  );
  const workspace = environment?.workspaces.find((item) => item.id === request.workspaceId);
  if (!environment || !workspace) throw new Error("Workspace is unavailable");
  const selection = await selectExecutionTarget(environment, workspace, "workspace");
  guard();
  const receipt = await sendWorkspaceHandoff(request, selection);
  guard();
  return receipt;
}
