import { useEffect, useLayoutEffect, useRef } from "react";
import { type CloudChatRoute, cloudChatRouteHref, readCloudChatRoute } from "./cloudChatRoute";

const historyKey = "zeroagentCloudRoute";
type Entry = { owner: number; index: number; conversation: string };

function readEntry(owner: number): Entry | undefined {
  const entry = window.history.state?.[historyKey] as Entry | undefined;
  if (
    entry?.owner === owner &&
    Number.isSafeInteger(entry.index) &&
    typeof entry.conversation === "string"
  ) {
    return entry;
  }
}

export function readCloudChatLocation(owner: number) {
  const url = new URL(window.location.href);
  const storedOwner = window.history.state?.[historyKey]?.owner;
  if (typeof storedOwner === "number" && storedOwner !== owner) {
    return { route: { page: "chat", id: "" } satisfies CloudChatRoute, conversation: "" };
  }
  const route = readCloudChatRoute(url);
  const entry = readEntry(owner);
  const legacy = url.searchParams.get("conversation");
  return {
    route,
    conversation:
      route.page === "chat"
        ? route.id
        : (entry?.conversation ?? (legacy && /^[a-z0-9_-]{1,128}$/i.test(legacy) ? legacy : "")),
  };
}

function write(method: "pushState" | "replaceState", entry: Entry, href: string) {
  window.history[method]({ ...window.history.state, [historyKey]: entry }, "", href);
}

export function useCloudChatHistory({
  owner,
  active,
  route,
  conversation,
  apply,
  isDirty,
  confirm,
}: {
  owner: number;
  active: boolean;
  route: CloudChatRoute;
  conversation: string;
  apply: (location: ReturnType<typeof readCloudChatLocation>) => void;
  isDirty: () => boolean;
  confirm: (navigate: () => void) => void;
}) {
  const latest = useRef({ active, apply, isDirty, confirm });
  latest.current = { active, apply, isDirty, confirm };
  const current = useRef<{ entry: Entry; href: string } | null>(null);
  const replaceNext = useRef(false);
  const fromPop = useRef(false);
  const restoration = useRef<{ index: number; delta: number } | null>(null);
  const approved = useRef<number | null>(null);

  useLayoutEffect(() => {
    if (!active || restoration.current) return;
    const url = new URL(window.location.href);
    const href = cloudChatRouteHref(route, url);
    const browserHref = url.pathname + url.search + url.hash;
    const existing = readEntry(owner);
    const sameOwner = current.current?.entry.owner === owner;
    const push = sameOwner && !fromPop.current && !replaceNext.current && href !== browserHref;
    const entry = { owner, index: (existing?.index ?? 0) + Number(push), conversation };
    if (href !== browserHref || existing?.conversation !== conversation || !existing) {
      write(push ? "pushState" : "replaceState", entry, href);
    }
    current.current = { entry, href };
    fromPop.current = false;
    replaceNext.current = false;
  });

  useEffect(() => {
    function onPop() {
      const previous = current.current;
      const options = latest.current;
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
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      restoration.current = null;
      approved.current = null;
    };
  }, [owner]);

  return replaceNext;
}
