import { lazy, Suspense, useContext, useEffect, useRef, useState } from "react";
import WrapText from "~icons/lucide/wrap-text";
import { lockMonacoNlsLocale, preparePreferredMonacoNlsLocale } from "../../lib/monacoNls";
import { copyTextToClipboard } from "../../lib/shared/clipboard";
import { COPY_FEEDBACK_DURATION, useCopyFeedback } from "../../lib/shared/useCopyFeedback";
import { resolveSourceLanguage, sourceLanguages } from "../../lib/sourceLanguages";
import { Check, ChevronDown, Copy, FileText, MoreHorizontal } from "../IconSet";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TooltipButton } from "../ui/tooltip-button";
import { PreviewIdentityContext } from "./PreviewChrome";
import { PreviewLoading, type PreviewRecovery, PreviewUnavailable } from "./PreviewFeedback";
import { PreviewLeadingTools, PreviewToolbar } from "./PreviewToolbar";
import { resourceText } from "./previewPolicy";
import { usePreviewReadingState } from "./readingSession";
import { SourceLanguagePicker } from "./SourceLanguagePicker";
import "./resource-source-preview.css";

const SourceEditor = lazy(async () => {
  await preparePreferredMonacoNlsLocale();
  const module = await import("./ResourceSourceEditor");
  lockMonacoNlsLocale();
  return module;
});

/** Verified original text only. This viewer never reads a path or executes its contents. */
export default function ResourceSourcePreview(
  props: PreviewRecovery & {
    bytes?: Uint8Array;
    text?: string;
    assertCurrent: () => void;
    onPreview?: () => void;
    onCancel?: () => void;
  },
) {
  const identity = useContext(PreviewIdentityContext);
  const [wrap, setWrap] = usePreviewReadingState("sourceWrap", false);
  const [zoom, setZoom] = usePreviewReadingState("sourceZoom", 100);
  const [languageOverride, setLanguageOverride] = usePreviewReadingState("sourceLanguage", "");
  const [languagePicker, setLanguagePicker] = useState(false);
  const [feedback, setFeedback] = useState("");
  const { copied, showCopied, resetCopied } = useCopyFeedback(
    false,
    COPY_FEEDBACK_DURATION.tooltip,
    () => setFeedback(""),
  );
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  let text: string;
  try {
    text = props.text ?? resourceText(props.bytes ?? new Uint8Array());
  } catch {
    return (
      <PreviewUnavailable
        message="此文件不是可预览的 UTF-8 文本，或超过文本预览范围。"
        onDownload={props.onDownload}
      />
    );
  }
  const copy = async (value: string) => {
    try {
      props.assertCurrent();
      const success = await copyTextToClipboard(value);
      props.assertCurrent();
      if (!success) throw new Error("copy failed");
      if (alive.current) {
        showCopied(true);
        setFeedback("已复制");
      }
    } catch {
      if (alive.current) {
        resetCopied();
        setFeedback("未能复制，请重试。");
      }
    }
  };
  const copyItem = (label: string, value: string) => (
    <DropdownMenuItem onClick={() => void copy(value)}>
      <Copy className="size-4" />
      {label}
    </DropdownMenuItem>
  );
  const language = languageOverride || resolveSourceLanguage(identity.name, identity.mime, text);
  const languageName = sourceLanguages.find((item) => item.id === language)?.name ?? "纯文本";
  return (
    <div className="za-source-preview" data-wrap={wrap}>
      {props.onPreview ? (
        <PreviewLeadingTools>
          <SourceViewControl source onChange={props.onPreview} />
        </PreviewLeadingTools>
      ) : null}
      <PreviewToolbar label="原文阅读" placement="options">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <TooltipButton
                variant="ghost"
                size="icon-sm"
                className="za-source-menu-trigger"
                tooltip={copied ? "已复制" : "原文选项"}
                aria-label="原文选项"
              />
            }
          >
            {copied ? <Check className="size-4" /> : <MoreHorizontal className="size-4" />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="za-source-options">
            {identity.sourcePaths?.path ? copyItem("复制路径", identity.sourcePaths.path) : null}
            {identity.sourcePaths?.relativePath
              ? copyItem("复制相对路径", identity.sourcePaths.relativePath)
              : null}
            {copyItem("复制文件内容", text)}
            <DropdownMenuCheckboxItem checked={wrap} onCheckedChange={setWrap} closeOnClick>
              <WrapText className="size-4" />
              自动换行
            </DropdownMenuCheckboxItem>
            <DropdownMenuItem onClick={() => setLanguagePicker(true)}>
              <FileText className="size-4" />
              代码语言<span className="ml-auto text-muted-foreground">{languageName}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                文本缩放<span className="ml-auto text-muted-foreground">{Math.round(zoom)}%</span>
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
          </DropdownMenuContent>
        </DropdownMenu>
      </PreviewToolbar>
      {text.trim() ? (
        <Suspense fallback={<PreviewLoading onCancel={props.onCancel} />}>
          <SourceEditor
            text={text}
            name={identity.name}
            language={language}
            wrap={wrap}
            zoom={zoom}
            onZoom={setZoom}
            assertCurrent={props.assertCurrent}
          />
        </Suspense>
      ) : (
        <PreviewUnavailable message="此文件暂无可显示的内容。" onDownload={props.onDownload} />
      )}
      <span className="za-source-feedback" role="status">
        {feedback}
      </span>
      <SourceLanguagePicker
        open={languagePicker}
        value={languageOverride}
        onChange={setLanguageOverride}
        onOpenChange={setLanguagePicker}
      />
    </div>
  );
}

export function SourceViewControl({ source, onChange }: { source: boolean; onChange: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button type="button" className="za-source-view-trigger" aria-label="阅读视图" />}
      >
        <FileText className="size-4" />
        <span>{source ? "原文" : "正文"}</span>
        <ChevronDown className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="za-source-options">
        <DropdownMenuRadioGroup
          value={source ? "source" : "preview"}
          onValueChange={(next) => {
            if ((next === "source") !== source) onChange();
          }}
        >
          <DropdownMenuRadioItem value="preview" closeOnClick>
            正文预览
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="source" closeOnClick>
            原文
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
