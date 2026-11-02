import { lazy, Suspense, useEffect, useState } from "react";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewScrollArea } from "./PreviewScrollArea";
import { PreviewToolbar, PreviewZoomControl } from "./PreviewToolbar";
import { previewImageDimensions, previewSVGDimensions } from "./previewImageDimensions";
import { isolatedPreviewDocument, type ResourcePreviewKind, resourceText } from "./previewPolicy";
import { createResourcePreviewWorker } from "./previewWorkerClient";
import type { PreviewWorkerResult } from "./previewWorkerProtocol";
import ResourceImagePreview from "./ResourceImagePreview";
import ResourceMediaPreview from "./ResourceMediaPreview";
import { usePreviewReadingState } from "./readingSession";

const MarkdownPreview = lazy(() => import("./ResourceMarkdownPreview"));
const PDFPreview = lazy(() => import("./ResourcePDFPreview"));
const DOCXPreview = lazy(() => import("./ResourceDOCXPreview"));
const SlidesPreview = lazy(() => import("./ResourceSlidesPreview"));
const SheetPreview = lazy(() => import("./ResourceSheetPreview"));

export default function ResourcePreviewContent(
  props: PreviewRecovery & {
    kind: ResourcePreviewKind;
    thumbnail?: boolean;
    name: string;
    mime: string;
    bytes: Uint8Array;
    assertCurrent: () => void;
    onCancel?: () => void;
  },
) {
  const { kind, bytes, assertCurrent } = props;
  const [url, setURL] = useState("");
  const [document, setDocument] = useState("");
  const [error, setError] = useState("");
  const [data, setData] = useState<PreviewWorkerResult | null>(null);
  const [source, setSource] = useState(false);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const urls = new Set<string>();
    let client: ReturnType<typeof createResourcePreviewWorker> | null = null;
    let active = true;
    const check = () => {
      assertCurrent();
      return active && !controller.signal.aborted;
    };
    const objectURL = (body: Blob) => {
      const value = URL.createObjectURL(body);
      urls.add(value);
      return value;
    };
    setError("");
    void (async () => {
      if (kind === "archive") {
        client = createResourcePreviewWorker(controller.signal);
        const result = await client.request({
          type: "load",
          kind: "inspect",
          bytes,
        });
        if (!check()) return;
        setData(result);
      } else if (["html", "svg"].includes(kind)) {
        // No scripts or same-origin permission even for a user's own upload.
        const content = resourceText(bytes);
        if (kind === "svg") setDimensions(previewSVGDimensions(content));
        setDocument(isolatedPreviewDocument(content, kind === "svg" ? "image" : undefined));
      } else if (["image", "audio", "video"].includes(kind)) {
        if (kind === "image") setDimensions(previewImageDimensions(bytes, props.mime));
        const value = objectURL(new Blob([bytes.slice().buffer], { type: props.mime }));
        if (check()) setURL(value);
      }
    })().catch((cause: unknown) => {
      if (active && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "文件预览失败，请下载原件。");
    });
    return () => {
      active = false;
      controller.abort();
      client?.dispose();
      for (const value of urls) URL.revokeObjectURL(value);
    };
  }, [kind, bytes, assertCurrent, props.mime]);

  if (error)
    return (
      <PreviewUnavailable message={error} onDownload={props.onDownload} onRetry={props.onRetry} />
    );
  if (kind === "pdf")
    return (
      <Suspense
        fallback={<PreviewLoading message="正在加载 PDF 阅读器…" onCancel={props.onCancel} />}
      >
        <PDFPreview
          bytes={bytes}
          thumbnail={props.thumbnail}
          assertCurrent={assertCurrent}
          onDownload={props.onDownload}
          onRetry={props.onRetry}
          onCancel={props.onCancel}
        />
      </Suspense>
    );
  if (kind === "docx" || kind === "pptx" || kind === "sheet") {
    const Reader = kind === "docx" ? DOCXPreview : kind === "pptx" ? SlidesPreview : SheetPreview;
    return (
      <Suspense fallback={<PreviewLoading onCancel={props.onCancel} />}>
        <Reader
          bytes={bytes}
          name={props.name}
          thumbnail={props.thumbnail}
          assertCurrent={assertCurrent}
          onDownload={props.onDownload}
          onRetry={props.onRetry}
          onCancel={props.onCancel}
        />
      </Suspense>
    );
  }
  if (kind === "markdown")
    return (
      <Suspense fallback={<PreviewLoading onCancel={props.onCancel} />}>
        <MarkdownPreview
          bytes={bytes}
          thumbnail={props.thumbnail}
          assertCurrent={assertCurrent}
          onDownload={props.onDownload}
        />
      </Suspense>
    );
  if (kind === "text") return <TextPreview bytes={bytes} onDownload={props.onDownload} />;
  if (["html", "svg"].includes(kind) && source)
    return (
      <>
        <PreviewToolbar label={kind === "svg" ? "SVG 源码" : "HTML 源码"} detail="只读">
          <Button variant="ghost" size="sm" onClick={() => setSource(false)}>
            返回预览
          </Button>
        </PreviewToolbar>
        <TextPreview bytes={bytes} onDownload={props.onDownload} showToolbar={false} />
      </>
    );
  if (kind === "html")
    return (
      <>
        <PreviewToolbar label="网页文档" detail="只读">
          {
            <Button variant="ghost" size="sm" onClick={() => setSource(true)}>
              查看源码
            </Button>
          }
        </PreviewToolbar>
        {document ? (
          <iframe
            className="za-preview-document"
            sandbox=""
            referrerPolicy="no-referrer"
            title={props.name}
            srcDoc={document}
          />
        ) : (
          <PreviewLoading message="正在排版文档…" onCancel={props.onCancel} />
        )}
      </>
    );
  if (kind === "archive")
    return data?.entries ? (
      <>
        <PreviewToolbar label="压缩包目录" detail={`${data.entries.length} 项`} />
        {data.entries.length ? (
          <ul className="za-preview-archive">
            {data?.entries?.map((entry) => (
              <li key={entry.name}>
                <span>
                  {entry.directory ? "▱" : "·"} {entry.name}
                </span>
                <small>{entry.directory ? "" : `${(entry.size / 1024).toFixed(1)} KB`}</small>
              </li>
            ))}
          </ul>
        ) : (
          <PreviewUnavailable message="压缩包内没有文件。" />
        )}
      </>
    ) : (
      <PreviewLoading message="正在读取压缩包目录…" onCancel={props.onCancel} />
    );
  if (kind === "image" || kind === "svg")
    return dimensions && (url || document) ? (
      <ResourceImagePreview
        key={url || document}
        url={url}
        document={kind === "svg" ? document : undefined}
        name={props.name}
        dimensions={dimensions}
        assertCurrent={assertCurrent}
        onError={setError}
        onCancel={props.onCancel}
        thumbnail={props.thumbnail}
        onViewSource={kind === "svg" ? () => setSource(true) : undefined}
      />
    ) : (
      <PreviewLoading message="正在读取图像…" onCancel={props.onCancel} />
    );
  if (kind === "audio" || kind === "video")
    return url ? (
      <ResourceMediaPreview
        key={url}
        kind={kind}
        url={url}
        name={props.name}
        assertCurrent={assertCurrent}
        onDownload={props.onDownload}
        onRetry={props.onRetry}
        onCancel={props.onCancel}
      />
    ) : (
      <PreviewLoading message="正在读取媒体…" onCancel={props.onCancel} />
    );
  return null;
}

function TextPreview({
  bytes,
  onDownload,
  showToolbar = true,
}: PreviewRecovery & { bytes: Uint8Array; showToolbar?: boolean }) {
  const [zoom, setZoom] = usePreviewReadingState("textZoom", 100);
  const zoomControl = (
    <PreviewZoomControl
      label="文本缩放"
      value={zoom}
      onChange={(value) => setZoom(typeof value === "number" ? value : 100)}
      fitPage={false}
      fitWidth={false}
    />
  );
  let text: string;
  try {
    text = resourceText(bytes);
  } catch {
    return (
      <PreviewUnavailable
        message="此文件不是可预览的 UTF-8 文本，或超过文本预览范围。"
        onDownload={onDownload}
      />
    );
  }
  if (!text.trim())
    return <PreviewUnavailable message="此文件暂无可显示的内容。" onDownload={onDownload} />;
  return (
    <>
      <PreviewToolbar
        label={showToolbar ? "文本" : "文本缩放"}
        detail={`${text.split("\n").length} 行 · 只读`}
      >
        {zoomControl}
      </PreviewToolbar>
      <PreviewScrollArea className="za-preview-text-scroll">
        <pre className="za-preview-text" title="文件内容" style={{ zoom: zoom / 100 }}>
          {text}
        </pre>
      </PreviewScrollArea>
    </>
  );
}
