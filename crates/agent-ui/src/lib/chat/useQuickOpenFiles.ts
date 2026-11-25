import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { QuickOpenMatch } from "./fileQuickOpen";
import {
  createQuickOpenSearchClient,
  type QuickOpenFileSource,
  type QuickOpenSearchClient,
  quickOpenIndexPaths,
} from "./fileQuickOpenSearch";

type IndexState = {
  scopeKey: string;
  ready: Promise<{ client: QuickOpenSearchClient; truncated: boolean }>;
};

type ResultState = {
  index: IndexState;
  query: string;
  matches: readonly QuickOpenMatch[];
  truncated: boolean;
  status: "ready" | "error";
};

export function useQuickOpenFiles(
  source: QuickOpenFileSource | undefined,
  open: boolean,
  query: string | null,
) {
  const sourceRef = useRef(source);
  useLayoutEffect(() => {
    sourceRef.current = source;
  }, [source]);
  const [result, setResult] = useState<ResultState>();
  const indexRef = useRef<IndexState | null>(null);
  const scopeKey = open ? source?.scopeKey : undefined;
  const [index, setIndex] = useState<IndexState | null>(null);
  const [requestedScope, setRequestedScope] = useState<string>();

  useEffect(() => {
    if (scopeKey && query !== null) setRequestedScope(scopeKey);
    else if (!scopeKey) setRequestedScope(undefined);
  }, [query, scopeKey]);

  useEffect(() => {
    const currentSource = sourceRef.current;
    setResult(undefined);
    setIndex(null);
    if (!scopeKey || scopeKey !== requestedScope || currentSource?.scopeKey !== scopeKey) return;
    const controller = new AbortController();
    let client: QuickOpenSearchClient | null = null;
    const next: IndexState = {
      scopeKey,
      ready: Promise.resolve().then(async () => {
        controller.signal.throwIfAborted();
        const workerFactory =
          typeof Worker === "undefined"
            ? undefined
            : import("./fileQuickOpenWorkerFactory").then(
                (module) => module.createQuickOpenWorker,
                () => undefined,
              );
        const [listing, createWorker] = await Promise.all([
          currentSource.listFiles(controller.signal),
          workerFactory,
        ]);
        controller.signal.throwIfAborted();
        if (sourceRef.current?.scopeKey !== scopeKey) throw new Error("File scope changed");
        client = createQuickOpenSearchClient({ createWorker });
        client.setIndex(scopeKey, quickOpenIndexPaths(listing));
        return { client, truncated: listing.truncated };
      }),
    };
    // Loading can finish after the user leaves the file scope.
    void next.ready.catch(() => undefined);
    indexRef.current = next;
    setIndex(next);
    return () => {
      controller.abort();
      client?.dispose();
      indexRef.current = null;
    };
  }, [requestedScope, scopeKey]);

  useEffect(() => {
    if (!index || query === null || index.scopeKey !== scopeKey) return;
    let cancelled = false;
    void index.ready
      .then(async ({ client, truncated }) => {
        if (cancelled) return;
        const matches = await client.search(index.scopeKey, query);
        if (!cancelled && matches) setResult({ index, query, matches, status: "ready", truncated });
      })
      .catch(() => {
        if (!cancelled) setResult({ index, query, matches: [], status: "error", truncated: false });
      });
    return () => {
      cancelled = true;
    };
  }, [index, query, scopeKey]);

  if (!scopeKey) return { status: "unavailable" } as const;
  if (
    !result ||
    result.index !== indexRef.current ||
    result.index.scopeKey !== scopeKey ||
    result.query !== query
  ) {
    return { status: "loading" } as const;
  }
  return result;
}
