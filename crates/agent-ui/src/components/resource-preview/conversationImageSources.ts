import { useEffect, useLayoutEffect, useMemo, useState } from "react";

type Variant = "original" | "thumbnail";
type Load = (id: string, variant: Variant, signal: AbortSignal) => Promise<Blob>;
type ImageSource = {
  url: string;
  dimensions?: { width: number; height: number };
  assertCurrent: () => void;
};
type Entry = {
  controller: AbortController;
  assertCurrent: () => void;
  leases: number;
  bytes: number;
  blob: Promise<Blob>;
  decoding?: Promise<ImageSource>;
  source?: ImageSource;
  url?: string;
};

const cacheEntries = 16;
const cacheBytes = 48 * 1024 * 1024;

/** One cache per mounted conversation, shared by the transcript and its reader. */
function createImageSources(load: Load, thumbnail: Variant, captureGuard?: () => () => void) {
  const entries = new Map<string, Entry>();
  let bytes = 0;
  let active = false;
  const aborted = () => new DOMException("Image conversation closed", "AbortError");
  const keyFor = (id: string, variant: Variant) => `${variant}:${id}`;
  const remove = (key: string, entry: Entry) => {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    bytes -= entry.bytes;
    entry.controller.abort();
    if (entry.url) URL.revokeObjectURL(entry.url);
  };
  const trim = () => {
    for (const [key, entry] of entries) {
      if (entries.size <= cacheEntries && bytes <= cacheBytes) break;
      if (!entry.leases) remove(key, entry);
    }
  };
  const acquire = (id: string, variant: Variant) => {
    const key = keyFor(id, variant);
    let entry = entries.get(key);
    if (entry) {
      entries.delete(key);
      entries.set(key, entry);
    } else {
      const controller = new AbortController();
      const guard = captureGuard?.();
      const assertCurrent = () => {
        controller.signal.throwIfAborted();
        guard?.();
      };
      const next: Entry = {
        controller,
        assertCurrent,
        leases: 0,
        bytes: 0,
        blob: Promise.resolve()
          .then(() => {
            assertCurrent();
            return load(id, variant, controller.signal);
          })
          .then((blob) => {
            assertCurrent();
            next.bytes = blob.size;
            bytes += blob.size;
            trim();
            return blob;
          })
          .catch((error: unknown) => {
            remove(key, next);
            throw error;
          }),
      };
      entries.set(key, next);
      entry = next;
    }
    entry.leases++;
    return entry;
  };
  const release = (entry: Entry) => {
    entry.leases--;
    trim();
  };
  const decode = (entry: Entry) => {
    entry.decoding ??= entry.blob.then(async (blob) => {
      entry.assertCurrent();
      const url = URL.createObjectURL(blob);
      entry.url = url;
      try {
        const image = document.createElement("img");
        image.src = url;
        await image.decode?.();
        entry.assertCurrent();
        const { naturalWidth: width, naturalHeight: height } = image;
        if (width > 8192 || height > 8192 || width * height > 16_000_000) {
          throw new Error("Image exceeds preview limits");
        }
        const source = {
          url,
          dimensions: width && height ? { width, height } : undefined,
          assertCurrent: entry.assertCurrent,
        };
        entry.source = source;
        return source;
      } catch (error) {
        if (!entry.controller.signal.aborted) URL.revokeObjectURL(url);
        entry.url = undefined;
        throw error;
      }
    });
    return entry.decoding;
  };
  return {
    thumbnail,
    peek(id: string, variant: Variant) {
      if (!active) return undefined;
      const entry = entries.get(keyFor(id, variant));
      try {
        entry?.assertCurrent();
        return entry?.source;
      } catch {
        return undefined;
      }
    },
    display(id: string, variant: Variant) {
      if (!active) return { ready: Promise.reject<ImageSource>(aborted()), release: () => {} };
      const entry = acquire(id, variant);
      return { ready: decode(entry), release: () => release(entry) };
    },
    async read(id: string, signal: AbortSignal) {
      if (!active) throw aborted();
      signal.throwIfAborted();
      const entry = acquire(id, "original");
      try {
        const blob = await entry.blob;
        entry.assertCurrent();
        signal.throwIfAborted();
        return blob;
      } finally {
        release(entry);
      }
    },
    invalidate(id: string, variant: Variant) {
      const key = keyFor(id, variant);
      const entry = entries.get(key);
      if (entry) remove(key, entry);
    },
    activate() {
      active = true;
    },
    dispose() {
      active = false;
      for (const [key, entry] of entries) remove(key, entry);
    },
  };
}

export type ConversationImageSources = ReturnType<typeof createImageSources>;

export function useConversationImageSources(
  scope: string,
  load: Load,
  thumbnail: Variant = "original",
  captureGuard?: () => () => void,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: each authorized scope owns separate entries.
  const sources = useMemo(
    () => createImageSources(load, thumbnail, captureGuard),
    [scope, load, thumbnail, captureGuard],
  );
  useLayoutEffect(() => {
    sources.activate();
    return sources.dispose;
  }, [sources]);
  return sources;
}

export function useConversationImageSource(
  sources: ConversationImageSources,
  id: string,
  variant: Variant,
  enabled = true,
) {
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<{
    sources: ConversationImageSources;
    id: string;
    variant: Variant;
    attempt: number;
  }>();
  const [, repaint] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const lease = sources.display(id, variant);
    void lease.ready.then(
      () => {
        if (active) repaint((value) => value + 1);
      },
      () => {
        if (active) setFailure({ sources, id, variant, attempt });
      },
    );
    return () => {
      active = false;
      lease.release();
    };
  }, [sources, id, variant, enabled, attempt]);
  return {
    source: enabled ? sources.peek(id, variant) : undefined,
    failed:
      failure?.sources === sources &&
      failure.id === id &&
      failure.variant === variant &&
      failure.attempt === attempt,
    retry: () => {
      sources.invalidate(id, variant);
      setAttempt((value) => value + 1);
    },
  };
}
