import type { ExtensionWorkspaceLocation } from "@liveagent/ui/features/extensions/extensionTypes";
import { CLOUD_SPACE_HOME, type CloudSpaceLocation } from "./cloudSpace";

const settingsSections = ["account", "system", "providers", "planning", "devices"] as const;
export type CloudSettingsSection = (typeof settingsSections)[number];
export type CloudReaderRoute = { kind: "file" | "artifact" | "site"; id: string };
export type CloudTaskReaderRoute =
  | { kind: "file"; id: string; fromLine?: number; toLine?: number }
  | { kind: "artifact" | "site" | "source"; id: string };
export const taskStatuses = ["enabled", "paused", "completed"] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export const DEVICE_CONVERSATION_POP_EVENT = "zeroagent:device-conversation-pop";

export type CloudChatRoute =
  | { page: "chat"; id: string; deviceId?: string; messageId?: string; reader?: CloudReaderRoute }
  | { page: "settings"; section?: CloudSettingsSection }
  | { page: "projects"; id?: string }
  | {
      page: "tasks";
      id?: string;
      status?: TaskStatus;
      statuses?: TaskStatus[];
      run?: string;
      target?: string;
      scope?: string;
      deviceView?: true;
      reader?: CloudTaskReaderRoute;
    }
  | { page: "library"; location: CloudSpaceLocation; reader?: CloudReaderRoute; work?: true }
  | { page: "extensions"; location: ExtensionWorkspaceLocation };

export function sameTaskRun(
  first: Extract<CloudChatRoute, { page: "tasks" }>,
  second: Extract<CloudChatRoute, { page: "tasks" }>,
) {
  return (
    first.id === second.id &&
    first.run === second.run &&
    first.target === second.target &&
    first.deviceView === second.deviceView
  );
}

export function deviceWorkbenchRouteTarget(route: CloudChatRoute): string | undefined {
  if (route.page === "chat") return route.deviceId;
  if (route.page === "tasks" && route.deviceView) return route.target ?? "";
}

export const DEFAULT_EXTENSION_LOCATION: ExtensionWorkspaceLocation = {
  route: { page: "plugins" },
};
const categories = ["all", "recent", "documents", "images", "uploads", "outputs", "sites"] as const;
const scopes = ["all", "starred", "trash"] as const;
const origins = ["", "uploads", "outputs"] as const;
const queryKeys = [
  "conversation",
  "device",
  "message",
  "settings",
  "category",
  "scope",
  "type",
  "origin",
  "folder",
  "file",
  "artifact",
  "site",
  "work",
  "skill_id",
  "skill_name",
  "skill_revision",
  "fromPlugin",
  "task_status",
  "task_run",
  "task_target",
  "task_scope",
  "task_device",
  "task_source",
  "task_from",
  "task_to",
  "selection_lease",
  "runtime_kind",
  "device_id",
  "agent_id",
  "workspace_id",
  "conversation_id",
];
const objectId = /^[a-z0-9_-]{1,128}$/i;

function id(value: string | null | undefined) {
  return value && objectId.test(value) ? value : undefined;
}

function singleRouteId(query: URLSearchParams, name: string) {
  const values = query.getAll(name);
  return values.length === 1 ? id(values[0]) : undefined;
}

export function taskReaderFromResource(resource: {
  kind: string;
  id: string;
}): CloudTaskReaderRoute | undefined {
  const { kind, id: resourceId } = resource;
  if (kind === "file" || kind === "source" || kind === "artifact" || kind === "site") {
    return { kind, id: resourceId };
  }
}

function readTaskReader(query: URLSearchParams) {
  for (const [key, kind] of [
    ["file", "file"],
    ["artifact", "artifact"],
    ["site", "site"],
    ["task_source", "source"],
  ] as const) {
    const resource = id(query.get(key));
    if (!resource) continue;
    if (kind !== "file") return { kind, id: resource };
    const start = query.get("task_from");
    const end = query.get("task_to");
    const fromLine = start && /^[1-9][0-9]{0,8}$/.test(start) ? Number(start) : undefined;
    const toLine = end && /^[1-9][0-9]{0,8}$/.test(end) ? Number(end) : undefined;
    return {
      kind,
      id: resource,
      ...(fromLine ? { fromLine } : {}),
      ...(fromLine && toLine && toLine >= fromLine && toLine - fromLine < 200 ? { toLine } : {}),
    };
  }
}

function oneOf<T extends string>(
  values: readonly T[],
  value: string | null | undefined,
): T | undefined {
  return values.find((candidate) => candidate === value);
}

export function cloudSettingsSection(
  value: string | undefined | null,
): CloudSettingsSection | undefined {
  return oneOf(settingsSections, value);
}

export function readCloudChatRoute(url: URL): CloudChatRoute {
  const [page, object, action, sub, ...rest] = url.pathname.replace(/^\/|\/$/g, "").split("/");
  const key = id(object);
  const query = url.searchParams;
  const revision = query.get("skill_revision");
  const skillRevision =
    revision && /^[1-9][0-9]{0,8}$/.test(revision) ? Number(revision) : undefined;
  if (page === "settings" && !action) {
    return { page: "settings", section: cloudSettingsSection(object) };
  }
  if (page === "projects" && !action) return { page: "projects", id: key };
  const deviceTask = page === "tasks" && query.has("task_device");
  if (page === "tasks" && (!action || deviceTask)) {
    const statusQuery = query.get("task_status");
    const selectedStatuses = taskStatuses.filter((status) =>
      statusQuery?.split(",").includes(status),
    );
    const run = key
      ? deviceTask
        ? singleRouteId(query, "task_run")
        : id(query.get("task_run"))
      : undefined;
    let target = id(query.get("task_target"));
    if (deviceTask) {
      const valid =
        singleRouteId(query, "task_device") === "1" &&
        action === undefined &&
        (object === undefined || key !== undefined) &&
        (!query.has("task_run") || !!run);
      // Keep malformed explicit device routes out of the account workbench.
      target = valid ? (singleRouteId(query, "task_target") ?? "") : "";
    }
    const reader = run && !deviceTask ? readTaskReader(query) : undefined;
    return {
      page: "tasks",
      id: key,
      status: selectedStatuses.length === 1 ? selectedStatuses[0] : undefined,
      ...(statusQuery === "none" || selectedStatuses.length === 2
        ? { statuses: selectedStatuses }
        : {}),
      run,
      target,
      ...(id(query.get("task_scope")) ? { scope: id(query.get("task_scope")) } : {}),
      ...(deviceTask ? { deviceView: true as const } : {}),
      ...(reader ? { reader } : {}),
    };
  }
  if (page === "space" && !sub) {
    const resource = id(action);
    const location: CloudSpaceLocation = {
      ...CLOUD_SPACE_HOME,
      folder: (object === "folders" ? resource : id(query.get("folder"))) ?? "",
      category: oneOf(categories, query.get("category")) ?? CLOUD_SPACE_HOME.category,
      scope: oneOf(scopes, query.get("scope")) ?? CLOUD_SPACE_HOME.scope,
      type: id(query.get("type")),
      origin: oneOf(origins, query.get("origin")),
    };
    const kind =
      object === "files"
        ? "file"
        : object === "artifacts"
          ? "artifact"
          : object === "sites"
            ? "site"
            : undefined;
    const reader: CloudReaderRoute | undefined =
      kind && resource ? { kind, id: resource } : undefined;
    return {
      page: "library",
      location,
      reader,
      ...(reader && location.scope !== "trash" && query.get("work") === "1" ? { work: true } : {}),
    };
  }
  if (page === "plugins" && !rest.length) {
    const skillName =
      action === "manage" ? id(query.get("skill_id")) : action === "skills" ? id(sub) : undefined;
    return {
      page: "extensions",
      location: key
        ? {
            route: { page: action === "manage" ? "manage" : "plugin", id: key },
            reader: skillName
              ? { id: key, skillName, ...(skillRevision ? { revision: skillRevision } : {}) }
              : undefined,
          }
        : DEFAULT_EXTENSION_LOCATION,
    };
  }
  if (page === "skills" && !object) {
    const skillId = id(query.get("skill_id"));
    return {
      page: "extensions",
      location: {
        route: { page: "skills" },
        reader: skillId
          ? {
              id: skillId,
              ...(skillRevision
                ? { revision: skillRevision, skillName: id(query.get("skill_name")) }
                : {}),
            }
          : undefined,
      },
    };
  }
  if (page === "customize" && !sub) {
    const target = id(action);
    const returnTo = id(query.get("fromPlugin"));
    if (object === "drafts" && target)
      return { page: "extensions", location: { route: { page: "editor", draftId: target } } };
    if (object === "edit" && target)
      return { page: "extensions", location: { route: { page: "editor", id: target, returnTo } } };
    const kind = oneOf(["plugin", "skill"] as const, action);
    if (object === "new" && kind)
      return {
        page: "extensions",
        location: { route: { page: "editor", kind, returnTo } },
      };
    return { page: "extensions", location: DEFAULT_EXTENSION_LOCATION };
  }
  if (page && (page !== "c" || !key || action)) {
    if (page === "c" && query.has("device")) return { page: "chat", id: "", deviceId: "" };
    return { page: "chat", id: "" };
  }
  const file = id(query.get("file"));
  const artifact = id(query.get("artifact"));
  const site = id(query.get("site"));
  const conversationId = key ?? "";
  const deviceId = query.has("device") ? (singleRouteId(query, "device") ?? "") : undefined;
  const messageId =
    conversationId && deviceId === undefined ? singleRouteId(query, "message") : undefined;
  return {
    page: "chat",
    id: conversationId,
    ...(deviceId !== undefined ? { deviceId } : {}),
    ...(messageId ? { messageId } : {}),
    reader: file
      ? { kind: "file", id: file }
      : artifact
        ? { kind: "artifact", id: artifact }
        : site
          ? { kind: "site", id: site }
          : undefined,
  };
}

export function cloudChatRouteHref(route: CloudChatRoute, url: URL) {
  const query = new URLSearchParams(url.search);
  for (const key of queryKeys) query.delete(key);
  if (query.get("oauth") === "success") query.delete("oauth");
  let path: string;
  switch (route.page) {
    case "chat":
      path = route.id ? `/c/${encodeURIComponent(route.id)}` : "/";
      if (route.deviceId !== undefined) query.set("device", route.deviceId);
      else if (route.id && route.messageId) query.set("message", route.messageId);
      if (route.reader) query.set(route.reader.kind, route.reader.id);
      break;
    case "settings":
      path = route.section ? `/settings/${route.section}` : "/settings";
      break;
    case "projects":
      path = route.id ? `/projects/${encodeURIComponent(route.id)}` : "/projects";
      break;
    case "tasks":
      path = route.id ? `/tasks/${encodeURIComponent(route.id)}` : "/tasks";
      if (route.statuses) {
        const statuses = taskStatuses.filter((status) => route.statuses?.includes(status));
        if (statuses.length < taskStatuses.length)
          query.set("task_status", statuses.join(",") || "none");
      } else if (route.status) query.set("task_status", route.status);
      if (route.id && route.run) query.set("task_run", route.run);
      if (route.target) query.set("task_target", route.target);
      if (route.scope) query.set("task_scope", route.scope);
      if (route.deviceView) query.set("task_device", "1");
      if (route.id && route.run && !route.deviceView && route.reader) {
        const reader = route.reader;
        query.set(reader.kind === "source" ? "task_source" : reader.kind, reader.id);
        if (reader.kind === "file") {
          if (reader.fromLine) query.set("task_from", String(reader.fromLine));
          if (reader.toLine) query.set("task_to", String(reader.toLine));
        }
      }
      break;
    case "library": {
      const { location, reader } = route;
      const folder = location.folder ? `/folders/${encodeURIComponent(location.folder)}` : "";
      path = reader ? `/space/${reader.kind}s/${encodeURIComponent(reader.id)}` : `/space${folder}`;
      if (reader && route.work && location.scope !== "trash") query.set("work", "1");
      if (reader && location.folder) query.set("folder", location.folder);
      else query.delete("folder");
      if (location.category !== CLOUD_SPACE_HOME.category) query.set("category", location.category);
      if (location.scope !== CLOUD_SPACE_HOME.scope) query.set("scope", location.scope);
      if (location.type) query.set("type", location.type);
      if (location.origin) query.set("origin", location.origin);
      break;
    }
    case "extensions": {
      const { route: extension, reader } = route.location;
      if (reader) {
        if (reader.skillName && extension.page === "manage") {
          path = `/plugins/${encodeURIComponent(reader.id)}/manage`;
          query.set("skill_id", reader.skillName);
        } else if (reader.skillName && extension.page !== "skills") {
          path = `/plugins/${encodeURIComponent(reader.id)}/skills/${encodeURIComponent(reader.skillName)}`;
        } else {
          path = "/skills";
          query.set("skill_id", reader.id);
          if (reader.revision && reader.skillName) query.set("skill_name", reader.skillName);
        }
        if (reader.revision) query.set("skill_revision", String(reader.revision));
      } else if (extension.page === "editor") {
        path = extension.draftId
          ? `/customize/drafts/${encodeURIComponent(extension.draftId)}`
          : extension.id
            ? `/customize/edit/${encodeURIComponent(extension.id)}`
            : `/customize/new/${extension.kind ?? "skill"}`;
        if (extension.returnTo) query.set("fromPlugin", extension.returnTo);
      } else {
        path =
          "id" in extension
            ? `/plugins/${encodeURIComponent(extension.id)}${extension.page === "manage" ? "/manage" : ""}`
            : `/${extension.page}`;
      }
      break;
    }
  }
  const search = query.toString();
  return path + (search ? `?${search}` : "") + url.hash;
}
