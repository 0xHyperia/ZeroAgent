import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  version as pdfVersion,
} from "pdfjs-dist";
import pdfWorkerURL from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useEffect, useRef, useState } from "react";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import {
  PreviewPageControls,
  PreviewToolbar,
  PreviewZoomControl,
  previewPageKey,
} from "./PreviewToolbar";
import { pdfPreviewAssetsURL } from "./pdfPreviewAssets";
import { boundedPreviewScale, previewScale } from "./previewGeometry";
import { usePreviewReadingState } from "./readingSession";
import { usePreviewViewport } from "./usePreviewViewport";

GlobalWorkerOptions.workerSrc = pdfWorkerURL;

export default function ResourcePDFPreview({
  bytes,
  assertCurrent,
  onDownload,
  onRetry,
  onCancel,
}: PreviewRecovery & {
  bytes: Uint8Array;
  assertCurrent: () => void;
  onCancel?: () => void;
}) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = usePreviewReadingState("pdfPage", 1);
  const [zoom, setZoom] = usePreviewReadingState("pdfZoom", "fit-width");
  const [error, setError] = useState("");
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [busy, setBusy] = useState(true);
  const { container, viewport: pane } = usePreviewViewport<HTMLElement>();
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true;
    const assets = pdfPreviewAssetsURL(pdfVersion);
    const task = getDocument({
      data: bytes.slice(),
      enableXfa: false,
      cMapUrl: `${assets}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assets}standard_fonts/`,
      wasmUrl: `${assets}wasm/`,
      iccUrl: `${assets}iccs/`,
      useSystemFonts: true,
    });
    const timer = setTimeout(() => {
      if (active) {
        setError("PDF 较复杂，读取超时。请下载原件查看。");
        setBusy(false);
        void task.destroy();
      }
    }, 30_000);
    void task.promise
      .then((result) => {
        clearTimeout(timer);
        assertCurrent();
        if (result.numPages > 1000) throw new Error("PDF 页数超过预览限制。");
        if (active) setDocument(result);
      })
      .catch(() => {
        clearTimeout(timer);
        if (active) {
          setError("PDF 无法打开，可能已加密或损坏。请下载原件查看。");
          setBusy(false);
        }
      });
    return () => {
      active = false;
      clearTimeout(timer);
      void task.destroy();
    };
  }, [bytes, assertCurrent]);
  useEffect(() => {
    if (!document || !canvas.current) return;
    let active = true;
    let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy["getPage"]>>["render"]> | null =
      null;
    const element = canvas.current;
    setBusy(true);
    setError("");
    void document
      .getPage(page)
      .then(async (pdfPage) => {
        assertCurrent();
        if (!active) return;
        // PDF points are 1/72 inch; 100% uses the browser's 96 CSS pixels per inch.
        const cssUnits = 96 / 72;
        const base = pdfPage.getViewport({ scale: cssUnits });
        setPageSize({ width: base.width, height: base.height });
        const desiredScale = previewScale(zoom, base, {
          width: pane.width || 600,
          height: pane.height || 800,
        });
        const scale = boundedPreviewScale(desiredScale, base);
        const viewport = pdfPage.getViewport({ scale: cssUnits * scale });
        element.width = Math.max(1, Math.floor(viewport.width));
        element.height = Math.max(1, Math.floor(viewport.height));
        element.style.width = `${base.width * scale}px`;
        element.style.height = `${base.height * scale}px`;
        render = pdfPage.render({ canvas: element, viewport });
        await render.promise;
        assertCurrent();
        if (active) setBusy(false);
      })
      .catch(() => {
        if (active) {
          setError("此页未能渲染，请下载原件查看。");
          setBusy(false);
        }
      });
    return () => {
      active = false;
      render?.cancel();
    };
  }, [document, page, zoom, pane.width, pane.height, assertCurrent]);
  function navigatePage(target: number) {
    if (target === page) return;
    setBusy(true);
    setError("");
    setPage(target);
    container.current?.scrollTo?.({ top: 0, left: 0 });
  }
  return (
    <>
      <PreviewToolbar label="PDF" detail="只读">
        <PreviewPageControls
          page={page}
          count={document?.numPages ?? 0}
          busy={busy}
          onPage={navigatePage}
        />
        <PreviewZoomControl
          label="PDF 缩放"
          value={zoom}
          maxPercent={pageSize ? boundedPreviewScale(4, pageSize) * 100 : undefined}
          onChange={(value) => {
            if (value === zoom) return;
            setBusy(true);
            setZoom(value);
          }}
        />
      </PreviewToolbar>
      <section
        ref={container}
        className="za-preview-pdf"
        aria-label="PDF 阅读画布"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: focus scopes page shortcuts to this reading canvas
        tabIndex={0}
        aria-busy={busy}
        onKeyDown={(event) => previewPageKey(event, page, document?.numPages ?? 0, navigatePage)}
      >
        <canvas
          ref={canvas}
          aria-label={`PDF 第 ${page} 页`}
          style={{ visibility: busy ? "hidden" : "visible", display: error ? "none" : undefined }}
        />
        {error ? (
          <PreviewUnavailable message={error} onDownload={onDownload} onRetry={onRetry} />
        ) : busy ? (
          <div className="za-preview-rendering">
            <PreviewLoading
              message={document ? `正在渲染第 ${page} 页…` : "正在读取 PDF…"}
              onCancel={onCancel}
            />
          </div>
        ) : null}
      </section>
    </>
  );
}
