import type { AppSettings } from "@liveagent/ui/lib/settings/types";
import { workspaceProjectPathKey } from "@liveagent/ui/lib/settings/workspaceProjects";
import {
  type DeviceDraftWorkspace,
  type ExecutionSelection,
  type ExecutionWorkspace,
  encodeSelectionCredential,
} from "@/lib/executionTargets";
import { GatewayWebSocketClient } from "@/lib/gatewaySocket";

export function findDeviceDraftProject(
  system: Pick<
    AppSettings["system"],
    "workspaceProjects" | "archivedWorkspaceProjectPaths" | "missingWorkspaceProjectPaths"
  >,
  target: DeviceDraftWorkspace,
) {
  const key = workspaceProjectPathKey(target.path);
  if (!target.id || !key) return undefined;
  const unavailable = [
    ...system.archivedWorkspaceProjectPaths,
    ...system.missingWorkspaceProjectPaths,
  ];
  if (unavailable.some((path) => workspaceProjectPathKey(path) === key)) return undefined;
  return system.workspaceProjects.find(
    (project) => project.id === target.id && workspaceProjectPathKey(project.path) === key,
  );
}

export async function prepareDeviceDraftWorkspace(
  selection: ExecutionSelection,
  workspace: ExecutionWorkspace,
  requireCurrent: () => void,
): Promise<DeviceDraftWorkspace> {
  const target = { id: workspace.id, path: workspace.path?.trim() ?? "" };
  const agent = selection.agent_id || selection.device_id;
  if (!target.id || !target.path || !agent || selection.runtime_kind !== "device_agent")
    throw new Error("Device workspace unavailable");
  requireCurrent();
  // Preflight owns a temporary socket. An invalid candidate must leave the active host intact.
  const client = new GatewayWebSocketClient(encodeSelectionCredential(selection));
  client.setActiveAgent(agent);
  try {
    const { system } = await client.getSettings();
    requireCurrent();
    const project = findDeviceDraftProject(system, target);
    if (!project) throw new Error("Device workspace unavailable");
    await client.listDirs(project.path, 1);
    requireCurrent();
    return { id: project.id, path: project.path };
  } finally {
    client.dispose();
  }
}
