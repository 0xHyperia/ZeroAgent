import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import {
  resolveQuoteButtonPosition,
  resolveTranscriptQuoteSelection,
  type TranscriptQuoteSelection,
} from "../../lib/chat/transcriptQuote";
import { cn } from "../../lib/shared/utils";
import { ArrowUp, FilePenLine, MessageSquareText, TextQuote } from "../IconSet";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { floatingSurfaceClassName } from "../ui/menu-surface";
import { Textarea } from "../ui/textarea";
import {
  MARKDOWN_EDIT_INSTRUCTION_LIMIT,
  type WorkspaceMarkdownEditRange,
} from "../workspace-editor/workspaceMarkdownSelectionEdit";
import type { MarkdownSelectionActions } from "./PreviewChrome";

export type MarkdownToolbarSelection = TranscriptQuoteSelection & {
  range?: Range;
  position?: { line: number; column: number };
  editRange?: WorkspaceMarkdownEditRange;
};

export type MarkdownEditResume = {
  selection: MarkdownToolbarSelection;
  instruction: string;
  error?: string;
};

function uniqueSourcePosition(source: string, selection: string, range: Range) {
  const blockFor = (node: Node) => {
    const element = node instanceof Element ? node : node.parentElement;
    return element?.closest("[data-markdown-source-start][data-markdown-source-end]");
  };
  const block = blockFor(range.startContainer);
  if (!block || block !== blockFor(range.endContainer)) return null;
  const start = Number(block.getAttribute("data-markdown-source-start"));
  const end = Number(block.getAttribute("data-markdown-source-end"));
  const raw = source.slice(start, end);
  const rendered = block.textContent ?? "";
  // Only jump from a literal paragraph or heading. Markup, link labels and
  // decoded entities don't have reliable text offsets in the source.
  const local = raw.indexOf(rendered);
  if (!rendered || local < 0 || raw.indexOf(rendered, local + 1) !== -1) return null;
  const match = rendered.indexOf(selection);
  if (match < 0 || rendered.indexOf(selection, match + 1) !== -1) return null;
  const offset = start + local + match;
  const precedingLines = source.slice(0, offset).split(/\r\n?|\n/);
  return {
    line: precedingLines.length,
    column: (precedingLines.at(-1)?.length ?? 0) + 1,
  };
}

export function MarkdownSelectionToolbar({
  root,
  source,
  actions,
  resolveSelection,
  onRequestEdit,
  resumeEdit,
}: {
  root: RefObject<HTMLElement | null>;
  source: string;
  actions: MarkdownSelectionActions;
  resolveSelection?: () => MarkdownToolbarSelection | null;
  onRequestEdit?: (selection: MarkdownToolbarSelection, instruction: string) => void;
  resumeEdit?: MarkdownEditResume;
}) {
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const [selection, setSelection] = useState<MarkdownToolbarSelection | null>(null);
  const resolve = useRef(resolveSelection);
  resolve.current = resolveSelection;
  const [comment, setComment] = useState<string | null>(null);
  const [instruction, setInstruction] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | undefined>();
  const toolbar = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const commenting = comment !== null;
  const editing = instruction !== null;
  const hasForm = commenting || editing;
  const close = useCallback(() => {
    setSelection(null);
    setComment(null);
    setInstruction(null);
    setEditError(undefined);
  }, []);
  useLayoutEffect(() => {
    if (!resumeEdit) return;
    setSelection(resumeEdit.selection);
    setInstruction(resumeEdit.instruction);
    setEditError(resumeEdit.error);
  }, [resumeEdit]);

  useEffect(() => {
    const contains = (event: Event) =>
      event.target instanceof Node && toolbar.current?.contains(event.target);
    const inspect = () => {
      if (hasForm) return;
      if (resolve.current) {
        setSelection(resolve.current());
        return;
      }
      const current = window.getSelection();
      const resolved = resolveTranscriptQuoteSelection(root.current, current);
      setSelection(
        resolved && current ? { ...resolved, range: current.getRangeAt(0).cloneRange() } : null,
      );
    };
    const away = (event: Event) => {
      if (!contains(event)) close();
    };
    const dismiss = (event: KeyboardEvent) => {
      if (!toolbar.current || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (editing) {
        setInstruction(null);
        setEditError(undefined);
      } else close();
    };
    const keyboardSelection = (event: KeyboardEvent) => {
      if (
        event.shiftKey ||
        event.key === "Shift" ||
        ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a")
      )
        inspect();
    };
    const pointerSelection = (event: PointerEvent) => {
      if (!contains(event)) inspect();
    };
    const selectionChanged = () => {
      if (!hasForm && window.getSelection()?.isCollapsed) setSelection(null);
    };
    document.addEventListener("pointerup", pointerSelection);
    document.addEventListener("keyup", keyboardSelection);
    document.addEventListener("keydown", dismiss, true);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("selectionchange", selectionChanged);
    document.addEventListener("scroll", away, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerup", pointerSelection);
      document.removeEventListener("keyup", keyboardSelection);
      document.removeEventListener("keydown", dismiss, true);
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("selectionchange", selectionChanged);
      document.removeEventListener("scroll", away, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [close, editing, hasForm, root]);

  useLayoutEffect(() => {
    const node = toolbar.current;
    if (!node || !selection) return;
    const { width, height } = node.getBoundingClientRect();
    const { left, top } = resolveQuoteButtonPosition(
      selection.rect,
      { width, height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(top)}px`;
    if (commenting) editor.current?.focus({ preventScroll: true });
    if (editing) editInput.current?.focus({ preventScroll: true });
  }, [commenting, editing, selection]);

  if (!selection) return null;
  const canEditSelection = Boolean(onRequestEdit && selection.editRange);
  const position = actions.onEditSource
    ? (selection.position ??
      (selection.range ? uniqueSourcePosition(source, selection.text, selection.range) : null))
    : null;
  const add = (note?: string) => {
    if (!actions.onAddToChat(selection.text, note)) return;
    window.getSelection()?.removeAllRanges();
    close();
  };
  return createPortal(
    <div
      ref={toolbar}
      data-markdown-selection-toolbar=""
      className={cn(
        "layer-popover fixed flex max-w-[calc(100vw-16px)] select-none items-center gap-0.5 p-1 shadow-md",
        floatingSurfaceClassName,
      )}
      style={{ left: 0, top: 0 }}
    >
      {instruction !== null && canEditSelection ? (
        <div className="w-[27rem] max-w-full">
          <form
            className="flex min-w-0 items-center gap-1.5 rounded-full pl-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (!instruction.trim()) return;
              onRequestEdit?.(selection, instruction.trim());
              close();
            }}
          >
            <Input
              ref={editInput}
              variant="plain"
              className="h-8 min-w-0 flex-1"
              aria-label={copy("修改要求", "Edit instruction")}
              autoComplete="off"
              placeholder={copy("描述你想怎么改…", "Describe the edit…")}
              value={instruction}
              maxLength={MARKDOWN_EDIT_INSTRUCTION_LIMIT}
              onChange={(event) => {
                setInstruction(event.target.value);
                setEditError(undefined);
              }}
            />
            <Button
              type="submit"
              size="icon-sm"
              className="rounded-full"
              aria-label={copy("提交修改要求", "Submit edit instruction")}
              disabled={!instruction.trim()}
            >
              <ArrowUp className="size-4" />
            </Button>
          </form>
          {editError && (
            <div role="alert" className="px-3 pb-1 text-xs text-destructive">
              {editError}
            </div>
          )}
        </div>
      ) : comment !== null ? (
        <form
          className="w-72 max-w-full space-y-2 p-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (comment.trim()) add(comment.trim());
          }}
        >
          <Textarea
            ref={editor}
            aria-label={copy("文件评论", "File comment")}
            placeholder={copy("添加评论…", "Add a comment…")}
            value={comment}
            rows={2}
            maxLength={1200}
            onChange={(event) => setComment(event.target.value)}
          />
          <div className="flex justify-end gap-1">
            <Button type="button" size="sm" variant="ghost" onClick={close}>
              {copy("取消", "Cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={!comment.trim()}>
              {copy("添加到对话", "Add to chat")}
            </Button>
          </div>
        </form>
      ) : (
        <fieldset
          aria-label={copy("选中文本操作", "Selected text actions")}
          className="flex items-center gap-0.5"
        >
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => add()}
          >
            <TextQuote className="size-3.5" />
            {copy("添加到对话", "Add to chat")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setComment("")}
          >
            <MessageSquareText className="size-3.5" />
            {copy("评论", "Comment")}
          </Button>
          {canEditSelection ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setInstruction("")}
            >
              <FilePenLine className="size-3.5" />
              {copy("编辑", "Edit")}
            </Button>
          ) : (
            position && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  window.getSelection()?.removeAllRanges();
                  close();
                  actions.onEditSource?.(position.line, position.column);
                }}
              >
                <FilePenLine className="size-3.5" />
                {copy("查看源码", "View source")}
              </Button>
            )
          )}
        </fieldset>
      )}
    </div>,
    document.body,
  );
}
