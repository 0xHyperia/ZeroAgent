import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { List, SquareMousePointer } from "../IconSet";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { DocumentNavigation } from "./DocumentNavigation";
import { docxCoverDocument } from "./docxCoverDocument";
import { prepareDocxOutline } from "./docxOutline";
import { checkedDocumentSelection, prepareReaderDocument } from "./docxReaderDocument";
import { PreviewIdentityContext, PreviewToolbarMount } from "./PreviewChrome";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewScrollArea } from "./PreviewScrollArea";
import { PreviewLeadingTools, PreviewToolbar, PreviewZoomControl } from "./PreviewToolbar";
import { createResourcePreviewWorker } from "./previewWorkerClient";
import {
  type DocumentRevisionComment,
  ResourceDocumentComments,
  type RevisionSelection,
} from "./ResourceDocumentComments";
import { READER_NAVIGATION_INSET, readerScrollBehavior } from "./readerInteraction";
import { nextReaderZoom } from "./readerZoom";
import { usePreviewReadingState } from "./readingSession";
import { usePreviewViewport } from "./usePreviewViewport";

export type ResourceDOCXPreviewProps = PreviewRecovery & {
  bytes: Uint8Array;
  name: string;
  assertCurrent: () => void;
  onCancel?: () => void;
  thumbnail?: boolean;
};

export default function ResourceDOCXPreview(props: ResourceDOCXPreviewProps) {
  const { bytes, assertCurrent } = props;
  const [source, setSource] = useState("");
  const [paintedSource, setPaintedSource] = useState("");
  const [reader, setReader] = useState<ReturnType<typeof prepareReaderDocument> | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [navigation, setNavigation] = usePreviewReadingState("docxNavigation", "closed");
  const [page, setPage] = useState(1);
  const [heading, setHeading] = useState("");
  const [annotating, setAnnotating] = useState(false);
  const dismissSelection = useRef<(() => boolean) | null>(null);
  const annotationEdit = useRef<((id: string, source?: "marker") => void) | null>(null);
  const toggleAnnotation = useCallback(() => {
    setAnnotating((enabled) => !enabled);
  }, []);
  const commentMarks = useRef<string[]>([]);
  const commentNotes = useRef<{ id: string; comment: string; commentId: string }[]>([]);
  const regionMarks = useRef<{ page: number; region: NonNullable<RevisionSelection["region"]> }[]>(
    [],
  );
  const [selection, setSelection] = useState<RevisionSelection | null>(null);
  const [imageShortcut, setImageShortcut] = useState<RevisionSelection | null>(null);
  const selectionRef = useRef(selection ?? imageShortcut);
  selectionRef.current = selection ?? imageShortcut;
  const { onRequestRevision } = useContext(PreviewIdentityContext);
  const requestImageModification = useCallback(() => {
    const image = selectionRef.current;
    if (!onRequestRevision || image?.kind !== "image" || dismissSelection.current?.() === false)
      return;
    setAnnotating(true);
    setSelection({ ...image, visible: false });
    setImageShortcut(null);
  }, [onRequestRevision]);
  const selectComment = useCallback((next: RevisionSelection | null) => {
    if (!next && document.activeElement?.closest(".za-document-comment-editor")) {
      frame.current?.focus({ preventScroll: true });
    }
    setSelection(next?.editingCommentId ? { ...next, visible: false } : next);
  }, []);
  const handleEscape = useCallback(() => {
    if (selection) dismissSelection.current?.();
    else if (annotating) setAnnotating(false);
    else if (imageShortcut) setImageShortcut(null);
    else return false;
    return true;
  }, [annotating, imageShortcut, selection]);
  const chrome = useContext(PreviewToolbarMount);
  const registerEscape = chrome?.registerEscapeHandler;
  useLayoutEffect(
    () => (selection || annotating || imageShortcut ? registerEscape?.(handleEscape) : undefined),
    [annotating, handleEscape, imageShortcut, registerEscape, selection],
  );
  const setFileMenu = chrome?.setFileMenu;
  useEffect(() => {
    if (!setFileMenu || props.thumbnail) return;
    setFileMenu(
      <>
        <DropdownMenuItem
          onClick={() => setNavigation((old) => (old === "closed" ? "contents" : "closed"))}
        >
          <List className="size-4" />
          文档导航
        </DropdownMenuItem>
        {onRequestRevision ? (
          <DropdownMenuItem onClick={toggleAnnotation}>
            <SquareMousePointer className="size-4" />
            请求修改
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
      </>,
    );
    return () => setFileMenu(null);
  }, [setFileMenu, props.thumbnail, onRequestRevision, setNavigation, toggleAnnotation]);

  const [error, setError] = useState("");
  const [zoom, setZoom] = usePreviewReadingState("docxZoom", "fit-width");
  const [pageWidth, setPageWidth] = useState(816);
  const [documentHeight, setDocumentHeight] = useState(1120);
  const floatingTools = !!chrome;
  const logicalScroll = useRef(0);
  const previousScale = useRef(0);
  const zoomPoint = useRef<{ x: number; y: number; screenX: number; screenY: number } | null>(null);
  const { container, viewport, sideInset } = usePreviewViewport();
  const navigationInset =
    navigation !== "closed" && viewport.width >= 600 ? READER_NAVIGATION_INSET : 0;
  const logicalWidth = pageWidth + 48;
  const scale =
    typeof zoom === "number"
      ? Math.max(10, Math.min(400, zoom)) / 100
      : Math.min(
          1,
          Math.max(1, (viewport.width || logicalWidth) - sideInset - navigationInset) /
            logicalWidth,
        );
  const resolveSelectionBounds = useCallback(
    (item: RevisionSelection) => {
      const paper = frame.current?.getBoundingClientRect();
      const viewport = container.current?.getBoundingClientRect();
      if (!paper || !viewport || !frame.current) return;
      return {
        target: new DOMRect(paper.left + item.x * scale, paper.top + item.y * scale, 0, 0),
        viewport,
        observe: frame.current,
        align: "end" as const,
      };
    },
    [container, scale],
  );
  const imageShortcutPosition = useCallback(
    (x: number, y: number, top: number) => {
      const paper = frame.current?.getBoundingClientRect();
      const host = surface.current?.getBoundingClientRect();
      if (!paper || !host) return;
      const bottom = paper.top - host.top + y * scale;
      return {
        x: Math.max(12, Math.min(paper.left - host.left + x * scale - 240, host.width - 240)),
        y: Math.max(64, Math.min(bottom + 8, host.height - 56)),
        visible: bottom > 72 && paper.top - host.top + top * scale < host.height - 20,
      };
    },
    [scale],
  );
  useEffect(() => {
    const controller = new AbortController();
    const client = createResourcePreviewWorker(controller.signal);
    let active = true;
    const check = () => {
      assertCurrent();
      return active && !controller.signal.aborted;
    };
    setSource("");
    setError("");
    void (async () => {
      const inspected = await client.request({ type: "load", kind: "inspect", bytes });
      if (!check()) return;
      if (!inspected.entries?.some((entry) => entry.name === "word/document.xml"))
        throw new Error("此文件不是有效的 DOCX 文档。");
      const { parseAsync, renderDocument } = await import("docx-preview");
      const options = {
        inWrapper: true,
        breakPages: true,
        ignoreFonts: true,
        useBase64URL: true,
        renderAltChunks: false,
        renderComments: false,
        renderChanges: false,
      };
      const parsed: unknown = await parseAsync(bytes.slice().buffer, options);
      if (!check()) return;
      const outline = prepareDocxOutline(parsed);
      const nodes = await renderDocument(parsed, options);
      if (!check()) return;
      const body = window.document.createElement("div");
      body.append(...nodes);
      // Original document hyperlinks never acquire navigation authority.
      for (const link of body.querySelectorAll("a")) link.removeAttribute("href");
      if (props.thumbnail) {
        for (const page of [...body.querySelectorAll("section.docx")].slice(1)) page.remove();
        const styles = window.document.createElement("style");
        styles.textContent =
          "html,body{background:white!important;min-height:100%}.docx-wrapper{padding:0!important;background:white!important}.docx-wrapper>section.docx{margin:0!important;box-shadow:none!important}";
        body.prepend(styles);
      }
      const firstPage = body.querySelector<HTMLElement>("section.docx");
      const width = firstPage?.style.width ?? "";
      const numeric = Number.parseFloat(width);
      const widthInPixels =
        numeric * (width.endsWith("pt") ? 96 / 72 : width.endsWith("in") ? 96 : 1);
      if (Number.isFinite(widthInPixels) && widthInPixels > 0)
        setPageWidth(Math.max(320, Math.min(2400, widthInPixels)));
      if (check()) {
        if (props.thumbnail && firstPage)
          setSource(
            docxCoverDocument(
              [...body.querySelectorAll("style")].map((node) => node.outerHTML).join(""),
              firstPage,
            ),
          );
        else {
          const document = prepareReaderDocument(body, outline);
          setReader(document);
          setSource(document.source);
          if (!document.headings.length)
            setNavigation((old) => (old === "contents" ? "closed" : old));
        }
      }
    })().catch((cause: unknown) => {
      if (active && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "文档未能预览，请下载原件查看。");
    });
    return () => {
      active = false;
      controller.abort();
      client.dispose();
    };
  }, [bytes, assertCurrent, props.thumbnail, setNavigation]);
  const post = useCallback(
    (message: object) => {
      if (reader)
        frame.current?.contentWindow?.postMessage({ token: reader.token, ...message }, "*");
    },
    [reader],
  );
  function navigate(id: string, comment?: DocumentRevisionComment, source?: "marker") {
    if (source === "marker") return;
    post({ type: "navigate", id, region: comment?.region });
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 820px)").matches)
      setNavigation("closed");
  }
  const updateViewport = useCallback(() => {
    const element = container.current;
    if (element)
      logicalScroll.current = (element.scrollTop - (floatingTools ? 80 : 20 * scale)) / scale;
    if (element)
      post({
        type: "viewport",
        top: element.scrollTop / scale,
        height: element.clientHeight / scale,
      });
  }, [container, scale, post, floatingTools]);
  useLayoutEffect(() => {
    const element = container.current;
    const point = zoomPoint.current;
    zoomPoint.current = null;
    const rect = point && frame.current?.getBoundingClientRect();
    if (element && previousScale.current > 0 && previousScale.current !== scale) {
      if (point && rect) {
        element.scrollLeft += rect.left + point.x * scale - point.screenX;
        element.scrollTop += rect.top + point.y * scale - point.screenY;
      } else {
        element.scrollTop = Math.max(
          0,
          logicalScroll.current * scale + (floatingTools ? 80 : 20 * scale),
        );
      }
    }
    previousScale.current = scale;
  }, [container, scale, floatingTools]);
  useEffect(() => {
    post({
      type: "regions",
      items: [
        ...regionMarks.current,
        ...(selection?.region && selection.kind !== "image"
          ? [{ page: selection.page, region: selection.region }]
          : []),
      ],
    });
  }, [selection, post]);
  const trackedSelection = selection ?? imageShortcut;
  const selectedRegion = trackedSelection?.region;
  const editingComment = !!selection;
  useEffect(() => {
    post({
      type: "track",
      id: trackedSelection?.id,
      page: trackedSelection?.page,
      region: selectedRegion,
      editing: editingComment,
      commentId: trackedSelection?.editingCommentId,
    });
  }, [
    post,
    trackedSelection?.id,
    trackedSelection?.page,
    trackedSelection?.editingCommentId,
    selectedRegion,
    editingComment,
  ]);
  useEffect(() => {
    post({ type: "annotate", enabled: annotating });
  }, [annotating, post]);
  const updateLayout = useCallback(() => {
    post({ type: "layout", inset: floatingTools ? 80 / scale : 20, scale });
    updateViewport();
  }, [post, floatingTools, scale, updateViewport]);
  useEffect(() => {
    if (viewport.height > 0) updateLayout();
  }, [updateLayout, viewport.height]);
  useEffect(() => {
    if (!reader) return;
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== "null" ||
        event.data?.token !== reader.token
      )
        return;
      try {
        assertCurrent();
      } catch {
        return;
      }
      if (
        event.data.type === "zoom" &&
        Number.isFinite(event.data.delta) &&
        Math.abs(event.data.delta) <= 100
      ) {
        const { x, y } = event.data;
        const rect = frame.current?.getBoundingClientRect();
        if (
          rect &&
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          x >= 0 &&
          y >= 0 &&
          x * scale <= rect.width &&
          y * scale <= rect.height
        ) {
          zoomPoint.current = {
            x,
            y,
            screenX: rect.left + x * scale,
            screenY: rect.top + y * scale,
          };
        }
        setZoom((current) =>
          nextReaderZoom(
            typeof current === "number" ? current : scale * 100,
            event.data.delta,
            400,
            10,
            "document",
          ),
        );
      }
      if (event.data.type === "zoom-reset") setZoom("fit-width");
      if (event.data.type === "ready") {
        updateLayout();
        post({ type: "capabilities", revision: !!onRequestRevision });
        post({ type: "annotate", enabled: annotating });
        post({ type: "marks", ids: commentMarks.current, items: commentNotes.current });
      }
      if (
        event.data.type === "height" &&
        Number.isFinite(event.data.height) &&
        event.data.height > 0 &&
        event.data.height <= 2000000
      ) {
        setDocumentHeight(event.data.height);
      }
      if (
        event.data.type === "navigate" &&
        Number.isFinite(event.data.top) &&
        event.data.top >= 0 &&
        event.data.top <= 2000000
      ) {
        container.current?.scrollTo({
          top: Math.max(0, event.data.top * scale - (floatingTools ? 64 : 16)),
          behavior: readerScrollBehavior(),
        });
        updateViewport();
      }
      if (
        event.data.type === "page" &&
        Number.isSafeInteger(event.data.page) &&
        event.data.page >= 1 &&
        event.data.page <= reader.pages.length
      )
        setPage(event.data.page);
      if (
        event.data.type === "heading" &&
        reader.headings.some((item) => item.id === event.data.id)
      )
        setHeading(event.data.id);
      if (
        event.data.type === "position" &&
        selectionRef.current?.id === event.data.id &&
        [event.data.x, event.data.y, event.data.top, event.data.bottom].every(
          (value) => Number.isFinite(value) && Math.abs(value) <= 2000000,
        )
      ) {
        const { id, x, y } = event.data;
        if (selection) {
          setSelection((old) =>
            old && old.id === id && (old.x !== x || old.y !== y || old.visible === false)
              ? { ...old, x, y, visible: true }
              : old,
          );
        } else {
          const shortcut = imageShortcutPosition(x, y, event.data.top);
          setImageShortcut((old) =>
            old && old.id === id && shortcut ? { ...old, ...shortcut } : old,
          );
        }
      }
      if (event.data.type === "annotation-escape") handleEscape();
      if (event.data.type === "image-shortcut-clear") setImageShortcut(null);
      if (
        event.data.type === "edit-comment" &&
        onRequestRevision &&
        typeof event.data.id === "string"
      )
        annotationEdit.current?.(event.data.id, "marker");
      if (event.data.type === "request-modification" && onRequestRevision) {
        if (selectionRef.current?.kind === "image") requestImageModification();
        else toggleAnnotation();
      }
      if (
        (event.data.type === "selection" && annotating) ||
        (event.data.type === "image-shortcut" && onRequestRevision && !annotating && !selection)
      ) {
        const chosen = checkedDocumentSelection(event.data, reader.blocks, reader.pageCount);
        if (chosen && (event.data.type !== "image-shortcut" || chosen.kind === "image")) {
          if (event.data.type === "selection" && dismissSelection.current?.() === false) return;
          if (event.data.type === "selection") setImageShortcut(null);
          const update = event.data.type === "image-shortcut" ? setImageShortcut : setSelection;
          const { pageWidth, pageHeight } = event.data;
          const hasGeometry = [pageWidth, pageHeight].every(
            (value) => Number.isFinite(value) && value > 0 && value <= 100_000,
          );
          update({
            ...chosen,
            ...(event.data.type === "image-shortcut"
              ? imageShortcutPosition(chosen.x, chosen.y, chosen.y)
              : {}),
            ...(hasGeometry
              ? { document: { pageCount: reader.pageCount, pageWidth, pageHeight } }
              : {}),
          });
        }
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [
    reader,
    annotating,
    assertCurrent,
    scale,
    post,
    container,
    floatingTools,
    updateLayout,
    updateViewport,
    setZoom,
    onRequestRevision,
    selection,
    handleEscape,
    imageShortcutPosition,
    toggleAnnotation,
    requestImageModification,
  ]);
  if (props.thumbnail)
    return (
      <div className="za-docx-thumbnail" ref={container} inert>
        {source ? (
          <iframe
            sandbox=""
            referrerPolicy="no-referrer"
            tabIndex={-1}
            title={props.name}
            srcDoc={source}
            className="za-preview-frame-content"
            style={{
              width: pageWidth,
              minWidth: pageWidth,
              transform: `scale(${(viewport.width || 168) / pageWidth})`,
            }}
            data-ready={paintedSource === source}
            onLoad={() => setPaintedSource(source)}
          />
        ) : error ? (
          <span className="za-thumbnail-fallback">Word</span>
        ) : (
          <PreviewLoading />
        )}
        {source && paintedSource !== source ? (
          <div className="za-preview-frame-pending" data-cover="true">
            <PreviewLoading />
          </div>
        ) : null}
      </div>
    );
  return (
    <>
      <PreviewToolbar label="Word 文档" detail="只读">
        <PreviewLeadingTools>
          {onRequestRevision && !props.thumbnail ? (
            <Button
              variant="ghost"
              size="sm"
              className="za-request-revision"
              data-active={annotating}
              aria-pressed={annotating}
              onClick={toggleAnnotation}
            >
              <SquareMousePointer className="size-4" />
              请求修改
            </Button>
          ) : null}
        </PreviewLeadingTools>
        <PreviewZoomControl
          label="文档缩放"
          value={zoom}
          onChange={setZoom}
          actualPercent={scale * 100}
          minPercent={10}
          zoomCurve="document"
          percentages={[25, 50, 100, 200]}
          fitPage={false}
        />
      </PreviewToolbar>
      {/* biome-ignore lint/a11y/useSemanticElements: This boundary groups the paper and floating controls, not form fields. */}
      <div
        className="za-document-workspace"
        role="group"
        aria-label="Word 阅读与批注"
        ref={surface}
        data-navigation-pinned={navigation !== "closed"}
        data-annotating={annotating}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            !event.defaultPrevented &&
            !event.nativeEvent.isComposing &&
            (event.repeat ? !!selection : handleEscape())
          ) {
            event.preventDefault();
            event.stopPropagation();
          }
          if (
            (event.ctrlKey || event.metaKey) &&
            event.shiftKey &&
            event.key.toLowerCase() === "x" &&
            imageShortcut
          ) {
            event.preventDefault();
            requestImageModification();
          }
        }}
      >
        {!props.thumbnail && reader ? (
          <DocumentNavigation
            label="文档导航"
            pinned={navigation !== "closed"}
            onPinned={(pinned) =>
              setNavigation(pinned ? (reader.headings.length ? "contents" : "pages") : "closed")
            }
            count={
              navigation !== "pages" && reader.headings.length
                ? reader.headings.length
                : reader.pages.length
            }
            current={
              navigation !== "pages" && reader.headings.length
                ? Math.max(1, reader.headings.findIndex((item) => item.id === heading) + 1)
                : page
            }
            activeKey={heading}
            title={navigation === "pages" ? `${reader.pages.length} 页` : "目录"}
            actions={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={navigation === "pages" ? "切换为文档目录" : "切换为页面缩略图"}
                disabled={!reader.headings.length}
                onClick={() => setNavigation(navigation === "pages" ? "contents" : "pages")}
              >
                <List className="size-4" />
              </Button>
            }
          >
            {navigation !== "pages" && reader.headings.length
              ? reader.headings.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    style={{ paddingInlineStart: 10 + Math.min(4, item.level) * 10 }}
                    aria-current={heading === item.id ? "location" : undefined}
                    onClick={() => navigate(item.id)}
                  >
                    {item.title}
                  </button>
                ))
              : reader.pages.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    className="za-document-page-link"
                    aria-label={`第 ${index + 1} 页`}
                    aria-current={page === index + 1 ? "page" : undefined}
                    onClick={() => navigate(item.id)}
                  >
                    <span>{index + 1}</span>
                    {item.cover ? (
                      <span className="za-document-page-cover" inert>
                        <iframe
                          sandbox=""
                          title={`第 ${index + 1} 页缩略图`}
                          loading="lazy"
                          srcDoc={item.cover}
                          tabIndex={-1}
                        />
                      </span>
                    ) : null}
                  </button>
                ))}
          </DocumentNavigation>
        ) : null}
        <PreviewScrollArea
          ref={container}
          className="za-docx-zoom-viewport"
          onScroll={updateViewport}
        >
          {error ? (
            <PreviewUnavailable
              message={error}
              onDownload={props.onDownload}
              onRetry={props.onRetry}
            />
          ) : source ? (
            <div
              className="za-docx-zoom-surface"
              style={
                props.thumbnail
                  ? undefined
                  : {
                      width: logicalWidth * scale,
                      height: documentHeight * scale,
                      marginInline: "auto",
                    }
              }
            >
              <iframe
                ref={frame}
                className="za-preview-document za-preview-frame-content"
                data-ready={paintedSource === source}
                sandbox={props.thumbnail ? "" : "allow-scripts"}
                referrerPolicy="no-referrer"
                title={props.name}
                srcDoc={source}
                onLoad={() => setPaintedSource(source)}
                style={
                  props.thumbnail
                    ? undefined
                    : {
                        width: logicalWidth,
                        height: documentHeight,
                        transform: `scale(${scale})`,
                        transformOrigin: "top left",
                      }
                }
              />
            </div>
          ) : (
            <PreviewLoading message="正在排版文档…" onCancel={props.onCancel} />
          )}
        </PreviewScrollArea>
        {source && paintedSource !== source && !error ? (
          <div className="za-preview-frame-pending">
            <PreviewLoading onCancel={props.onCancel} />
          </div>
        ) : null}
        {imageShortcut && !annotating && imageShortcut.visible !== false && onRequestRevision ? (
          <div
            className="za-document-image-shortcut"
            style={{ left: imageShortcut.x, top: imageShortcut.y }}
          >
            <Button variant="ghost" size="sm" onClick={requestImageModification}>
              <SquareMousePointer className="size-4" />
              请求修改
              <kbd>Ctrl Shift X</kbd>
            </Button>
          </div>
        ) : null}
        {!props.thumbnail ? (
          <ResourceDocumentComments
            editRef={annotationEdit}
            dismissSelectionRef={dismissSelection}
            enabled={annotating}
            onEnabled={setAnnotating}
            selection={selection}
            onSelection={selectComment}
            onNavigate={navigate}
            resolveSelectionBounds={resolveSelectionBounds}
            onMarks={(items) => {
              const ids = items
                .filter((item) => !item.region || item.kind === "image")
                .flatMap((item) => item.anchors?.map((anchor) => anchor.id) ?? [item.block]);
              commentMarks.current = ids;
              commentNotes.current = items
                .filter((item) => !item.region || item.kind === "image")
                .map((item) => ({ id: item.block, comment: item.comment, commentId: item.id }));
              post({ type: "marks", ids, items: commentNotes.current });
              const regions = items.flatMap((item) =>
                item.region && item.kind !== "image"
                  ? [
                      {
                        page: item.page,
                        region: item.region,
                        comment: item.comment,
                        commentId: item.id,
                      },
                    ]
                  : [],
              );
              regionMarks.current = regions;
              post({
                type: "regions",
                items: [
                  ...regions,
                  ...(selection?.region && selection.kind !== "image"
                    ? [{ page: selection.page, region: selection.region }]
                    : []),
                ],
              });
            }}
          />
        ) : null}
      </div>
    </>
  );
}
