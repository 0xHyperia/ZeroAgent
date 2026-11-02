import {
  type ComponentProps,
  type CSSProperties,
  isValidElement,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CodeBlock, type Components, Streamdown } from "streamdown";
import WrapText from "~icons/lucide/wrap-text";
import { throttledCodePlugin } from "../../lib/markdownCodeHighlight";
import { copyTextToClipboard } from "../../lib/shared/clipboard";
import { COPY_FEEDBACK_DURATION, useCopyFeedback } from "../../lib/shared/useCopyFeedback";
import { Check, ChevronRight, Copy } from "../IconSet";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";
import { TooltipButton } from "../ui/tooltip-button";
import { PreviewToolbarMount } from "./PreviewChrome";
import { type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewScrollArea } from "./PreviewScrollArea";
import { resourceText } from "./previewPolicy";
import { bindReaderZoom } from "./readerZoom";
import { usePreviewReadingState } from "./readingSession";
import { usePreviewViewport } from "./usePreviewViewport";
import "./resource-markdown-preview.css";

const COVER_CHARACTERS = 12_000;
const HIGHLIGHT_CHARACTERS = 16_000;
const allowedElements = [
  "p",
  "br",
  "em",
  "strong",
  "del",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
  "a",
  "img",
  "input",
];

/** One safe document renderer for reading and inert composer covers; hosts retain byte access. */
export default function ResourceMarkdownPreview(
  props: PreviewRecovery & {
    bytes: Uint8Array;
    thumbnail?: boolean;
    assertCurrent: () => void;
  },
) {
  let text: string;
  try {
    text = resourceText(props.bytes);
  } catch {
    return (
      <PreviewUnavailable
        message="此文件不是可预览的 UTF-8 文本，或超过文本预览范围。"
        onDownload={props.onDownload}
      />
    );
  }
  if (!text.trim())
    return <PreviewUnavailable message="此文件暂无可显示的内容。" onDownload={props.onDownload} />;
  if (props.thumbnail) return <MarkdownCover text={text.slice(0, COVER_CHARACTERS)} />;
  return <MarkdownReader text={text} assertCurrent={props.assertCurrent} />;
}

function MarkdownCover({ text }: { text: string }) {
  const { container, viewport } = usePreviewViewport();
  return (
    <div
      ref={container}
      className="za-markdown-cover"
      style={{ "--za-markdown-cover-scale": (viewport.width || 166) / 704 } as CSSProperties}
      aria-hidden="true"
      inert
    >
      <MarkdownBody text={text} thumbnail />
    </div>
  );
}

function MarkdownReader({ text, assertCurrent }: { text: string; assertCurrent: () => void }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = usePreviewReadingState("textZoom", 100);
  const latest = useRef(zoom);
  latest.current = zoom;
  const chrome = useContext(PreviewToolbarMount);
  const setFileMenu = chrome?.setFileMenu;
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    return bindReaderZoom(
      node,
      () => latest.current,
      300,
      (value) => {
        setZoom(typeof value === "number" ? value : 100);
      },
    );
  }, [setZoom]);
  useEffect(() => {
    if (!setFileMenu) return;
    setFileMenu(
      <>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            文本缩放
            <span className="ml-auto text-muted-foreground">{Math.round(zoom)}%</span>
            <ChevronRight className="size-4" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuRadioGroup
              value={String(zoom)}
              onValueChange={(value) => setZoom(Number(value))}
            >
              {[75, 100, 125, 150, 200].map((value) => (
                <DropdownMenuRadioItem key={value} value={String(value)} closeOnClick>
                  {value}%
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
      </>,
    );
    return () => setFileMenu(null);
  }, [setFileMenu, zoom, setZoom]);
  return (
    <PreviewScrollArea
      ref={viewport}
      className="za-markdown-reading-scroll"
      tabIndex={0}
      aria-label="Markdown 文档正文"
    >
      <div
        className="za-markdown-column"
        style={{ "--za-markdown-zoom": zoom / 100 } as CSSProperties}
      >
        <MarkdownBody text={text} assertCurrent={assertCurrent} />
      </div>
    </PreviewScrollArea>
  );
}

const MarkdownBody = memo(function MarkdownBody({
  text,
  thumbnail = false,
  assertCurrent,
}: {
  text: string;
  thumbnail?: boolean;
  assertCurrent?: () => void;
}) {
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children }) =>
        !thumbnail && /^https?:\/\//i.test(href ?? "") ? (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ) : (
          <span>{children}</span>
        ),
      // Do not give an uploaded document ambient network or local-file access.
      img: ({ alt }) => (
        <span className="za-markdown-image-placeholder">
          {alt ? `图像：${alt}` : "外链图像未自动加载"}
        </span>
      ),
      input: ({ checked }) => (
        <input type="checkbox" checked={checked} readOnly disabled tabIndex={-1} />
      ),
      pre: ({ children }) => {
        const child = isValidElement<ComponentProps<"code">>(children) ? children : null;
        const code = child ? codeText(child.props.children).replace(/\n$/, "") : codeText(children);
        const language = child?.props.className?.match(/language-([^\s]+)/)?.[1] ?? "text";
        return (
          <MarkdownCode
            code={code}
            language={language}
            thumbnail={thumbnail}
            assertCurrent={assertCurrent}
          />
        );
      },
      table: ({ children }) => (
        <MarkdownTable thumbnail={thumbnail} assertCurrent={assertCurrent}>
          {children}
        </MarkdownTable>
      ),
    }),
    [thumbnail, assertCurrent],
  );
  return (
    <article className="za-preview-markdown za-markdown-content">
      <Streamdown
        mode="static"
        skipHtml
        allowedElements={allowedElements}
        components={components}
        controls={false}
        lineNumbers={false}
        shikiTheme={["github-light", "github-dark"]}
        plugins={!thumbnail && throttledCodePlugin ? { code: throttledCodePlugin } : undefined}
      >
        {text}
      </Streamdown>
    </article>
  );
});

function codeText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(codeText).join("");
  return "";
}

function MarkdownCode({
  code,
  language,
  thumbnail,
  assertCurrent,
}: {
  code: string;
  language: string;
  thumbnail: boolean;
  assertCurrent?: () => void;
}) {
  const [wrapped, setWrapped] = useState(false);
  const plain = thumbnail || code.length > HIGHLIGHT_CHARACTERS;
  const tools = !thumbnail ? (
    <div className="za-markdown-code-actions">
      <TooltipButton
        variant="ghost"
        size="icon-sm"
        className="za-markdown-action"
        tooltip={wrapped ? "关闭自动换行" : "启用自动换行"}
        aria-label={wrapped ? "关闭自动换行" : "启用自动换行"}
        aria-pressed={wrapped}
        onClick={() => setWrapped((value) => !value)}
      >
        <WrapText className="size-4" />
      </TooltipButton>
      <MarkdownCopy label="复制代码" value={() => code} assertCurrent={assertCurrent} />
    </div>
  ) : null;
  return (
    <div className="za-markdown-code" data-wrapped={wrapped} data-language={language}>
      {plain ? (
        <div className="za-markdown-code-plain">
          <div className="za-markdown-code-heading">{language === "text" ? "" : language}</div>
          {tools}
          <pre>
            <code>{code}</code>
          </pre>
        </div>
      ) : (
        <CodeBlock code={code} language={language} lineNumbers={false}>
          {tools}
        </CodeBlock>
      )}
    </div>
  );
}

function MarkdownTable({
  children,
  thumbnail,
  assertCurrent,
}: {
  children: ReactNode;
  thumbnail: boolean;
  assertCurrent?: () => void;
}) {
  const table = useRef<HTMLTableElement>(null);
  const value = () =>
    Array.from(table.current?.rows ?? [])
      .map((row) =>
        Array.from(row.cells)
          .map((cell) => {
            const text = cell.textContent?.trim() ?? "";
            return /[\t\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
          })
          .join("\t"),
      )
      .join("\n");
  return (
    <div className="za-markdown-table">
      {!thumbnail ? (
        <div className="za-markdown-table-actions">
          <MarkdownCopy label="复制表格" value={value} assertCurrent={assertCurrent} />
        </div>
      ) : null}
      <div className="za-markdown-table-scroll">
        <table ref={table}>{children}</table>
      </div>
    </div>
  );
}

function MarkdownCopy({
  label,
  value,
  assertCurrent,
}: {
  label: string;
  value: () => string;
  assertCurrent?: () => void;
}) {
  const [error, setError] = useState(false);
  const { copied, showCopied } = useCopyFeedback(false, COPY_FEEDBACK_DURATION.tooltip);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const copy = async () => {
    try {
      assertCurrent?.();
      const success = await copyTextToClipboard(value());
      assertCurrent?.();
      if (!active.current) return;
      setError(!success);
      if (success) showCopied(true);
    } catch {
      if (active.current) setError(true);
    }
  };
  const status = error ? "复制失败，请重试" : copied ? "已复制" : label;
  return (
    <>
      <TooltipButton
        variant="ghost"
        size="icon-sm"
        className="za-markdown-action"
        aria-label={status}
        tooltip={status}
        onClick={() => void copy()}
      >
        {copied && !error ? <Check className="size-4" /> : <Copy className="size-4" />}
      </TooltipButton>
      <span className="sr-only" role="status">
        {error || copied ? status : ""}
      </span>
    </>
  );
}
