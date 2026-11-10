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
export type MarkdownReadingPosition = { block: number; progress: number; top: number };
type ReadingSnapshot = {
  pdfPage: number;
  pdfZoom: PreviewZoom;
  pdfNavigation: boolean;
  docxZoom: PreviewZoom;
  textZoom: number;
  markdownPosition: MarkdownReadingPosition;
  sourceZoom: number;
  sourceWrap: boolean;
  sourceLanguage: string;
  sourceLine: number;
  sourceLeft: number;
  textView: "preview" | "source";
  docxNavigation: "contents" | "pages" | "closed";
  documentComments: DocumentRevisionComment[];
  slidePage: number;
  slideZoom: PreviewZoom;
  slideGrid: boolean;
  sheetName: string;
  sheetZoom: number;
  sheetCell: string;
  sheetRange: string;
  sheetWrap: boolean;
};

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum;
}

function normalizedPoint(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const { x, y } = value as { x: number; y: number };
  return [x, y].every((part) => Number.isFinite(part) && part >= 0 && part <= 1);
}

function validCommentGeometry(item: DocumentRevisionComment) {
  for (const geometry of [item.pdf, item.document]) {
    if (
      geometry !== undefined &&
      (!geometry ||
        !Number.isSafeInteger(geometry.pageCount) ||
        geometry.pageCount < item.page ||
        geometry.pageCount > 1000 ||
        ![geometry.pageWidth, geometry.pageHeight].every(
          (value) => Number.isFinite(value) && value > 0 && value <= 100_000,
        ))
    )
      return false;
  }
  const { target, region, pdf } = item;
  if (pdf && !["point", "region", "text"].includes(pdf.kind)) return false;
  if (target?.kind === "sheet") {
    const cell = /^[A-Z]{1,3}[1-9]\d{0,6}$/i;
    const range = /^[A-Z]{1,3}[1-9]\d{0,6}(?::[A-Z]{1,3}[1-9]\d{0,6})?$/i;
    if (
      !boundedText(target.sheet, 128) ||
      !target.sheet ||
      !boundedText(target.range, 21) ||
      !range.test(target.range) ||
      (target.anchor !== undefined &&
        (!boundedText(target.anchor, 10) || !cell.test(target.anchor)))
    )
      return false;
  } else if (target?.kind === "slide") {
    if (
      target.slide !== item.page ||
      (target.slideId !== undefined && !boundedText(target.slideId, 128)) ||
      (target.slideTitle !== undefined && !boundedText(target.slideTitle, 200)) ||
      (target.point !== undefined && !normalizedPoint(target.point)) ||
      (target.elementOffset !== undefined && !normalizedPoint(target.elementOffset))
    )
      return false;
    const { element } = target;
    if (
      element &&
      (!boundedText(element.id, 64) ||
        !boundedText(element.name, 200) ||
        !boundedText(element.kind, 40) ||
        (element.rotation !== undefined && !Number.isFinite(element.rotation)) ||
        (element.bounds !== undefined &&
          (!element.bounds ||
            ![
              element.bounds.left,
              element.bounds.top,
              element.bounds.width,
              element.bounds.height,
            ].every((value) => Number.isFinite(value) && Math.abs(value) <= 100))))
    )
      return false;
  } else if (target !== undefined) return false;

  if (region === undefined || validDocumentRegion(region, !!item.document)) return true;
  if (!region || (!pdf && target?.kind !== "slide")) return false;
  const { left, top, width, height } = region;
  return (
    [left, top, width, height].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1,
    ) &&
    left + width <= 1.001 &&
    top + height <= 1.001 &&
    (pdf?.kind === "region" ? width > 0 || height > 0 : width === 0 && height === 0)
  );
}

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
      if (field === "markdownPosition") {
        const position = value as MarkdownReadingPosition;
        if (
          !position ||
          !Number.isSafeInteger(position.block) ||
          position.block < -1 ||
          position.block > 2_000_000 ||
          !Number.isFinite(position.progress) ||
          position.progress < 0 ||
          position.progress > 1 ||
          !Number.isFinite(position.top) ||
          position.top < 0 ||
          position.top > 40_000_000
        )
          return;
      }
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
              item.block.length > (item.target ? 256 : 80) ||
              !Number.isSafeInteger(item.page) ||
              item.page < 1 ||
              item.page > 1000 ||
              !validCommentGeometry(item) ||
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
      const maximum = field === "sourceLine" || field === "sourceLeft" ? 10_000_000 : 10_000;
      if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > maximum))
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

export function usePreviewReadingSnapshot<K extends keyof ReadingSnapshot>(field: K) {
  const target = useContext(Target);
  return useMemo(
    () => ({
      read: () => target?.store.read(target.key)?.[field],
      write: (value: ReadingSnapshot[K]) => target?.store.write(target.key, field, value),
    }),
    [field, target],
  );
}

export function usePreviewReadingState<K extends keyof ReadingSnapshot>(
  field: K,
  initial: ReadingSnapshot[K],
): [ReadingSnapshot[K], Dispatch<SetStateAction<ReadingSnapshot[K]>>] {
  const snapshot = usePreviewReadingSnapshot(field);
  const [value, setValue] = useState<ReadingSnapshot[K]>(() => snapshot.read() ?? initial);
  const latest = useRef(value);
  latest.current = value;
  const update = useCallback<Dispatch<SetStateAction<ReadingSnapshot[K]>>>(
    (action) => {
      const next = typeof action === "function" ? action(latest.current) : action;
      latest.current = next;
      snapshot.write(next);
      setValue(next);
    },
    [snapshot],
  );
  return [value, update];
}
