import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { pushWorkbenchLocation, replaceWorkbenchState } from "./browserMobileBack";
import {
  type CloudChatRoute,
  cloudChatRouteHref,
  DEVICE_CONVERSATION_POP_EVENT,
  deviceWorkbenchRouteTarget,
  readCloudChatRoute,
} from "./cloudChatRoute";
import { writeCloudExtensionReturnLocation } from "./cloudExtensionBrowseState";
import { writeCloudSpaceReturnLocation } from "./cloudSpaceBrowseState";
import { getDesktopCloudHost } from "./desktopRemoteHost";

const historyKey = "zeroagentCloudRoute";
type Entry = {
  owner: number;
  index: number;
  conversation: string;
  skillReaderReturn?: string;
  settingsReturn?: number;
};

function skillReaderIdentity(route: CloudChatRoute) {
  const reader = route.page === "extensions" ? route.location.reader : undefined;
  return reader ? JSON.stringify([reader.id, reader.skillName, reader.revision]) : undefined;
}

let desktopEntry: { scope: string; entry: Entry } | undefined;
function routeURL() {
  const host = getDesktopCloudHost();
  if (!host) return new URL(window.location.href);
  const href = host.readLocation();
  return new URL(/^\/(?!\/)[^\\]*$/.test(href) ? href : "/", host.gatewayOrigin);
}

function readEntry(owner: number): Entry | undefined {
  const host = getDesktopCloudHost();
  const cached = host && desktopEntry?.scope === host.accountScope ? desktopEntry.entry : undefined;
  const entry = host
    ? {
        ...(cached ?? {
          owner: host.accountUser.id,
          index: 0,
          conversation: host.readConversation(),
        }),
        ...(host.readSkillReaderReturn ? { skillReaderReturn: host.readSkillReaderReturn() } : {}),
      }
    : (window.history.state?.[historyKey] as Entry | undefined);
  if (
    entry?.owner === owner &&
    Number.isSafeInteger(entry.index) &&
    typeof entry.conversation === "string"
  ) {
    return entry;
  }
}

export function readCloudChatLocation(owner: number) {
  const url = routeURL();
  const host = getDesktopCloudHost();
  const storedOwner = host
    ? desktopEntry?.scope === host.accountScope
      ? desktopEntry.entry.owner
      : undefined
    : window.history.state?.[historyKey]?.owner;
  if (typeof storedOwner === "number" && storedOwner !== owner) {
    return { route: { page: "chat", id: "" } satisfies CloudChatRoute, conversation: "" };
  }
  const route = readCloudChatRoute(url);
  if (deviceWorkbenchRouteTarget(route) !== undefined) return { route, conversation: "" };
  const entry = readEntry(owner);
  if (
    entry?.skillReaderReturn &&
    entry.skillReaderReturn === skillReaderIdentity(route) &&
    route.page === "extensions" &&
    route.location.reader
  ) {
    route.location.reader.returnToChat = true;
  }
  return {
    route,
    conversation: route.page === "chat" ? route.id : (entry?.conversation ?? ""),
  };
}

function write(method: "pushState" | "replaceState", entry: Entry, href: string) {
  const host = getDesktopCloudHost();
  if (host) {
    if (!host.isCurrent()) return;
    desktopEntry = { scope: host.accountScope, entry };
    host.saveLocation(href, entry.conversation, entry.skillReaderReturn);
    return;
  }
  const state = { ...window.history.state, [historyKey]: entry };
  if (method === "pushState") pushWorkbenchLocation(state, href);
  else if (new URL(href, window.location.href).href === window.location.href)
    replaceWorkbenchState(state);
  else window.history.replaceState(state, "", href);
}

export function useCloudChatHistory({
  owner,
  active,
  listen = true,
  route,
  conversation,
  apply,
  isDirty,
  confirm,
}: {
  owner: number;
  active: boolean;
  listen?: boolean;
  route: CloudChatRoute;
  conversation: string;
  apply: (location: ReturnType<typeof readCloudChatLocation>) => void;
  isDirty: () => boolean;
  confirm: (navigate: () => void) => void;
}) {
  const latest = useRef({ active, apply, isDirty, confirm, route });
  latest.current = { active, apply, isDirty, confirm, route };
  const current = useRef<{ entry: Entry; href: string; state: unknown } | null>(null);
  const wasActive = useRef(false);
  const replaceNext = useRef(false);
  const fromPop = useRef(false);
  const restoration = useRef<{ index: number; delta: number } | null>(null);
  const approved = useRef<number | null>(null);
  const approvedDeviceHref = useRef("");
  const settingsBackPending = useRef(false);

  useLayoutEffect(() => {
    const continuing = wasActive.current;
    wasActive.current = active;
    if (!active || restoration.current) return;
    const url = routeURL();
    const href = cloudChatRouteHref(route, url);
    const browserHref = url.pathname + url.search + url.hash;
    const existing = readEntry(owner);
    const previous = current.current;
    const sameOwner = previous?.entry.owner === owner;
    // A history traversal can change the address before popstate is delivered.
    // Ignore unrelated renders while the committed UI still describes the old entry.
    if (
      continuing &&
      sameOwner &&
      !fromPop.current &&
      !replaceNext.current &&
      previous.href !== browserHref &&
      previous.entry.conversation === conversation &&
      cloudChatRouteHref(route, new URL(previous.href, url)) === previous.href
    )
      return;
    const fromSettings = route.page === "settings" && readCloudChatRoute(url).page === "settings";
    const push =
      sameOwner &&
      !fromPop.current &&
      !replaceNext.current &&
      !fromSettings &&
      href !== browserHref;
    const settingsReturn = fromSettings
      ? existing?.settingsReturn
      : route.page === "settings" &&
          push &&
          existing &&
          previous.href === browserHref &&
          previous.entry.index === existing.index &&
          deviceWorkbenchRouteTarget(readCloudChatRoute(url)) === undefined
        ? existing.index
        : undefined;
    const entry: Entry = {
      owner,
      index: (existing?.index ?? 0) + Number(push),
      conversation,
      ...(settingsReturn !== undefined ? { settingsReturn } : {}),
      ...(route.page === "extensions" && route.location.reader?.returnToChat
        ? { skillReaderReturn: skillReaderIdentity(route) }
        : {}),
    };
    if (
      href !== browserHref ||
      existing?.conversation !== conversation ||
      existing?.settingsReturn !== entry.settingsReturn ||
      existing?.skillReaderReturn !== entry.skillReaderReturn ||
      !existing
    ) {
      write(push ? "pushState" : "replaceState", entry, href);
    }
    if (!sameOwner || previous.href !== href) {
      const host = getDesktopCloudHost();
      if (!host || (host.accountUser.id === owner && host.isCurrent())) {
        const browseOwner = host?.accountScope ?? owner;
        if (route.page === "library") writeCloudSpaceReturnLocation(browseOwner, route.location);
        else if (route.page === "extensions")
          writeCloudExtensionReturnLocation(browseOwner, route.location);
      }
    }
    current.current = { entry, href, state: window.history.state };
    if (route.page !== "settings") settingsBackPending.current = false;
    fromPop.current = false;
    replaceNext.current = false;
  });

  useEffect(() => {
    if (!listen) return;
    const host = getDesktopCloudHost();
    if (host) {
      const releaseGuard = host.registerNavigationGuard?.((navigate) => {
        const options = latest.current;
        if (host.isCurrent() && options.isDirty())
          options.confirm(() => {
            if (host.isCurrent()) navigate();
          });
        else navigate();
      });
      const unsubscribe = host.subscribeLocation(() => {
        fromPop.current = true;
        latest.current.apply(readCloudChatLocation(owner));
      });
      return () => {
        unsubscribe();
        releaseGuard?.();
      };
    }
    function onPop() {
      settingsBackPending.current = false;
      const route = readCloudChatRoute(routeURL());
      const options = latest.current;
      const device = deviceWorkbenchRouteTarget(route);
      // The device host owns these addresses. Only the currently mounted task
      // workspace for this exact device may apply a device task location.
      if (
        device !== undefined &&
        (route.page !== "tasks" ||
          options.route.page !== "tasks" ||
          !options.route.deviceView ||
          options.route.target !== device)
      )
        return;
      const previous = current.current;
      if (!options.active || !previous || previous.entry.owner !== owner) return;
      const target = readEntry(owner);
      const restored = restoration.current;
      if (restored) {
        if (target?.index !== restored.index) return;
        restoration.current = null;
        options.confirm(() => {
          approved.current = restored.index + restored.delta;
          window.history.go(restored.delta);
        });
        return;
      }
      const location = readCloudChatLocation(owner);
      if (options.isDirty() && (approved.current === null || approved.current !== target?.index)) {
        if (target && target.index !== previous.entry.index) {
          const delta = target.index - previous.entry.index;
          restoration.current = { index: previous.entry.index, delta };
          window.history.go(-delta);
        } else {
          write("replaceState", previous.entry, previous.href);
          options.confirm(() => {
            fromPop.current = true;
            options.apply(location);
          });
        }
        return;
      }
      approved.current = null;
      fromPop.current = true;
      options.apply(location);
    }
    function guardDevicePop(event: Event) {
      const previous = current.current;
      const options = latest.current;
      if (!options.active || !previous || previous.entry.owner !== owner) return;
      const url = routeURL();
      const href = url.pathname + url.search + url.hash;
      if (approvedDeviceHref.current === href) {
        approvedDeviceHref.current = "";
        return;
      }
      if (!options.isDirty()) return;
      event.preventDefault();
      const deviceEntry = window.history.state;
      window.history.replaceState(previous.state, "", previous.href);
      options.confirm(() => {
        const currentUrl = routeURL();
        if (
          !latest.current.active ||
          current.current?.entry.owner !== owner ||
          currentUrl.pathname + currentUrl.search + currentUrl.hash !== previous.href
        )
          return;
        approvedDeviceHref.current = href;
        window.history.replaceState(deviceEntry, "", href);
        window.dispatchEvent(new window.PopStateEvent("popstate", { state: deviceEntry }));
      });
    }
    window.addEventListener("popstate", onPop);
    window.addEventListener(DEVICE_CONVERSATION_POP_EVENT, guardDevicePop);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener(DEVICE_CONVERSATION_POP_EVENT, guardDevicePop);
      restoration.current = null;
      approved.current = null;
      approvedDeviceHref.current = "";
      settingsBackPending.current = false;
    };
  }, [owner, listen]);

  const returnFromSettings = useCallback(() => {
    if (getDesktopCloudHost() || !latest.current.active || latest.current.route.page !== "settings")
      return false;
    const entry = readEntry(owner);
    if (
      !entry ||
      entry.settingsReturn !== entry.index - 1 ||
      window.history.length < 2 ||
      readCloudChatRoute(routeURL()).page !== "settings"
    )
      return false;
    if (!settingsBackPending.current) {
      settingsBackPending.current = true;
      window.history.back();
    }
    return true;
  }, [owner]);

  return { replaceNext, returnFromSettings };
}
