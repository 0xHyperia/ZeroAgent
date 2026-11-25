import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DevicePluginList,
  type DevicePluginRequest,
  type DevicePluginsClient,
  performDevicePluginOperation,
  shouldAdoptDevicePluginList,
} from "./devicePlugins";

// The original upstream list follows a revision cursor. Explicit mutations
// invalidate reads started beforehand, and cleanup discards prior selections.
function wait(signal: AbortSignal, ms: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export function useDevicePluginList(client: DevicePluginsClient, workdir?: string) {
  const [list, setList] = useState<DevicePluginList | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [busy, setBusy] = useState<DevicePluginRequest["action"] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const listRef = useRef<DevicePluginList | null>(null);
  const epoch = useRef(0);
  const mutation = useRef(false);

  const adopt = useCallback((next: DevicePluginList) => {
    listRef.current = next;
    setList(next);
    setLoadError(false);
  }, []);

  const read = useCallback(
    async (current: AbortController, since?: number, force = false) => {
      const version = epoch.current;
      try {
        const next = await client.operation({ action: "list", workdir, since });
        if (current.signal.aborted || epoch.current !== version) return;
        if (next && (force || shouldAdoptDevicePluginList(listRef.current, next))) adopt(next);
      } catch {
        if (!current.signal.aborted && epoch.current === version) {
          listRef.current = null;
          setList(null);
          setLoadError(true);
        }
      } finally {
        if (!current.signal.aborted && epoch.current === version) setLoading(false);
      }
    },
    [adopt, client, workdir],
  );

  useEffect(() => {
    const current = new AbortController();
    lifecycle.current = current;
    listRef.current = null;
    mutation.current = false;
    setList(null);
    setLoading(true);
    setBusy(null);
    setLoadError(false);
    setActionError(null);
    void (async () => {
      while (!current.signal.aborted) {
        if (!mutation.current) {
          const since =
            client.longPoll && listRef.current?.available ? listRef.current.revision : undefined;
          await read(current, since);
        }
        await wait(current.signal, client.longPoll ? 1_300 : 5_000);
      }
    })();
    return () => current.abort();
  }, [client, read]);

  const refresh = useCallback(() => {
    const current = lifecycle.current;
    if (!current || mutation.current) return;
    epoch.current += 1;
    setLoading(true);
    void read(current, undefined, true);
  }, [read]);

  const perform = useCallback(
    async (request: DevicePluginRequest) => {
      const current = lifecycle.current;
      if (!current || current.signal.aborted || mutation.current) return;
      mutation.current = true;
      epoch.current += 1;
      setBusy(request.action);
      setActionError(null);
      try {
        const next = await performDevicePluginOperation(client, { ...request, workdir });
        if (!current.signal.aborted && next) adopt(next);
      } catch (error) {
        if (!current.signal.aborted) {
          setActionError(
            typeof error === "string" ? error : error instanceof Error ? error.message : "",
          );
          // Confirm current facts after an uncertain write. Never automatically replay it.
          await read(current, undefined, true);
        }
      } finally {
        if (!current.signal.aborted) {
          mutation.current = false;
          setBusy(null);
          setLoading(false);
        }
      }
    },
    [adopt, client, read, workdir],
  );

  return { list, loading, loadError, busy, actionError, refresh, perform };
}
