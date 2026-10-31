import { useEffect, useState } from "react";
import { createDocxOutline, prepareDocxOutline } from "./docxOutline";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewToolbar } from "./PreviewToolbar";
import { isolatedPreviewDocument } from "./previewPolicy";
import { createResourcePreviewWorker } from "./previewWorkerClient";

export type ResourceDOCXPreviewProps = PreviewRecovery & {
  bytes: Uint8Array;
  name: string;
  assertCurrent: () => void;
  onCancel?: () => void;
};

const OUTLINE_CSS = `
  .za-docx-reader{display:grid;grid-template-columns:176px minmax(0,1fr);align-items:start}
  .za-docx-reader>.docx-wrapper{min-width:0}
  .za-docx-outline{position:sticky;top:20px;max-height:calc(100dvh - 40px);overflow:auto;margin:20px 0 20px 12px;padding:0 8px;color:#555;font:12px/1.65 system-ui,sans-serif}
  .za-docx-outline summary{padding:10px 6px;color:#333;font-weight:600;cursor:pointer;user-select:none}
  .za-docx-outline ol{list-style:none;margin:0;padding:0 0 8px}
  .za-docx-outline li{margin:2px 0}
  .za-docx-outline a{display:block;padding:7px 8px 7px calc(8px + min(var(--outline-level),4)*10px);border-radius:7px;color:inherit;text-decoration:none;overflow-wrap:anywhere}
  .za-docx-outline a:hover{background:#e8e8e4;color:#222}
  .za-docx-outline a:focus-visible{outline:2px solid #647a99;outline-offset:-2px;background:#e8e8e4;color:#222}
  .za-docx-reader :is(p[id],.za-docx-outline-anchor){scroll-margin-top:24px}
  .za-docx-outline-anchor{display:block;height:0}
  @media(max-width:700px){
    .za-docx-reader{display:block}
    .za-docx-outline{position:relative;top:auto;max-height:none;margin:0 12px;padding:0;border-bottom:1px solid #deded9}
    .za-docx-outline nav{max-height:160px;overflow:auto;padding-bottom:4px}
    .za-docx-outline summary{padding:12px 4px}
  }
  @media(pointer:coarse){.za-docx-outline :is(summary,a){min-height:44px;box-sizing:border-box}}
  @media(prefers-reduced-motion:no-preference){html{scroll-behavior:smooth}}
`;

/** Verified bytes become a self-contained read-only document. No iframe DOM
 * access, messages, scripts or same-origin privileges are needed for its TOC. */
export default function ResourceDOCXPreview(props: ResourceDOCXPreviewProps) {
  const { bytes, assertCurrent } = props;
  const [source, setSource] = useState("");
  const [error, setError] = useState("");
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
      const navigation = createDocxOutline(body, outline);
      if (navigation) {
        body.className = "za-docx-reader";
        const styles = window.document.createElement("style");
        styles.textContent = OUTLINE_CSS;
        body.prepend(styles, navigation);
      }
      if (check()) setSource(isolatedPreviewDocument(body.outerHTML, "document"));
    })().catch((cause: unknown) => {
      if (active && !controller.signal.aborted)
        setError(cause instanceof Error ? cause.message : "文档未能预览，请下载原件查看。");
    });
    return () => {
      active = false;
      controller.abort();
      client.dispose();
    };
  }, [bytes, assertCurrent]);
  return (
    <>
      <PreviewToolbar label="Word 文档" detail="只读" />
      {error ? (
        <PreviewUnavailable message={error} onDownload={props.onDownload} onRetry={props.onRetry} />
      ) : source ? (
        <>
          <iframe
            className="za-preview-document"
            sandbox=""
            referrerPolicy="no-referrer"
            title={props.name}
            srcDoc={source}
          />
          <p className="za-preview-caption">字体和复杂排版可能与原件有所不同。</p>
        </>
      ) : (
        <PreviewLoading message="正在排版文档…" onCancel={props.onCancel} />
      )}
    </>
  );
}
