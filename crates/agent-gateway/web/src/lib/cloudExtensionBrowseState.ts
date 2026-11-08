import type { ExtensionWorkspaceLocation } from "@liveagent/ui/features/extensions/extensionTypes";
import {
  cloudChatRouteHref,
  DEFAULT_EXTENSION_LOCATION,
  readCloudChatRoute,
} from "./cloudChatRoute";

const routeBase = new URL("http://workbench.invalid/");
const keyFor = (owner: number | string) =>
  `zeroagent:cloud-extensions-return:v1:${JSON.stringify(owner)}`;

export function readCloudExtensionReturnLocation(
  owner: number | string,
): ExtensionWorkspaceLocation {
  try {
    const href = window.sessionStorage.getItem(keyFor(owner));
    if (href && href.length <= 160) {
      const url = new URL(href, routeBase);
      const route = readCloudChatRoute(url);
      if (
        url.origin === routeBase.origin &&
        route.page === "extensions" &&
        !route.location.reader &&
        route.location.route.page !== "editor" &&
        route.location.route.page !== "manage" &&
        cloudChatRouteHref(route, routeBase) === href
      )
        return route.location;
    }
  } catch {
    // The catalog remains available when session storage is disabled.
  }
  return DEFAULT_EXTENSION_LOCATION;
}

export function readCloudExtensionReturnHref(owner: number | string): string {
  return cloudChatRouteHref(
    { page: "extensions", location: readCloudExtensionReturnLocation(owner) },
    routeBase,
  );
}

export function writeCloudExtensionReturnLocation(
  owner: number | string,
  { route, reader }: ExtensionWorkspaceLocation,
) {
  if (route.page === "editor" || route.page === "manage" || reader?.returnToChat) return;
  try {
    window.sessionStorage.setItem(
      keyFor(owner),
      cloudChatRouteHref({ page: "extensions", location: { route } }, routeBase),
    );
  } catch {
    // An unavailable browsing preference cannot prevent navigation.
  }
}
