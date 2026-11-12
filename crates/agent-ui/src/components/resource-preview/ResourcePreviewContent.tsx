import { lazy, Suspense, useEffect, useState } from "react";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewToolbar } from "./PreviewToolbar";
import { previewImageDimensions, previewSVGDimensions } from "./previewImageDimensions";
import { isolatedPreviewDocument, type ResourcePreviewKind, resourceText } from "./previewPolicy";
import { createResourcePreviewWorker } from "./previewWorkerClient";
import type { PreviewWorkerResult } from "./previewWorkerProtocol";
import ResourceImagePreview from "./ResourceImagePreview";
import ResourceMediaPreview from "./ResourceMediaPreview";

const SourcePreview = lazy(() => import("./ResourceSourcePreview"));
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
  if (kind === "text")
    return (
      <Suspense fallback={<PreviewLoading onCancel={props.onCancel} />}>
        <SourcePreview
          bytes={bytes}
          assertCurrent={assertCurrent}
          onDownload={props.onDownload}
          onCancel={props.onCancel}
        />
      </Suspense>
    );
  if (["html", "svg"].includes(kind) && source)
    return (
      <Suspense fallback={<PreviewLoading onCancel={props.onCancel} />}>
        <SourcePreview
          bytes={bytes}
          assertCurrent={assertCurrent}
          onDownload={props.onDownload}
          onPreview={() => setSource(false)}
        />
      </Suspense>
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
        onDownload={props.onDownload}
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
