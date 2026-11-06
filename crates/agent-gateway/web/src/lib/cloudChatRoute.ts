import type { ExtensionWorkspaceLocation } from "@liveagent/ui/features/extensions/extensionTypes";
import { CLOUD_SPACE_HOME, type CloudSpaceLocation } from "./cloudSpace";

const settingsSections = ["account", "system", "providers", "planning", "devices"] as const;
export type CloudSettingsSection = (typeof settingsSections)[number];
export type CloudReaderRoute = { kind: "file" | "artifact" | "site"; id: string };
export type CloudChatRoute =
  | { page: "chat"; id: string; reader?: CloudReaderRoute }
  | { page: "settings"; section?: CloudSettingsSection }
  | { page: "projects"; id?: string }
  | { page: "library"; location: CloudSpaceLocation; reader?: CloudReaderRoute }
  | { page: "extensions"; location: ExtensionWorkspaceLocation };

export const DEFAULT_EXTENSION_LOCATION: ExtensionWorkspaceLocation = {
  route: { page: "plugins" },
};
const categories = ["all", "recent", "documents", "images", "uploads", "outputs", "sites"] as const;
const scopes = ["all", "starred", "trash"] as const;
const origins = ["", "uploads", "outputs"] as const;
const queryKeys = [
  "conversation",
  "settings",
  "category",
  "scope",
  "type",
  "origin",
  "folder",
  "file",
  "artifact",
  "site",
  "skill_id",
  "fromPlugin",
];
const objectId = /^[a-z0-9_-]{1,128}$/i;

function id(value: string | null | undefined) {
  return value && objectId.test(value) ? value : undefined;
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
  if (page === "settings" && !action) {
    return { page: "settings", section: cloudSettingsSection(object) };
  }
  if (page === "projects" && !action) return { page: "projects", id: key };
  if ((page === "space" || page === "library") && !sub) {
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
    return {
      page: "library",
      location,
      reader: kind && resource ? { kind, id: resource } : undefined,
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
            reader: skillName ? { id: key, skillName } : undefined,
          }
        : DEFAULT_EXTENSION_LOCATION,
    };
  }
  if (page === "skills" && !action) {
    const skillId = key ?? id(query.get("skill_id"));
    return {
      page: "extensions",
      location: { route: { page: "skills" }, reader: skillId ? { id: skillId } : undefined },
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
  if (!page) {
    const legacy = cloudSettingsSection(query.get("settings"));
    if (legacy) return { page: "settings", section: legacy };
  } else if (page !== "c" || !key || action) {
    return { page: "chat", id: "" };
  }
  const file = id(query.get("file"));
  const artifact = id(query.get("artifact"));
  const site = id(query.get("site"));
  return {
    page: "chat",
    id: (page === "c" ? key : id(query.get("conversation"))) ?? "",
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
      if (route.reader) query.set(route.reader.kind, route.reader.id);
      break;
    case "settings":
      path = route.section ? `/settings/${route.section}` : "/settings";
      break;
    case "projects":
      path = route.id ? `/projects/${encodeURIComponent(route.id)}` : "/projects";
      break;
    case "library": {
      const { location, reader } = route;
      const folder = location.folder ? `/folders/${encodeURIComponent(location.folder)}` : "";
      path = reader ? `/space/${reader.kind}s/${encodeURIComponent(reader.id)}` : `/space${folder}`;
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
        }
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
