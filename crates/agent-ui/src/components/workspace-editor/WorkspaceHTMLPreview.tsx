import { useEffect, useRef, useState } from "react";
import { useLocale } from "../../i18n";
import { createUuid } from "../../lib/shared/id";
import { invokeFs } from "../../lib/tools/fsBackend";
import { PreviewLoading, PreviewUnavailable } from "../resource-preview/PreviewFeedback";
import { workspaceImageRelativePathForCopy } from "./workspaceImageViewer";
import {
  buildWorkspaceHTMLPreview,
  type WorkspaceHTMLAsset,
  type WorkspaceHTMLLink,
} from "./workspaceHtmlDocument";

export default function WorkspaceHTMLPreview({
  workdir,
  path,
  html,
  assertCurrent,
  onOpenLink,
  onDownload,
}: {
  workdir: string;
  path: string;
  html: string;
  assertCurrent: () => void;
  onOpenLink?: (link: WorkspaceHTMLLink) => void;
  onDownload?: () => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const frame = useRef<HTMLIFrameElement>(null);
  const authority = useRef({ assertCurrent, onOpenLink });
  authority.current = { assertCurrent, onOpenLink };
  const [preview, setPreview] = useState<{
    token: string;
    srcDoc: string;
    links: Map<string, WorkspaceHTMLLink>;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry rebuilds the document with a new bridge token.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const token = createUuid();
    const documentPath = workspaceImageRelativePathForCopy(workdir, path);
    const open = async () => {
      setPreview(null);
      setFailed(false);
      authority.current.assertCurrent();
      const result = await buildWorkspaceHTMLPreview({
        html,
        documentPath: /^(?:[/\\]|[a-z]:)/i.test(documentPath) ? "" : documentPath,
        nonce: token,
        signal,
        loadAsset: async (resourcePath) => {
          signal.throwIfAborted();
          authority.current.assertCurrent();
          if (/^(?:[/\\]|[a-z]:)/i.test(documentPath)) throw new Error("Out of workspace");
          return invokeFs<WorkspaceHTMLAsset>("fs_read_workspace_preview_asset", {
            workdir,
            path: resourcePath,
          });
        },
      });
      signal.throwIfAborted();
      authority.current.assertCurrent();
      setPreview({ ...result, token });
    };
    void open().catch(() => {
      if (!signal.aborted) setFailed(true);
    });
    return () => controller.abort();
  }, [attempt, html, path, workdir]);

  useEffect(() => {
    if (!preview) return;
    const openLink = (event: MessageEvent) => {
      if (event.origin !== "null" || event.source !== frame.current?.contentWindow) return;
      const data = event.data;
      if (
        data?.kind !== "zeroagent-workspace-html-link" ||
        data.token !== preview.token ||
        typeof data.linkId !== "string"
      )
        return;
      const link = preview.links.get(data.linkId);
      if (!link || !authority.current.onOpenLink) return;
      try {
        authority.current.assertCurrent();
        authority.current.onOpenLink(link);
      } catch {
        // The file or view changed while the message was being delivered.
      }
    };
    window.addEventListener("message", openLink);
    return () => window.removeEventListener("message", openLink);
  }, [preview]);

  if (failed)
    return (
      <PreviewUnavailable
        message={zh ? "暂时无法预览此 HTML 文件。" : "This HTML file could not be previewed."}
        onDownload={onDownload}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  if (!preview) return <PreviewLoading message={zh ? "正在排版网页…" : "Rendering HTML…"} />;
  return (
    <iframe
      ref={frame}
      className="block h-full min-h-0 w-full flex-1 border-0 bg-white"
      data-workspace-html-preview=""
      title={path.split(/[/\\]/).at(-1) || "HTML"}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      srcDoc={preview.srcDoc}
    />
  );
}
