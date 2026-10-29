import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { cloudArtifactReferences } from "@/lib/cloudChatArtifacts";
import { cloudFileReferences } from "@/lib/cloudChatFiles";
import type { CloudChatMessage } from "@/lib/cloudChatHistory";
import {
  CLOUD_MESSAGE_CLIPBOARD_BYTES,
  cloudMessageFitsTextBudget,
  cloudMessageText,
  cloudMessageTextPage,
  copyCloudMessageText,
} from "@/lib/cloudChatMessagePreview";

type Props = {
  message?: CloudChatMessage;
  error?: string;
  onRetry: () => void;
  onClose: () => void;
  onOpenFile: (id: string) => void;
  onOpenArtifact: (id: string) => void;
  captureGuard: () => () => void;
};

export function CloudChatMessageReader({
  message,
  error,
  onRetry,
  onClose,
  onOpenFile,
  onOpenArtifact,
  captureGuard,
}: Props) {
  const [page, setPage] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [downloadHash, setDownloadHash] = useState("");
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const fullText = useMemo(() => cloudMessageText(message?.content), [message]);
  const excerpt = useMemo(() => cloudMessageTextPage(fullText, page), [fullText, page]);
  useEffect(() => {
    return () => {
      generation.current++;
    };
  }, []);

  async function copy() {
    const current = generation.current;
    const guard = captureGuard();
    try {
      await copyCloudMessageText(fullText, guard);
      if (current === generation.current) setCopied(true);
    } catch {
      if (current === generation.current) {
        try {
          guard();
          setDownloadError("无法复制完整正文，请尝试下载完整文本。");
        } catch {
          /* Retired account/view. */
        }
      }
    }
  }

  async function download() {
    if (!message || downloading) return;
    const current = generation.current;
    const guard = captureGuard();
    setDownloading(true);
    setDownloadError("");
    let objectURL: string | undefined;
    try {
      guard();
      const bytes = new TextEncoder().encode(fullText);
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      guard();
      if (current !== generation.current) return;
      const hash = Array.from(new Uint8Array(digest), (part) =>
        part.toString(16).padStart(2, "0"),
      ).join("");
      const blob = new Blob([bytes], { type: "text/plain;charset=utf-8" });
      guard();
      if (current !== generation.current) return;
      objectURL = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectURL;
      anchor.download = "消息完整正文.txt";
      guard();
      if (current !== generation.current) return;
      anchor.click();
      setDownloadHash(hash);
    } catch {
      if (current === generation.current) {
        try {
          guard();
          setDownloadError("完整正文下载失败，请重试。");
        } catch {
          /* Retired account/view. */
        }
      }
    } finally {
      if (objectURL) URL.revokeObjectURL(objectURL);
      if (current === generation.current) setDownloading(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        layout="fullscreen-mobile"
        className="flex max-h-[85dvh] w-full max-w-760px flex-col gap-16px overflow-hidden p-20px"
      >
        <DialogTitle>消息原文</DialogTitle>
        <DialogDescription>
          正文以纯文本分段展示，完整正文可复制或下载为 TXT。超大消息暂不支持直接编辑，可下载后修改。
        </DialogDescription>
        {!message && !error ? <p role="status">正在读取消息正文…</p> : null}
        {error ? (
          <>
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
            <button type="button" onClick={onRetry}>
              重试读取消息
            </button>
          </>
        ) : null}
        {message ? (
          <>
            <div className="flex flex-wrap items-center gap-8px text-xs">
              <span role="status">
                第 {excerpt.page + 1} / {excerpt.pages} 段
                {excerpt.pages > 1 ? "，当前片段不代表完整正文" : "，本段包含完整正文"}。
              </span>
              <button
                type="button"
                disabled={excerpt.page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                上一段
              </button>
              <button
                type="button"
                disabled={excerpt.page >= excerpt.pages - 1}
                onClick={() => setPage((current) => current + 1)}
              >
                下一段
              </button>
              {excerpt.pages > 2 ? (
                <button
                  type="button"
                  disabled={excerpt.page >= excerpt.pages - 1}
                  onClick={() => setPage(excerpt.pages - 1)}
                >
                  末段
                </button>
              ) : null}
              <button type="button" disabled={downloading} onClick={() => void download()}>
                {downloading ? "正在准备下载…" : "下载完整正文（TXT）"}
              </button>
              <button
                type="button"
                disabled={!cloudMessageFitsTextBudget(fullText, CLOUD_MESSAGE_CLIPBOARD_BYTES)}
                title={
                  !cloudMessageFitsTextBudget(fullText, CLOUD_MESSAGE_CLIPBOARD_BYTES)
                    ? "消息较长，请下载完整正文"
                    : undefined
                }
                onClick={() => void copy()}
              >
                {copied ? "已复制完整正文" : "复制完整正文"}
              </button>
            </div>
            {downloadError ? (
              <p role="alert" className="text-sm text-destructive">
                {downloadError}
              </p>
            ) : null}
            {downloadHash ? (
              <p className="break-all text-xs text-muted-foreground">
                完整 TXT 的 SHA-256：{downloadHash}
              </p>
            ) : null}
            <div className="min-h-0 flex-1 overflow-auto">
              <pre className="whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/30 p-12px font-mono text-xs">
                {excerpt.text}
              </pre>
              <div className="mt-12px flex flex-wrap gap-8px">
                {cloudFileReferences(message.content).map((file) => (
                  <button
                    key={file.file_id}
                    type="button"
                    className="rounded-lg border border-border px-10px py-6px text-sm"
                    onClick={() => onOpenFile(file.file_id)}
                  >
                    {file.name || "消息附件"}
                  </button>
                ))}
                {cloudArtifactReferences(message.content).map((version) => (
                  <button
                    key={version.version_id}
                    type="button"
                    className="rounded-lg border border-border px-10px py-6px text-sm"
                    onClick={() => onOpenArtifact(version.version_id)}
                  >
                    {version.name || "消息成果"}
                    {version.number ? ` · v${version.number}` : ""}
                  </button>
                ))}
              </div>
            </div>
          </>
        ) : null}
        <button
          type="button"
          className="self-end rounded-lg border border-border px-12px py-6px text-sm"
          onClick={onClose}
        >
          关闭消息原文
        </button>
      </DialogContent>
    </Dialog>
  );
}
