import { cloudChatRouteHref, readCloudChatRoute } from "./cloudChatRoute";
import { CLOUD_SPACE_HOME, type CloudSpaceLocation } from "./cloudSpace";

export type CloudSpaceBrowseState = {
  query: string;
  sort: "updated" | "name" | "size";
  view: "list" | "grid";
  selected: string[];
  scrollTop: number;
  readerOrigin?: CloudSpaceReaderOrigin;
};

export type CloudSpaceReaderOrigin = {
  id: string;
  kind: "file" | "artifact";
  offset: number;
  opener?: "menu";
};

export type CloudSpaceUploadCheck = {
  id: string;
  name: string;
  folderName: string;
  remaining: number;
  placementAttempted?: boolean;
};

const maxItems = 1_100; // Files, output versions and folders are bounded by the space service.
const spaceRouteBase = new URL("http://workbench.invalid/");
const spaceReturnKey = (owner: number | string) =>
  `zeroagent:cloud-space-return:v1:${JSON.stringify(owner)}`;
const spaceUploadKey = (owner: number | string) =>
  `zeroagent:cloud-space-upload:v1:${JSON.stringify(owner)}`;

export function readCloudSpaceUploadCheck(owner: number | string): CloudSpaceUploadCheck | null {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(spaceUploadKey(owner)) ?? "null");
    if (
      value &&
      typeof value.id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.id) &&
      typeof value.name === "string" &&
      value.name.length <= 255 &&
      typeof value.folderName === "string" &&
      value.folderName.length <= 255 &&
      Number.isInteger(value.remaining) &&
      value.remaining >= 0 &&
      value.remaining < 20
    )
      return {
        id: value.id,
        name: value.name,
        folderName: value.folderName,
        remaining: value.remaining,
        placementAttempted: value.placementAttempted === true,
      };
  } catch {
    // The mounted library can still reconcile its most recent upload.
  }
  return null;
}

export function writeCloudSpaceUploadCheck(
  owner: number | string,
  check: CloudSpaceUploadCheck | null,
) {
  try {
    const key = spaceUploadKey(owner);
    if (check) window.sessionStorage.setItem(key, JSON.stringify(check));
    else window.sessionStorage.removeItem(key);
  } catch {
    // The mounted library retains the check when window storage is unavailable.
  }
}

export function readCloudSpaceReturnLocation(owner: number | string): CloudSpaceLocation {
  try {
    const href = window.sessionStorage.getItem(spaceReturnKey(owner));
    if (href && href.length <= 1024) {
      const url = new URL(href, spaceRouteBase);
      const route = readCloudChatRoute(url);
      if (url.origin === spaceRouteBase.origin && route.page === "library") return route.location;
    }
  } catch {
    // The last list is optional when storage is unavailable.
  }
  return CLOUD_SPACE_HOME;
}

export function writeCloudSpaceReturnLocation(
  owner: number | string,
  location: CloudSpaceLocation,
) {
  try {
    window.sessionStorage.setItem(
      spaceReturnKey(owner),
      cloudChatRouteHref({ page: "library", location }, spaceRouteBase),
    );
  } catch {
    // The mounted workbench still retains its list location.
  }
}

export function cloudSpaceBrowseKey(owner: number | string, location: CloudSpaceLocation) {
  const { category, scope, folder, type, origin } = location;
  return `zeroagent:cloud-space-browse:v1:${JSON.stringify([owner, category, scope, folder, type || "", origin || ""])}`;
}

export function readCloudSpaceBrowseState(key: string, defaultView: CloudSpaceBrowseState["view"]) {
  let stored: Partial<CloudSpaceBrowseState> | null = null;
  try {
    stored = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
  } catch {
    // Browsing still works when storage is unavailable.
  }
  const { query, sort, view, selected, scrollTop, readerOrigin } = stored ?? {};
  return {
    query: typeof query === "string" ? query.slice(0, 200) : "",
    sort: sort === "name" || sort === "size" ? sort : "updated",
    view: view === "grid" || view === "list" ? view : defaultView,
    selected: Array.isArray(selected)
      ? selected.slice(0, maxItems).filter((id) => typeof id === "string" && id.length <= 128)
      : [],
    scrollTop:
      typeof scrollTop === "number" && Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0,
    readerOrigin:
      readerOrigin &&
      (readerOrigin.kind === "file" || readerOrigin.kind === "artifact") &&
      typeof readerOrigin.id === "string" &&
      /^[a-z0-9-]{1,128}$/i.test(readerOrigin.id) &&
      Number.isFinite(readerOrigin.offset)
        ? {
            id: readerOrigin.id,
            kind: readerOrigin.kind,
            offset: readerOrigin.offset,
            ...(readerOrigin.opener === "menu" ? { opener: "menu" as const } : {}),
          }
        : undefined,
  } satisfies CloudSpaceBrowseState;
}

export function writeCloudSpaceBrowseState(key: string, state: CloudSpaceBrowseState) {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // The mounted list retains its current controls even without storage.
  }
}
