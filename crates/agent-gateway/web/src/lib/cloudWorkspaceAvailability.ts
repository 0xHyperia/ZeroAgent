import type { ExtensionCatalog } from "@liveagent/ui/features/extensions/extensionTypes";
import { createContext } from "react";
import { bundledCloudExtensionCatalog } from "./bundledCloudExtensionCatalog";
import { DEFAULT_EXTENSION_LOCATION } from "./cloudChatRoute";
import { parseExtensionCatalog } from "./cloudExtensions";
import { CLOUD_SPACE_HOME } from "./cloudSpace";
import type { readCloudChatLocation } from "./useCloudChatHistory";

export const WORKBENCH_AVAILABILITY_PATH = "/api/workbench/availability";
export const ClosedCloudWorkspaceContext = createContext(false);

export type CloudWorkspaceAvailability = { available: boolean; catalog: ExtensionCatalog };
export const CLOSED_CLOUD_WORKSPACE: CloudWorkspaceAvailability = {
  available: false,
  catalog: bundledCloudExtensionCatalog,
};

export function closedCloudLocation({
  route,
}: ReturnType<typeof readCloudChatLocation>): ReturnType<typeof readCloudChatLocation> {
  switch (route.page) {
    case "chat":
      return { route: { page: "chat", id: "" }, conversation: "" };
    case "extensions":
      return {
        route: {
          page: "extensions",
          location:
            route.location.reader || route.location.route.page === "skills"
              ? { route: { page: "skills" } }
              : DEFAULT_EXTENSION_LOCATION,
        },
        conversation: "",
      };
    case "library":
      return {
        route: {
          page: "library",
          location: {
            ...CLOUD_SPACE_HOME,
            scope: route.location.scope,
            category: route.location.category,
          },
        },
        conversation: "",
      };
    case "tasks":
      return { route: { page: "tasks" }, conversation: "" };
    case "projects":
      return { route: { page: "projects" }, conversation: "" };
    default:
      return { route, conversation: "" };
  }
}

export const closedCloudRequest = async (_path: string, init?: RequestInit): Promise<Response> => {
  init?.signal?.throwIfAborted();
  return Response.json({ error: "Cloud workspace is not open" }, { status: 403 });
};

export async function readCloudWorkspaceAvailability(
  request: (path: string, init: RequestInit) => Promise<Response>,
  signal: AbortSignal,
): Promise<CloudWorkspaceAvailability> {
  try {
    const response = await request(WORKBENCH_AVAILABILITY_PATH, {
      cache: "no-store",
      signal,
    });
    if (!response.ok) return CLOSED_CLOUD_WORKSPACE;
    const availability: {
      cloud_workspace_available?: unknown;
      built_in_extensions?: unknown;
    } | null = await response.json();
    if (availability?.cloud_workspace_available === true)
      return { available: true, catalog: { version: 0, packages: [] } };
    if (!availability?.built_in_extensions) return CLOSED_CLOUD_WORKSPACE;
    const catalog = parseExtensionCatalog(availability.built_in_extensions);
    const packages = catalog.packages.filter((pkg) => pkg.builtin && pkg.visibility === "public");
    return packages.length
      ? { available: false, catalog: { ...catalog, packages } }
      : CLOSED_CLOUD_WORKSPACE;
  } catch {
    return CLOSED_CLOUD_WORKSPACE;
  }
}
