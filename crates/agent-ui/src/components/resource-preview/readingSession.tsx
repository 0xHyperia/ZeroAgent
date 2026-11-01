import {
  createContext,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { validDocumentRegion } from "./docxReaderDocument";
import type { DocumentRevisionComment } from "./ResourceDocumentComments";

export type PreviewZoom = "fit-width" | "fit-page" | number;
type ReadingSnapshot = {
  pdfPage: number;
  pdfZoom: PreviewZoom;
  pdfNavigation: boolean;
  docxZoom: PreviewZoom;
  textZoom: number;
  docxNavigation: "contents" | "pages" | "closed";
  documentComments: DocumentRevisionComment[];
  slidePage: number;
  slideZoom: PreviewZoom;
  slideGrid: boolean;
  sheetName: string;
  sheetZoom: number;
  sheetCell: string;
  sheetWrap: boolean;
};

/** Only small presentation values are retained. Never store file bytes or authority here. */
export function createReadingSnapshotStore() {
  const entries = new Map<string, Partial<ReadingSnapshot>>();
  return {
    read(key: string) {
      const snapshot = entries.get(key);
      if (snapshot) {
        entries.delete(key);
        entries.set(key, snapshot);
      }
      return snapshot;
    },
    write<K extends keyof ReadingSnapshot>(key: string, field: K, value: ReadingSnapshot[K]) {
      if (
        field === "documentComments" &&
        (!Array.isArray(value) ||
          value.length > 20 ||
          value.some(
            (item) =>
              !item ||
              typeof item !== "object" ||
              typeof item.quote !== "string" ||
              item.quote.length > 2000 ||
              typeof item.comment !== "string" ||
              item.comment.length > 2000 ||
              typeof item.block !== "string" ||
              item.block.length > 80 ||
              !Number.isSafeInteger(item.page) ||
              item.page < 1 ||
              item.page > 1000 ||
              (item.region !== undefined && !validDocumentRegion(item.region)) ||
              (item.anchors !== undefined &&
                (!Array.isArray(item.anchors) ||
                  item.anchors.length > 20 ||
                  item.anchors.some(
                    (anchor) =>
                      !anchor ||
                      typeof anchor.id !== "string" ||
                      anchor.id.length > 80 ||
                      !Number.isSafeInteger(anchor.start) ||
                      !Number.isSafeInteger(anchor.end) ||
                      anchor.start < 0 ||
                      anchor.end <= anchor.start ||
                      anchor.end - anchor.start > 2000,
                  ))),
          ))
      )
        return;
      if (typeof value === "string" && value.length > 128) return;
      if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > 10_000))
        return;
      const snapshot = { ...entries.get(key), [field]: value };
      entries.delete(key);
      entries.set(key, snapshot);
      while (entries.size > 20) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
    },
  };
}

const Session = createContext<{
  scope: string;
  store: ReturnType<typeof createReadingSnapshotStore>;
} | null>(null);
const Target = createContext<{
  key: string;
  store: ReturnType<typeof createReadingSnapshotStore>;
} | null>(null);

/** The host supplies its account lifetime. Replacing it immediately retires all old snapshots. */
export function ResourcePreviewReadingSession({
  scope,
  children,
}: {
  scope: string;
  children: ReactNode;
}) {
  const current = useRef<{ scope: string; store: ReturnType<typeof createReadingSnapshotStore> }>(
    null,
  );
  if (!current.current || current.current.scope !== scope)
    current.current = { scope, store: createReadingSnapshotStore() };
  return <Session.Provider value={current.current}>{children}</Session.Provider>;
}

export function usePreviewReadingScope() {
  return useContext(Session)?.scope;
}

export function PreviewReadingTarget({
  identity,
  children,
}: {
  identity: string;
  children: ReactNode;
}) {
  const session = useContext(Session);
  const target = useMemo(
    () => (session ? { key: identity, store: session.store } : null),
    [identity, session],
  );
  return <Target.Provider value={target}>{children}</Target.Provider>;
}

export function usePreviewReadingState<K extends keyof ReadingSnapshot>(
  field: K,
  initial: ReadingSnapshot[K],
): [ReadingSnapshot[K], Dispatch<SetStateAction<ReadingSnapshot[K]>>] {
  const target = useContext(Target);
  const [value, setValue] = useState<ReadingSnapshot[K]>(
    () => target?.store.read(target.key)?.[field] ?? initial,
  );
  const latest = useRef(value);
  latest.current = value;
  const update = useCallback<Dispatch<SetStateAction<ReadingSnapshot[K]>>>(
    (action) => {
      const next = typeof action === "function" ? action(latest.current) : action;
      latest.current = next;
      target?.store.write(target.key, field, next);
      setValue(next);
    },
    [field, target],
  );
  return [value, update];
}
