import type { PDFDocumentProxy, TextLayer } from "pdfjs-dist";
import type { EventBus } from "pdfjs-dist/types/web/event_utils";
import type { FindState, PDFFindController } from "pdfjs-dist/types/web/pdf_find_controller";
import type { PDFLinkService } from "pdfjs-dist/types/web/pdf_link_service";

type FindViewer = {
  EventBus: typeof EventBus;
  FindState: typeof FindState;
  PDFFindController: new (
    options: ConstructorParameters<typeof PDFFindController>[0],
  ) => PDFFindController & { setDocument(pdf: null): void };
  PDFLinkService: typeof PDFLinkService;
};

export async function createPDFFind(
  pdf: PDFDocumentProxy,
  navigation: { current: () => number; go: (page: number) => void },
) {
  // The viewer module supplies the find controller, independently of our page renderer.
  // @ts-expect-error pdfjs-dist ships the browser module separately from its viewer types.
  const viewer = (await import("pdfjs-dist/web/pdf_viewer.mjs")) as FindViewer;
  const { EventBus, FindState, PDFFindController, PDFLinkService } = viewer;
  const eventBus = new EventBus();
  const linkService = new PDFLinkService({ eventBus });
  linkService.setDocument(pdf);
  linkService.setViewer({
    get currentPageNumber() {
      return navigation.current();
    },
    set currentPageNumber(page: number) {
      navigation.go(page);
    },
  });
  const controller = new PDFFindController({ eventBus, linkService });
  controller.setDocument(pdf);
  let lastQuery = "";
  return {
    subscribe(update: (state: { current: number; total: number; pending?: boolean }) => void) {
      const count = ({ matchesCount }: { matchesCount: { current: number; total: number } }) =>
        update(matchesCount);
      const status = ({
        state,
        matchesCount,
      }: {
        state: number;
        matchesCount: { current: number; total: number };
      }) => update({ ...matchesCount, pending: state === FindState.PENDING });
      eventBus.on("updatefindmatchescount", count);
      eventBus.on("updatefindcontrolstate", status);
      return () => {
        eventBus.off("updatefindmatchescount", count);
        eventBus.off("updatefindcontrolstate", status);
      };
    },
    find(query: string, direction?: "next" | "previous") {
      const type = direction ? "again" : query === lastQuery ? "highlightallchange" : "";
      lastQuery = query;
      eventBus.dispatch("find", {
        query,
        type,
        findPrevious: direction === "previous",
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        matchDiacritics: false,
      });
    },
    close() {
      eventBus.dispatch("findbarclose", {});
    },
    destroy() {
      controller.setDocument(null);
    },
    register(pageIndex: number, layer: TextLayer) {
      const draw = ({ pageIndex: changed }: { pageIndex: number }) => {
        if (changed !== -1 && changed !== pageIndex) return;
        const offsets: readonly number[] = controller.highlightMatches
          ? (controller.pageMatches?.[pageIndex] ?? [])
          : [];
        const lengths: readonly number[] = controller.pageMatchesLength?.[pageIndex] ?? [];
        const selected = controller.selected;
        let offset = 0;
        let match = 0;
        let active: HTMLElement | undefined;
        for (const [index, span] of layer.textDivs.entries()) {
          const value = layer.textContentItemsStr[index] ?? "";
          const end = offset + value.length;
          while (match < offsets.length && offsets[match] + lengths[match] <= offset) match++;
          if (match >= offsets.length || offsets[match] >= end) {
            if (span.childElementCount) span.textContent = value;
            offset = end;
            continue;
          }
          const fragment = span.ownerDocument.createDocumentFragment();
          let from = 0;
          for (let i = match; i < offsets.length && offsets[i] < end; i++) {
            const left = Math.max(from, offsets[i] - offset);
            const right = Math.min(value.length, offsets[i] + lengths[i] - offset);
            if (right <= left) continue;
            const mark = span.ownerDocument.createElement("mark");
            mark.className = "za-pdf-find-match";
            mark.textContent = value.slice(left, right);
            if (selected?.pageIdx === pageIndex && selected.matchIdx === i) {
              mark.dataset.active = "";
              active ??= mark;
            }
            fragment.append(value.slice(from, left), mark);
            from = right;
          }
          fragment.append(value.slice(from));
          span.replaceChildren(fragment);
          offset = end;
        }
        if (active && selected) {
          controller.scrollMatchIntoView({
            element: active,
            pageIndex,
            matchIndex: selected.matchIdx,
          });
        }
      };
      eventBus.on("updatetextlayermatches", draw);
      draw({ pageIndex });
      return () => {
        eventBus.off("updatetextlayermatches", draw);
        for (const [index, span] of layer.textDivs.entries()) {
          if (span.childElementCount) span.textContent = layer.textContentItemsStr[index] ?? "";
        }
      };
    },
  };
}

export type PDFFind = Awaited<ReturnType<typeof createPDFFind>>;
