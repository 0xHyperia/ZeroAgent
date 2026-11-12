import {
  type ComponentProps,
  type CSSProperties,
  isValidElement,
  memo,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CodeBlock, type Components, Streamdown } from "streamdown";
import WrapText from "~icons/lucide/wrap-text";
import { useLocale } from "../../i18n";
import { throttledCodePlugin } from "../../lib/markdownCodeHighlight";
import { copyTextToClipboard } from "../../lib/shared/clipboard";
import { COPY_FEEDBACK_DURATION, useCopyFeedback } from "../../lib/shared/useCopyFeedback";
import { DEFAULT_MARKDOWN_CODE_LANGUAGE, MARKDOWN_CODE_THEMES } from "../../lib/syntaxHighlighter";
import { Check, ChevronRight, Copy, FileText } from "../IconSet";
import { MarkdownMermaidBlock } from "../markdown/MarkdownMermaidBlock";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../ui/dropdown-menu";
import { TooltipButton } from "../ui/tooltip-button";
import { MarkdownSelectionToolbar } from "./MarkdownSelectionToolbar";
import { PreviewIdentityContext, PreviewToolbarMount } from "./PreviewChrome";
import { type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewScrollArea } from "./PreviewScrollArea";
import { PreviewLeadingTools } from "./PreviewToolbar";
import { resourceText } from "./previewPolicy";
import ResourceSourcePreview, { SourceViewControl } from "./ResourceSourcePreview";
import { bindReaderZoom } from "./readerZoom";
import {
  type MarkdownReadingPosition,
  usePreviewReadingSnapshot,
  usePreviewReadingState,
} from "./readingSession";
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
  const identity = useContext(PreviewIdentityContext);
  const chrome = useContext(PreviewToolbarMount);
  const workspaceTab = chrome?.workspaceTab;
  const selectionActions = identity.markdownSelectionActions;
  const { locale } = useLocale();
  const [view, setView] = usePreviewReadingState(
    "textView",
    identity.sourceRange ? "source" : "preview",
  );
  const source = !workspaceTab && view === "source";
  const fromLine = identity.sourceRange?.fromLine;
  const toLine = identity.sourceRange?.toLine;
  const sourceLink = fromLine === undefined ? "" : `${fromLine}:${toLine ?? fromLine}`;
  useEffect(() => {
    if (sourceLink && !workspaceTab) setView("source");
  }, [sourceLink, setView, workspaceTab]);
  const viewport = useRef<HTMLDivElement>(null);
  const selectionRoot = useRef<HTMLDivElement>(null);
  const position = usePreviewReadingSnapshot("markdownPosition");
  const lastPosition = useRef<MarkdownReadingPosition | undefined>(undefined);
  const [zoom, setZoom] = usePreviewReadingState("textZoom", 100);
  const latest = useRef(zoom);
  latest.current = zoom;
  const setFileMenu = chrome?.setFileMenu;
  useLayoutEffect(() => {
    const scroll = viewport.current;
    const blocks = scroll?.querySelector(".za-markdown-blocks")?.children;
    if (source || !scroll || !blocks) return;

    const blockTop = (block: Element, origin: number) => block.getBoundingClientRect().top - origin;
    const blockEnd = (index: number, origin: number) => {
      const next = blocks.item(index + 1);
      return next ? blockTop(next, origin) : scroll.scrollHeight;
    };
    const saved = lastPosition.current ?? position.read();
    if (saved) {
      const block = blocks.item(saved.block);
      const origin = scroll.getBoundingClientRect().top - scroll.scrollTop;
      const top = block ? blockTop(block, origin) : saved.top;
      scroll.scrollTop = block ? top + (blockEnd(saved.block, origin) - top) * saved.progress : top;
      lastPosition.current = saved;
    }

    const remember = () => {
      if (!scroll.clientHeight) return;
      const top = scroll.scrollTop;
      const origin = scroll.getBoundingClientRect().top - top;
      // Static Markdown's top-level blocks follow document order, including tables and code blocks.
      let start = 0;
      let end = blocks.length;
      while (start < end) {
        const middle = Math.floor((start + end) / 2);
        if (blockTop(blocks[middle], origin) <= top) start = middle + 1;
        else end = middle;
      }
      const index = start - 1;
      const block = blocks.item(index);
      if (!block || top <= 0) {
        lastPosition.current = { block: -1, progress: 0, top };
        return;
      }
      const beginning = blockTop(block, origin);
      const progress = (top - beginning) / Math.max(1, blockEnd(index, origin) - beginning);
      lastPosition.current = { block: index, progress: Math.min(1, progress), top };
    };
    scroll.addEventListener("scroll", remember, { passive: true });
    return () => {
      scroll.removeEventListener("scroll", remember);
      // Closing or hiding the canvas may already have changed its layout during this commit.
      if (lastPosition.current) position.write(lastPosition.current);
    };
  }, [source, position]);
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
    if (!setFileMenu || workspaceTab) return;
    setFileMenu(
      <>
        <DropdownMenuItem onClick={() => setView(source ? "preview" : "source")}>
          <FileText className="size-4" />
          {source ? "正文预览" : "查看原文"}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {!source ? (
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
        ) : null}
        <DropdownMenuSeparator />
      </>,
    );
    return () => setFileMenu(null);
  }, [setFileMenu, zoom, setZoom, source, setView, workspaceTab]);
  return (
    <div className="za-markdown-views">
      {!workspaceTab && !source ? (
        <PreviewLeadingTools>
          <SourceViewControl source={false} onChange={() => setView("source")} />
        </PreviewLeadingTools>
      ) : null}
      <div className="za-markdown-rendered" hidden={source} inert={source}>
        <PreviewScrollArea
          ref={viewport}
          className="za-markdown-reading-scroll"
          tabIndex={0}
          aria-label="Markdown 文档正文"
        >
          <div
            ref={selectionRoot}
            className="za-markdown-column"
            data-quote-source={selectionActions ? "markdown" : undefined}
            style={{ "--za-markdown-zoom": zoom / 100 } as CSSProperties}
          >
            {workspaceTab && (
              <div className="za-workspace-markdown-actions">
                <MarkdownCopy
                  label={locale === "zh-CN" ? "复制 Markdown" : "Copy Markdown"}
                  value={() => text}
                  assertCurrent={assertCurrent}
                />
              </div>
            )}
            <MarkdownBody
              text={text}
              assertCurrent={assertCurrent}
              sourcePositions={!!selectionActions}
            />
          </div>
          {selectionActions && (
            <MarkdownSelectionToolbar
              root={selectionRoot}
              source={text}
              actions={selectionActions}
            />
          )}
        </PreviewScrollArea>
      </div>
      {source ? (
        <ResourceSourcePreview
          text={text}
          assertCurrent={assertCurrent}
          onPreview={() => setView("preview")}
        />
      ) : null}
    </div>
  );
}

const MarkdownBody = memo(function MarkdownBody({
  text,
  thumbnail = false,
  assertCurrent,
  sourcePositions = false,
}: {
  text: string;
  thumbnail?: boolean;
  assertCurrent?: () => void;
  sourcePositions?: boolean;
}) {
  const components = useMemo<Components>(
    () => ({
      ...(sourcePositions
        ? {
            p: sourcePositionBlock("p"),
            h1: sourcePositionBlock("h1"),
            h2: sourcePositionBlock("h2"),
            h3: sourcePositionBlock("h3"),
            h4: sourcePositionBlock("h4"),
            h5: sourcePositionBlock("h5"),
            h6: sourcePositionBlock("h6"),
          }
        : {}),
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
        const language =
          child?.props.className?.match(/language-([^\s]+)/)?.[1]?.toLowerCase() ?? "";
        if (language === "mermaid" || language === "mmd") {
          return (
            <MarkdownMermaidBlock
              chart={code}
              readOnly={thumbnail}
              allowEdit={false}
              assertCurrent={assertCurrent}
            />
          );
        }
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
    [thumbnail, assertCurrent, sourcePositions],
  );
  return (
    <article className="za-preview-markdown za-markdown-content">
      <Streamdown
        mode="static"
        className="za-markdown-blocks"
        skipHtml
        allowedElements={allowedElements}
        components={components}
        controls={false}
        lineNumbers={false}
        shikiTheme={[...MARKDOWN_CODE_THEMES]}
        plugins={!thumbnail && throttledCodePlugin ? { code: throttledCodePlugin } : undefined}
      >
        {text}
      </Streamdown>
    </article>
  );
});

function sourcePositionBlock(Tag: "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  return function SourcePositionBlock({
    node,
    ...props
  }: ComponentProps<"p"> & {
    node?: { position?: { start: { offset?: number }; end: { offset?: number } } };
  }) {
    return (
      <Tag
        {...props}
        data-markdown-source-start={node?.position?.start.offset}
        data-markdown-source-end={node?.position?.end.offset}
      />
    );
  };
}

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
    <div className="za-markdown-code" data-wrapped={wrapped} data-language={language || "text"}>
      {plain ? (
        <div className="za-markdown-code-plain">
          <div className="za-markdown-code-heading">{language === "text" ? "" : language}</div>
          {tools}
          <pre>
            <code>{code}</code>
          </pre>
        </div>
      ) : (
        <CodeBlock
          code={code}
          language={language || DEFAULT_MARKDOWN_CODE_LANGUAGE}
          lineNumbers={false}
        >
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
