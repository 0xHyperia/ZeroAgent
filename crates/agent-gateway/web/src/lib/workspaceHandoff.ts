import { accountFetch, captureAccountRequestGuard } from "./accountRequest";
import {
  type ExecutionEnvironment,
  type ExecutionSelection,
  encodeSelectionCredential,
  selectExecutionTarget,
} from "./executionTargets";

export type WorkspaceHandoff = {
  deviceId: string;
  workspaceId: string;
  workspacePath: string;
  operationId: string;
  signal: AbortSignal;
} & ({ checkOnly: true } | { checkOnly?: false; filename: string; blob: Blob });

export class WorkspaceHandoffRejected extends Error {
  constructor(
    readonly workspaceHandoffReason:
      | "target"
      | "target-changed"
      | "authorization"
      | "gateway-upgrade"
      | "device-upgrade"
      | "too-large"
      | "request",
  ) {
    super(workspaceHandoffReason);
  }
}

type StoredWorkspaceHandoff = {
  operationId: string;
  deviceId: string;
  workspaceId: string;
  deviceName: string;
  workspaceName: string;
  workspacePath: string;
};

export type PendingWorkspaceHandoff = StoredWorkspaceHandoff & { storageKey: string };

const operationIDPattern = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

function pendingHandoffKey(scope: string, deviceId: string, workspaceId: string) {
  return `${scope}${encodeURIComponent(deviceId)}:${encodeURIComponent(workspaceId)}`;
}

export function readPendingWorkspaceHandoffs(scope: string): PendingWorkspaceHandoff[] {
  const result: PendingWorkspaceHandoff[] = [];
  try {
    const storage = window.sessionStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const storageKey = storage.key(index);
      if (!storageKey?.startsWith(scope)) continue;
      const value = storage.getItem(storageKey);
      if (!value) continue;
      try {
        const record = JSON.parse(value) as Partial<StoredWorkspaceHandoff> | null;
        if (
          record &&
          typeof record.operationId === "string" &&
          operationIDPattern.test(record.operationId) &&
          typeof record.deviceId === "string" &&
          record.deviceId &&
          typeof record.workspaceId === "string" &&
          record.workspaceId &&
          typeof record.deviceName === "string" &&
          typeof record.workspaceName === "string" &&
          typeof record.workspacePath === "string" &&
          record.workspacePath.trim() &&
          storageKey === pendingHandoffKey(scope, record.deviceId, record.workspaceId)
        ) {
          const { operationId, deviceId, workspaceId, deviceName, workspaceName, workspacePath } =
            record;
          result.push({
            storageKey,
            operationId,
            deviceId,
            workspaceId,
            deviceName,
            workspaceName,
            workspacePath,
          });
        }
      } catch {
        // A malformed record cannot be used as a receipt for another destination.
      }
    }
  } catch {
    // The explicit copy still requires session storage to record the operation.
  }
  return result;
}

export function savePendingWorkspaceHandoff(
  scope: string,
  record: StoredWorkspaceHandoff,
  prior?: PendingWorkspaceHandoff,
): PendingWorkspaceHandoff {
  const storageKey =
    prior?.storageKey ?? pendingHandoffKey(scope, record.deviceId, record.workspaceId);
  window.sessionStorage.setItem(storageKey, JSON.stringify(record));
  return { ...record, storageKey };
}

export async function sendWorkspaceHandoff(
  request: WorkspaceHandoff,
  selection: ExecutionSelection,
  transport: (path: string, init?: RequestInit) => Promise<Response> = accountFetch,
) {
  if (
    selection.device_id !== request.deviceId ||
    selection.runtime_kind !== "device_agent" ||
    selection.workspace_id !== request.workspaceId ||
    selection.scope !== "workspace"
  )
    throw new WorkspaceHandoffRejected("target");
  request.signal.throwIfAborted();
  const bytes = new TextEncoder().encode(request.workspacePath);
  if (!bytes.length || bytes.length > 4096) throw new WorkspaceHandoffRejected("request");
  const confirmedPath = btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const query = new URLSearchParams({
    workspace_id: request.workspaceId,
    operation_id: request.operationId,
  });
  if (!request.checkOnly) query.set("name", request.filename);
  const response = await transport(`/api/files/confirmed-handoff?${query}`, {
    method: request.checkOnly ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${encodeSelectionCredential(selection)}`,
      "X-ZeroAgent-Workspace-Path": confirmedPath,
      ...(request.checkOnly ? {} : { "Content-Type": "application/octet-stream" }),
    },
    body: request.checkOnly ? undefined : request.blob,
    signal: request.signal,
  });
  if (response.status === 401 || response.status === 403)
    throw new WorkspaceHandoffRejected("authorization");
  if (response.status === 412) throw new WorkspaceHandoffRejected("target-changed");
  if (response.status === 404) throw new WorkspaceHandoffRejected("gateway-upgrade");
  if (response.status === 426) throw new WorkspaceHandoffRejected("device-upgrade");
  if (response.status === 413) throw new WorkspaceHandoffRejected("too-large");
  if (response.status === 400) throw new WorkspaceHandoffRejected("request");
  const receipt = await response.json();
  if (request.checkOnly && response.ok && receipt?.status === "not_found") return null;
  if (!response.ok || typeof receipt?.relative_path !== "string" || !receipt.relative_path)
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
  if (!environment || !workspace) throw new WorkspaceHandoffRejected("target");
  if (workspace.path !== request.workspacePath)
    throw new WorkspaceHandoffRejected("target-changed");
  request.signal.throwIfAborted();
  const selection = await selectExecutionTarget(environment, workspace, "workspace").catch(() => {
    throw new WorkspaceHandoffRejected("authorization");
  });
  guard();
  const receipt = await sendWorkspaceHandoff(request, selection);
  guard();
  return receipt;
}
