import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
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
import { cloudChatProcessResources, cloudChatProcessText } from "@/lib/cloudChatTranscript";

type Props = {
  message?: CloudChatMessage;
  error?: string;
  onRetry: () => void;
  onClose: () => void;
  onOpenFile: (id: string) => void;
  onOpenArtifact: (id: string) => void;
  onOpenFileLink?: (link: ChatFileLink) => void;
  captureGuard: () => () => void;
};

export function CloudChatMessageReader({
  message,
  error,
  onRetry,
  onClose,
  onOpenFile,
  onOpenArtifact,
  onOpenFileLink,
  captureGuard,
}: Props) {
  const [page, setPage] = useState(0);
  const [section, setSection] = useState<"body" | "process" | "resources">("body");
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [downloadHash, setDownloadHash] = useState("");
  const [copied, setCopied] = useState(false);
  const generation = useRef(0);
  const fullText = useMemo(
    () =>
      section === "process"
        ? cloudChatProcessText(message?.presentation)
        : cloudMessageText(message?.content),
    [message, section],
  );
  const hasProcess = Boolean(message?.presentation?.blocks.some((block) => block.type !== "text"));
  const resources = useMemo(
    () => (onOpenFileLink ? cloudChatProcessResources(message?.presentation) : []),
    [message, onOpenFileLink],
  );
  const contentLabel =
    section === "resources" ? "关联资料" : section === "process" ? "工作过程" : "正文";
  const excerpt = useMemo(
    () =>
      section === "resources"
        ? {
            text: "",
            page: Math.min(page, Math.max(0, Math.ceil(resources.length / 20) - 1)),
            pages: Math.max(1, Math.ceil(resources.length / 20)),
          }
        : cloudMessageTextPage(fullText, page),
    [fullText, page, section, resources.length],
  );
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
      anchor.download = section === "process" ? "消息完整工作过程.txt" : "消息完整正文.txt";
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
        <DialogDescription>分段阅读完整消息，可复制或下载原文。</DialogDescription>
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
            {hasProcess || resources.length > 0 ? (
              <div
                className="flex w-fit rounded-full bg-muted/70 p-1"
                role="tablist"
                aria-label="消息内容"
              >
                {(
                  [
                    "body",
                    ...(hasProcess ? ["process"] : []),
                    ...(resources.length ? ["resources"] : []),
                  ] as ("body" | "process" | "resources")[]
                ).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="tab"
                    aria-selected={section === value}
                    className={`min-h-9 cursor-pointer rounded-full px-4 text-sm transition-colors ${section === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
                    onClick={() => {
                      generation.current++;
                      setSection(value);
                      setPage(0);
                      setCopied(false);
                      setDownloadHash("");
                      setDownloadError("");
                      setDownloading(false);
                    }}
                  >
                    {value === "body" ? "消息正文" : value === "process" ? "工作过程" : "关联资料"}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span role="status">
                第 {excerpt.page + 1} / {excerpt.pages}{" "}
                {section === "resources" ? `页，共 ${resources.length} 项` : "段"}
                {section === "resources"
                  ? ""
                  : excerpt.pages > 1
                    ? `，当前片段不代表完整${contentLabel}`
                    : `，本段包含完整${contentLabel}`}
                。
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={excerpt.page === 0}
                onClick={() => setPage((current) => Math.max(0, current - 1))}
              >
                {section === "resources" ? "上一页" : "上一段"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={excerpt.page >= excerpt.pages - 1}
                onClick={() => setPage((current) => current + 1)}
              >
                {section === "resources" ? "下一页" : "下一段"}
              </Button>
              {excerpt.pages > 2 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={excerpt.page >= excerpt.pages - 1}
                  onClick={() => setPage(excerpt.pages - 1)}
                >
                  {section === "resources" ? "末页" : "末段"}
                </Button>
              ) : null}
              {section !== "resources" ? (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={downloading}
                    onClick={() => void download()}
                  >
                    {downloading ? "正在准备下载…" : `下载完整${contentLabel}（TXT）`}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!cloudMessageFitsTextBudget(fullText, CLOUD_MESSAGE_CLIPBOARD_BYTES)}
                    title={
                      !cloudMessageFitsTextBudget(fullText, CLOUD_MESSAGE_CLIPBOARD_BYTES)
                        ? "消息较长，请下载完整正文"
                        : undefined
                    }
                    onClick={() => void copy()}
                  >
                    {copied ? `已复制完整${contentLabel}` : `复制完整${contentLabel}`}
                  </Button>
                </>
              ) : null}
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
            <div
              data-message-reader-section={section}
              className="min-h-0 flex-1 overflow-auto overscroll-contain"
            >
              {section === "resources" ? (
                <ul className="space-y-1 rounded-2xl border border-border/50 p-2">
                  {resources.slice(excerpt.page * 20, (excerpt.page + 1) * 20).map((resource) => (
                    <li key={`${resource.kind}:${resource.id}`}>
                      <button
                        type="button"
                        className="flex min-h-11 w-full cursor-pointer items-center justify-between gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => onOpenFileLink?.(resource.link)}
                      >
                        <span className="min-w-0 break-words">{resource.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {resource.role === "source" ? "来源" : "输入资料"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <pre className="whitespace-pre-wrap break-words rounded-2xl bg-muted/25 p-4 font-chat text-sm leading-7 text-foreground/90">
                  {excerpt.text}
                </pre>
              )}
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
        <Button variant="secondary" className="self-end" onClick={onClose}>
          关闭消息原文
        </Button>
      </DialogContent>
    </Dialog>
  );
}
