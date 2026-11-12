import {
  ChevronRight,
  Copy,
  Download,
  Maximize2,
  MoreHorizontal,
  X,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { useEffect, useId, useRef, useState } from "react";
import { parseMermaidViewBox } from "../../lib/mermaidViewBox";
import { copyTextToClipboard } from "../../lib/shared/clipboard";
import { Dialog, DialogClose, DialogContent, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TooltipButton } from "../ui/tooltip-button";
import { MermaidDiagram, useMermaidSvg } from "./MermaidDiagram";
import { mermaidAccents, setMermaidAccent, useMermaidAccent } from "./MermaidTheme";
import "./markdown-mermaid.css";

type DiagramResult = ReturnType<typeof useMermaidSvg>;

function DiagramPlaceholder({ pending = false }: { pending?: boolean }) {
  const { t } = useLocale();
  return (
    <div className="za-mermaid-placeholder" data-waiting={pending || undefined} role="status">
      <span className={pending ? undefined : "sr-only"}>{t("chat.markdown.mermaidLoading")}</span>
    </div>
  );
}

function DiagramResultView({
  chart,
  result,
  fullscreen,
}: {
  chart: string;
  result: DiagramResult;
  fullscreen?: boolean;
}) {
  const { t } = useLocale();
  if (result?.error) {
    return (
      <div className="za-mermaid-error">
        <p role="status">{t("chat.markdown.mermaidError")}</p>
        <pre dir="ltr">
          <code>{chart}</code>
        </pre>
      </div>
    );
  }
  return result?.svg ? (
    <MermaidDiagram svg={result.svg} fullscreen={fullscreen} />
  ) : (
    <DiagramPlaceholder />
  );
}

async function downloadDiagram(svg: string, background: string, assertCurrent?: () => void) {
  await document.fonts?.ready;
  const element = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  const bounds = parseMermaidViewBox(element.getAttribute("viewBox"));
  if (!bounds) throw new Error("Missing diagram bounds");
  const scale = Math.min(
    2,
    8192 / Math.max(bounds.width, bounds.height),
    Math.sqrt(24_000_000 / bounds.width / bounds.height),
  );
  const width = Math.max(1, Math.ceil(bounds.width * scale));
  const height = Math.max(1, Math.ceil(bounds.height * scale));
  element.setAttribute("width", String(width));
  element.setAttribute("height", String(height));
  element.removeAttribute("style");
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(element)], {
      type: "image/svg+xml;charset=utf-8",
    }),
  );
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    context.fillStyle = background;
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!png) throw new Error("PNG unavailable");
    assertCurrent?.();
    const download = URL.createObjectURL(png);
    const link = document.createElement("a");
    link.href = download;
    link.download = "mermaid-diagram.png";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(download), 1000);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function DiagramFullscreen({
  chart,
  id,
  allowEdit,
  startEditing,
  onDownload,
  downloadFailed,
  onClose,
}: {
  chart: string;
  id: string;
  allowEdit: boolean;
  startEditing: boolean;
  onDownload: (svg: string, background: string) => void;
  downloadFailed: boolean;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(chart);
  const [preview, setPreview] = useState(chart);
  const result = useMermaidSvg(preview, id, true);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeLabel = t("chat.imageViewer.exitFullscreen");

  useEffect(() => {
    if (editing) editorRef.current?.focus();
  }, [editing]);

  return (
    <Dialog open disablePointerDismissal onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        ref={dialogRef}
        initialFocus={editing ? editorRef : dialogRef}
        layout="lightbox"
        className="za-mermaid-fullscreen pointer-events-auto flex flex-col"
        data-liveagent-mermaid-fullscreen="true"
      >
        <DialogTitle className="sr-only">{t("chat.markdown.mermaidDiagram")}</DialogTitle>
        <div className="za-mermaid-fullscreen-tools">
          {allowEdit && (
            <button
              type="button"
              className="za-mermaid-mode"
              onClick={() => {
                if (editing) setPreview(draft);
                setEditing(!editing);
              }}
            >
              {t(editing ? "chat.markdown.mermaidViewDiagram" : "chat.markdown.mermaidEditCode")}
            </button>
          )}
          {!editing && result?.svg && (
            <TooltipButton
              variant="ghost"
              size="icon-sm"
              className="za-mermaid-icon"
              aria-label={t("chat.markdown.streamdown.downloadImage")}
              tooltip={t("chat.markdown.streamdown.downloadImage")}
              tooltipSide="bottom"
              onClick={() => result.svg && onDownload(result.svg, result.background)}
            >
              <Download className="size-4" />
            </TooltipButton>
          )}
          <DialogClose
            aria-label={closeLabel}
            render={
              <TooltipButton
                variant="ghost"
                size="icon-sm"
                className="za-mermaid-icon"
                tooltip={closeLabel}
                tooltipSide="bottom"
              />
            }
          >
            <X className="size-4" />
          </DialogClose>
        </div>
        {downloadFailed && (
          <p role="status" className="za-mermaid-feedback text-center">
            {t("chat.markdown.mermaidActionFailed")}
          </p>
        )}
        <div
          className="za-mermaid-fullscreen-stage"
          style={{ backgroundColor: result?.background }}
        >
          {editing ? (
            <textarea
              ref={editorRef}
              className="za-mermaid-editor"
              dir="ltr"
              spellCheck={false}
              value={draft}
              aria-label={t("chat.markdown.mermaidEditCode")}
              onChange={(event) => setDraft(event.target.value)}
            />
          ) : (
            <DiagramResultView chart={preview} result={result} fullscreen />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function MarkdownMermaidBlock({
  chart,
  readOnly = false,
  pending = false,
  allowEdit = !readOnly,
  assertCurrent,
}: {
  chart: string;
  readOnly?: boolean;
  pending?: boolean;
  allowEdit?: boolean;
  assertCurrent?: () => void;
}) {
  const { t } = useLocale();
  const accent = useMermaidAccent();
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const blockRef = useRef<HTMLDivElement>(null);
  const expandRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState<"diagram" | "source" | null>(null);
  const [feedback, setFeedback] = useState<"copied" | "failed">();
  const result = useMermaidSvg(chart, `mermaid-inline-${id}`, !pending && visible);
  const svg = result?.svg;
  useEffect(() => {
    const element = blockRef.current;
    if (!element || visible) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) setVisible(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  async function run(action: () => Promise<boolean> | Promise<void>, success?: "copied") {
    try {
      assertCurrent?.();
      setFeedback(undefined);
      if ((await action()) === false) throw new Error("Diagram action failed");
      setFeedback(success);
    } catch {
      setFeedback("failed");
    }
  }

  function expand(mode: "diagram" | "source") {
    try {
      assertCurrent?.();
      setFeedback(undefined);
      setExpanded(mode);
    } catch {
      setFeedback("failed");
    }
  }

  return (
    <div ref={blockRef} className="za-mermaid-block" data-streamdown="mermaid-block">
      {pending ? (
        <DiagramPlaceholder pending />
      ) : (
        <DiagramResultView chart={chart} result={result} />
      )}
      {!pending && !readOnly && result && (
        <div className="za-mermaid-actions" data-menu-open={menuOpen || undefined}>
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              className="za-mermaid-icon"
              aria-label={t("chat.markdown.mermaidOptions")}
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() => void run(() => copyTextToClipboard(chart), "copied")}
              >
                <Copy className="mr-2 size-4" />
                {t("chat.markdown.mermaidCopySource")}
              </DropdownMenuItem>
              {svg && (
                <DropdownMenuItem
                  onClick={() =>
                    void run(() => downloadDiagram(svg, result.background, assertCurrent))
                  }
                >
                  <Download className="mr-2 size-4" />
                  {t("chat.markdown.streamdown.downloadImage")}
                </DropdownMenuItem>
              )}
              {allowEdit && (
                <DropdownMenuItem onClick={() => expand("source")}>
                  {t("chat.markdown.mermaidEditCode")}
                </DropdownMenuItem>
              )}
              <DropdownMenuSub>
                <DropdownMenuSubTrigger className="justify-between gap-2">
                  {t("chat.markdown.mermaidAccent")}
                  <ChevronRight className="size-4" />
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="min-w-32">
                  <DropdownMenuRadioGroup value={accent} onValueChange={setMermaidAccent}>
                    {mermaidAccents.map((color) => (
                      <DropdownMenuRadioItem key={color} value={color} closeOnClick>
                        {t(`chat.markdown.mermaidAccent.${color}`)}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          <TooltipButton
            ref={expandRef}
            variant="ghost"
            size="icon-sm"
            className="za-mermaid-icon"
            aria-label={t("chat.imageViewer.fullscreen")}
            tooltip={t("chat.imageViewer.fullscreen")}
            onClick={() => expand("diagram")}
          >
            <Maximize2 className="size-4" />
          </TooltipButton>
        </div>
      )}
      {feedback && !expanded && (
        <span role="status" className={feedback === "copied" ? "sr-only" : "za-mermaid-feedback"}>
          {t(feedback === "copied" ? "chat.markdown.copied" : "chat.markdown.mermaidActionFailed")}
        </span>
      )}
      {expanded && (
        <DiagramFullscreen
          chart={chart}
          id={`mermaid-fullscreen-${id}`}
          allowEdit={allowEdit}
          startEditing={expanded === "source"}
          onDownload={(value, background) =>
            void run(() => downloadDiagram(value, background, assertCurrent))
          }
          downloadFailed={feedback === "failed"}
          onClose={() => {
            setExpanded(null);
            requestAnimationFrame(() => expandRef.current?.focus());
          }}
        />
      )}
    </div>
  );
}
