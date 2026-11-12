import { Globe } from "@liveagent/ui/components/IconSet";
import { getWorkspacePreviewKind } from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import { useLocale } from "@liveagent/ui/i18n/index";
import { resolveSourceLanguage, sourceLanguages } from "@liveagent/ui/lib/sourceLanguages";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

export type WorkspaceTabPreview =
  | {
      kind: "file";
      path: string;
      text?: string;
      imageUrl?: string;
      sizeBytes?: number;
      dirty?: boolean;
    }
  | { kind: "browser"; url: string }
  | { kind: "summary"; subtitle?: string };

type Preview = {
  id: string;
  anchor: HTMLElement;
  keyboard: boolean;
  label: string;
  data: WorkspaceTabPreview;
};

export function useWorkspaceTabHoverPreview() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const shown = useRef<Preview | null>(null);
  const pending = useRef<{ anchor: HTMLElement; timeout: number } | null>(null);
  const suppressed = useRef<HTMLElement | null>(null);

  const clearPending = useCallback(() => {
    if (pending.current) window.clearTimeout(pending.current.timeout);
    pending.current = null;
  }, []);
  const dismiss = useCallback(() => {
    clearPending();
    if (!shown.current) return;
    shown.current = null;
    setPreview(null);
  }, [clearPending]);
  const suppress = (anchor: HTMLElement) => {
    suppressed.current = anchor;
    dismiss();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss();
    };
    window.addEventListener("blur", dismiss);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", dismiss, true);
    return () => {
      clearPending();
      window.removeEventListener("blur", dismiss);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", dismiss, true);
    };
  }, [clearPending, dismiss]);

  return {
    preview,
    dismiss,
    suppress,
    enter(
      anchor: HTMLElement,
      id: string,
      label: string,
      read: () => WorkspaceTabPreview | undefined,
      active: boolean,
      keyboard: boolean,
    ) {
      if (
        suppressed.current === anchor ||
        shown.current?.anchor === anchor ||
        (pending.current?.anchor === anchor && !keyboard)
      )
        return;
      clearPending();
      if (active && !shown.current) return;
      const show = () => {
        pending.current = null;
        if (!anchor.isConnected || anchor.closest("[inert]")) return dismiss();
        const data = read();
        if (!data) return dismiss();
        const next = { anchor, id, label, data, keyboard };
        shown.current = next;
        setPreview(next);
      };
      if (keyboard || shown.current) show();
      else pending.current = { anchor, timeout: window.setTimeout(show, 250) };
    },
    leave(anchor: HTMLElement, relatedTarget: EventTarget | null) {
      if (suppressed.current === anchor) suppressed.current = null;
      if (pending.current?.anchor === anchor) clearPending();
      if (shown.current?.anchor !== anchor) return;
      if (
        relatedTarget instanceof Element &&
        relatedTarget.closest(".za-workspace-tab-track") ===
          anchor.closest(".za-workspace-tab-track")
      )
        return;
      dismiss();
    },
  };
}

function markdownOutline(text: string) {
  const headings: string[] = [];
  let fence: string | undefined;
  for (const line of text.slice(0, 65_536).split(/\r\n|\r|\n/)) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (
        fence[0] === delimiter[1][0] &&
        fence.length <= delimiter[1].length &&
        !delimiter[2].trim()
      )
        fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}(#{1,6})[\t ]+(.+?)\s*$/.exec(line);
    if (!heading) continue;
    headings.push(
      "  ".repeat(heading[1].length - 1) + heading[2].replace(/[\t ]+#+$/, "").slice(0, 160),
    );
    if (headings.length === 8) break;
  }
  return headings.join("\n");
}

function PreviewBody({ data }: { data: WorkspaceTabPreview }) {
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  if (data.kind === "browser") {
    return (
      <div className="za-tab-hover-browser">
        {!data.url && <Globe className="size-5" />}
        {data.url ? copy("网页预览不可用", "Tab preview unavailable") : copy("新标签页", "New tab")}
      </div>
    );
  }
  if (data.kind === "summary") return null;
  const kind = getWorkspacePreviewKind(data.path);
  if (kind === "image" && data.imageUrl)
    return <img className="za-tab-hover-image" src={data.imageUrl} alt="" />;
  const size =
    data.sizeBytes == null
      ? ""
      : new Intl.NumberFormat(locale, {
          style: "unit",
          unit:
            data.sizeBytes < 1024 ? "byte" : data.sizeBytes < 1024 ** 2 ? "kilobyte" : "megabyte",
          maximumFractionDigits: 1,
        }).format(
          data.sizeBytes /
            (data.sizeBytes < 1024 ? 1 : data.sizeBytes < 1024 ** 2 ? 1024 : 1024 ** 2),
        );
  if (data.text !== undefined && (!kind || ["text", "markdown", "html"].includes(kind))) {
    const languageId = resolveSourceLanguage(data.path);
    const language = sourceLanguages.find(({ id }) => id === languageId)?.name;
    const outline = kind === "markdown" ? markdownOutline(data.text) : "";
    const count = data.text.length <= 65_536 ? data.text.split(/\r\n|\r|\n/).length : undefined;
    const formattedCount = count === undefined ? "" : new Intl.NumberFormat(locale).format(count);
    return (
      <>
        <div className="za-tab-hover-meta">
          {[
            language,
            formattedCount &&
              copy(`${formattedCount} 行`, `${formattedCount} ${count === 1 ? "line" : "lines"}`),
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
        <div className="za-tab-hover-excerpt" data-code={outline ? undefined : ""}>
          {outline || data.text.slice(0, 600)}
        </div>
      </>
    );
  }
  const formats = {
    archive: copy("压缩包", "Archive"),
    audio: copy("音频", "Audio"),
    document: copy("文档", "Document"),
    html: "HTML",
    image: copy("图片", "Image"),
    markdown: "Markdown",
    pdf: "PDF",
    presentation: copy("演示文稿", "Slides"),
    spreadsheet: copy("表格", "Spreadsheet"),
    text: copy("文本", "Plain text"),
    video: copy("视频", "Video"),
  };
  return (
    <div className="za-tab-hover-meta">
      {[kind ? formats[kind] : copy("文件", "File"), size].filter(Boolean).join(" · ")}
    </div>
  );
}

export function WorkspaceTabHoverPreview({ preview }: { preview: Preview | null }) {
  const { locale } = useLocale();
  const id = useId();
  const reduceMotion = useReducedMotion();
  const content = useRef<HTMLDivElement>(null);
  const lastAnchor = useRef<HTMLElement | undefined>(undefined);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0, height: 0, moved: false });
  const anchor = preview?.anchor;
  useLayoutEffect(() => {
    const moved = Boolean(anchor && lastAnchor.current && lastAnchor.current !== anchor);
    lastAnchor.current = anchor;
    if (!anchor) return;
    const update = () => {
      const rect = anchor.getBoundingClientRect();
      const width = Math.min(320, Math.max(0, window.innerWidth - 16));
      const start = getComputedStyle(anchor).direction === "rtl" ? rect.right - width : rect.left;
      const left = Math.max(8, Math.min(start, window.innerWidth - width - 8));
      const bottom = rect.bottom + 2;
      const height = Math.min(
        content.current?.offsetHeight ?? 0,
        240,
        Math.max(0, window.innerHeight - 16),
      );
      const preferredTop =
        bottom + height > window.innerHeight - 8 && rect.top - height >= 10
          ? rect.top - height - 2
          : bottom;
      const top = Math.max(8, Math.min(preferredTop, window.innerHeight - height - 8));
      setPosition((previous) =>
        previous.left === left &&
        previous.top === top &&
        previous.width === width &&
        previous.height === height &&
        previous.moved === moved
          ? previous
          : { left, top, width, height, moved },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(anchor);
    if (content.current) observer.observe(content.current);
    window.addEventListener("resize", update);
    document.addEventListener("scroll", update, true);
    const button = anchor.querySelector("[data-workspace-tab-trigger]");
    button?.setAttribute("aria-describedby", id);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", update, true);
      if (button?.getAttribute("aria-describedby") === id)
        button.removeAttribute("aria-describedby");
    };
  }, [anchor, id]);
  const instant = reduceMotion || preview?.keyboard;
  const subtitle =
    preview?.data.kind === "file"
      ? preview.data.path
      : preview?.data.kind === "browser"
        ? preview.data.url
        : preview?.data.subtitle;
  let title: ReactNode = preview?.label;
  if (preview?.data.kind === "file" && preview.data.dirty)
    title = (
      <>
        {title}
        <span className="za-tab-hover-dirty" aria-hidden="true" />
        <span className="sr-only">{locale === "zh-CN" ? "未保存的更改" : "Unsaved changes"}</span>
      </>
    );
  if (!preview) return null;
  return createPortal(
    <motion.div
      id={id}
      role="tooltip"
      data-workspace-tab-preview-card=""
      className="za-tab-hover-preview"
      style={{
        width: position.width,
        left: position.left,
        top: position.top,
        visibility: position.width ? "visible" : "hidden",
      }}
      data-moving={position.moved && !instant ? "" : undefined}
      initial={false}
      animate={{ height: position.height || "auto" }}
      transition={{ duration: instant ? 0 : 0.15, ease: [0.23, 1, 0.32, 1] }}
    >
      <div ref={content} className="relative">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.div
            key={preview.id}
            className="za-tab-hover-frame"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: instant ? 0 : 0.15, ease: [0.23, 1, 0.32, 1] }}
          >
            <div className="za-tab-hover-header">
              <div className="za-tab-hover-title" dir="auto">
                {title}
              </div>
              {subtitle && subtitle !== preview.label && (
                <div className="za-tab-hover-subtitle" dir="auto">
                  {subtitle}
                </div>
              )}
            </div>
            <PreviewBody data={preview.data} />
          </motion.div>
        </AnimatePresence>
      </div>
    </motion.div>,
    document.body,
  );
}
