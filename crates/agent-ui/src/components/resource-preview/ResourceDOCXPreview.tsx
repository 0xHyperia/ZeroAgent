import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { List, MessageSquare, PanelLeft } from "../IconSet";
import { DropdownMenuItem, DropdownMenuSeparator } from "../ui/dropdown-menu";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { prepareDocxOutline } from "./docxOutline";
import { checkedDocumentSelection, prepareReaderDocument } from "./docxReaderDocument";
import { PreviewIdentityContext, PreviewToolbarMount } from "./PreviewChrome";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewToolbar, PreviewZoomControl } from "./PreviewToolbar";
import { isolatedPreviewDocument } from "./previewPolicy";
import { createResourcePreviewWorker } from "./previewWorkerClient";
import { ResourceDocumentComments, type RevisionSelection } from "./ResourceDocumentComments";
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
  const [reader, setReader] = useState<ReturnType<typeof prepareReaderDocument> | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [navigation, setNavigation] = usePreviewReadingState(
    "docxNavigation",
    typeof window.matchMedia === "function" && window.matchMedia("(max-width: 820px)").matches
      ? "closed"
      : "contents",
  );
  const [page, setPage] = useState(1);
  const [annotating, setAnnotating] = useState(false);
  const commentMarks = useRef<string[]>([]);
  const [selection, setSelection] = useState<RevisionSelection | null>(null);
  const { onRequestRevision } = useContext(PreviewIdentityContext);
  const chrome = useContext(PreviewToolbarMount);
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
          <DropdownMenuItem onClick={() => setAnnotating((old) => !old)}>
            <MessageSquare className="size-4" />
            请求修改
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
      </>,
    );
    return () => setFileMenu(null);
  }, [setFileMenu, props.thumbnail, onRequestRevision, setNavigation]);

  const [error, setError] = useState("");
  const [zoom, setZoom] = usePreviewReadingState("docxZoom", "fit-width");
  const [pageWidth, setPageWidth] = useState(816);
  const { container, viewport } = usePreviewViewport();
  const logicalWidth = pageWidth + 48;
  const scale =
    typeof zoom === "number"
      ? zoom / 100
      : Math.min(1, (viewport.width || logicalWidth) / logicalWidth);
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
        if (props.thumbnail) setSource(isolatedPreviewDocument(body.outerHTML, "document"));
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
  function navigate(id: string) {
    post({ type: "navigate", id });
    if (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 820px)").matches)
      setNavigation("closed");
  }
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
      if (event.data.type === "ready") {
        post({ type: "annotate", enabled: annotating });
        post({ type: "marks", ids: commentMarks.current });
      }
      if (
        event.data.type === "page" &&
        Number.isSafeInteger(event.data.page) &&
        event.data.page >= 1 &&
        event.data.page <= reader.pages.length
      )
        setPage(event.data.page);
      if (event.data.type === "selection" && annotating) {
        const chosen = checkedDocumentSelection(event.data, reader.blocks);
        const rect = frame.current?.getBoundingClientRect(),
          host = surface.current?.getBoundingClientRect();
        if (chosen && rect && host)
          setSelection({
            ...chosen,
            x: Math.min(
              Math.max(12, rect.left - host.left + chosen.x * scale),
              Math.max(12, host.width - 352),
            ),
            y: Math.min(rect.top - host.top + chosen.y * scale, host.height - 150),
          });
      }
    };
    window.addEventListener("message", receive);
    post({ type: "annotate", enabled: annotating });
    return () => window.removeEventListener("message", receive);
  }, [reader, annotating, assertCurrent, scale, post]);
  return (
    <>
      <PreviewToolbar label="Word 文档" detail="只读">
        {!props.thumbnail ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="文档导航"
            tooltip="文档导航"
            onClick={() =>
              setNavigation(
                navigation === "closed"
                  ? reader?.headings.length
                    ? "contents"
                    : "pages"
                  : "closed",
              )
            }
          >
            <List className="size-4" />
          </Button>
        ) : null}
        {onRequestRevision && !props.thumbnail ? (
          <Button
            variant="ghost"
            size="sm"
            className="za-request-revision"
            data-active={annotating}
            onClick={() => setAnnotating(!annotating)}
          >
            <MessageSquare className="size-4" />
            请求修改
          </Button>
        ) : null}
        <PreviewZoomControl label="文档缩放" value={zoom} onChange={setZoom} fitPage={false} />
      </PreviewToolbar>
      <div className="za-document-workspace" ref={surface}>
        {!props.thumbnail && reader ? (
          navigation !== "closed" ? (
            <aside className="za-document-navigation" aria-label="文档导航">
              <header>
                <strong>{navigation === "contents" ? "目录" : `${reader.pages.length} 页`}</strong>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={navigation === "contents" ? "切换为页面缩略图" : "切换为文档目录"}
                  disabled={!reader.headings.length}
                  onClick={() => setNavigation(navigation === "contents" ? "pages" : "contents")}
                >
                  <PanelLeft className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="收起文档导航"
                  onClick={() => setNavigation("closed")}
                >
                  <List className="size-4" />
                </Button>
              </header>
              <nav>
                {navigation === "contents"
                  ? reader.headings.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        style={{ paddingInlineStart: 10 + Math.min(4, item.level) * 10 }}
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
              </nav>
            </aside>
          ) : (
            <button
              type="button"
              className="za-document-navigation-rail"
              aria-label="展开文档导航"
              onClick={() => setNavigation(reader.headings.length ? "contents" : "pages")}
            >
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
            </button>
          )
        ) : null}
        <div ref={container} className="za-docx-zoom-viewport">
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
                  : { width: logicalWidth * scale, height: "100%", marginInline: "auto" }
              }
            >
              <iframe
                ref={frame}
                className="za-preview-document"
                sandbox={props.thumbnail ? "" : "allow-scripts"}
                referrerPolicy="no-referrer"
                title={props.name}
                srcDoc={source}
                style={
                  props.thumbnail
                    ? undefined
                    : {
                        width: logicalWidth,
                        height: `${100 / scale}%`,
                        transform: `scale(${scale})`,
                        transformOrigin: "top left",
                      }
                }
              />
            </div>
          ) : (
            <PreviewLoading message="正在排版文档…" onCancel={props.onCancel} />
          )}
        </div>
        {!props.thumbnail ? (
          <ResourceDocumentComments
            enabled={annotating}
            onEnabled={setAnnotating}
            selection={selection}
            onSelection={setSelection}
            onNavigate={navigate}
            onMarks={(items) => {
              const ids = items.map((item) => item.block);
              commentMarks.current = ids;
              post({ type: "marks", ids });
            }}
          />
        ) : null}
      </div>
    </>
  );
}
