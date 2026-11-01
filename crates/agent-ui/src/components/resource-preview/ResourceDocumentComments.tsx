import { useContext, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  MessageSquare,
  MoreHorizontal,
  SquarePen,
  Trash2,
  X,
} from "../IconSet";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../ui/popover";
import type { DocumentSelection } from "./docxReaderDocument";
import { PreviewIdentityContext } from "./PreviewChrome";
import { usePreviewReadingState } from "./readingSession";

export type DocumentRevisionComment = {
  id: string;
  page: number;
  block: string;
  start: number;
  end: number;
  quote: string;
  comment: string;
};
export type RevisionSelection = DocumentSelection & { quote: string; page: number };

export function documentRevisionText(name: string, comments: readonly DocumentRevisionComment[]) {
  return `请根据以下批注修改所引用的文件「${name}」，保留未要求修改的内容，并保存为新版本。批注页码来自当前浏览器预览；请同时核对原文。\n\n${comments.map((item, index) => `${index + 1}. 第 ${item.page} 页 · ${item.block} · 字符 ${item.start}–${item.end}\n原文：${item.quote}\n修改要求：${item.comment}`).join("\n\n")}`;
}

/** Explicit submission only. Host supplies immutable resource authority and the normal send path. */
export function ResourceDocumentComments(props: {
  enabled: boolean;
  onEnabled: (enabled: boolean) => void;
  selection: RevisionSelection | null;
  onSelection: (selection: RevisionSelection | null) => void;
  onNavigate: (block: string, comment?: DocumentRevisionComment) => void;
  onMarks: (comments: readonly DocumentRevisionComment[]) => void;
}) {
  const { onRequestRevision } = useContext(PreviewIdentityContext);
  const [comments, setComments] = usePreviewReadingState("documentComments", []);
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const editingSelection = useRef<RevisionSelection | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.selection) {
      if (props.selection !== editingSelection.current) {
        setEditing(null);
        setInput("");
      }
      inputRef.current?.focus({ preventScroll: true });
    } else {
      editingSelection.current = null;
      setEditing(null);
      setInput("");
    }
  }, [props.selection]);
  const [index, setIndex] = useState(0);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listOpen, setListOpen] = useState(false);
  useEffect(() => {
    props.onMarks(comments);
  }, [comments, props.onMarks]);
  function publish(next: DocumentRevisionComment[]) {
    setComments(next);
  }
  function add() {
    const selection = props.selection;
    if (busy || !selection || !input.trim() || (!editing && comments.length >= 20)) return;
    const item = {
      id: editing ?? crypto.randomUUID(),
      page: selection.page,
      block: selection.id,
      start: selection.start,
      end: selection.end,
      quote: selection.quote,
      comment: input.trim().slice(0, 2000),
    };
    publish(
      editing ? comments.map((old) => (old.id === editing ? item : old)) : [...comments, item],
    );
    setEditing(null);
    props.onSelection(null);
    setInput("");
    if (!editing) setIndex(comments.length);
  }
  async function send() {
    if (!onRequestRevision || inFlight.current || busy || !comments.length) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (await onRequestRevision(comments)) {
        publish([]);
        props.onEnabled(false);
      } else setError("批注尚未发送，请先检查当前对话状态。批注已保留。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "未能发送，批注已保留。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  if (!props.enabled && !comments.length) return null;
  const current = comments[Math.min(index, comments.length - 1)];
  function move(direction: number) {
    const next = Math.max(0, Math.min(comments.length - 1, index + direction));
    setIndex(next);
    if (comments[next]) props.onNavigate(comments[next].block, comments[next]);
  }
  function editItem(item: DocumentRevisionComment | undefined) {
    if (!item || busy) return;
    setIndex(comments.indexOf(item));
    setListOpen(false);
    props.onNavigate(item.block, item);
    setEditing(item.id);
    setInput(item.comment);
    props.onEnabled(true);
    const selection = {
      id: item.block,
      page: item.page,
      start: item.start,
      end: item.end,
      quote: item.quote,
      x: 16,
      y: 72,
    };
    editingSelection.current = selection;
    props.onSelection(selection);
  }
  function removeItem(item: DocumentRevisionComment | undefined) {
    if (!item || busy) return;
    const next = comments.filter((old) => old.id !== item.id);
    publish(next);
    if (editing === item.id) props.onSelection(null);
    const currentIndex = current ? next.findIndex((old) => old.id === current.id) : -1;
    setIndex(currentIndex >= 0 ? currentIndex : Math.max(0, Math.min(index, next.length - 1)));
    if (!next.length) setListOpen(false);
  }
  return (
    <fieldset
      className="za-document-comments"
      aria-label="文档批注"
      disabled={busy}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onSelection(null);
        }
      }}
    >
      {props.selection && props.enabled ? (
        <form
          className="za-document-comment-input"
          style={{
            left: Math.max(16, props.selection.x),
            top: Math.max(72, props.selection.y + 12),
          }}
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <div className="za-document-comment-quote">{props.selection.quote}</div>
          <div className="za-document-comment-field">
            <input
              ref={inputRef}
              aria-label="修改建议"
              placeholder="描述你希望如何修改…"
              value={input}
              maxLength={2000}
              onChange={(event) => setInput(event.target.value)}
            />
            <Button
              type="submit"
              size="icon-sm"
              disabled={!input.trim() || (!editing && comments.length >= 20)}
              aria-label="添加批注"
            >
              <ArrowUp className="size-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="关闭批注输入"
              onClick={() => props.onSelection(null)}
            >
              <X className="size-4" />
            </Button>
          </div>
        </form>
      ) : null}
      <div className="za-document-comment-queue">
        <MessageSquare className="size-4" />
        {comments.length ? (
          <Popover open={listOpen} onOpenChange={setListOpen}>
            <PopoverTrigger
              className="za-document-comment-count"
              disabled={busy}
              aria-label={`查看 ${comments.length} 条批注`}
            >
              这 {comments.length} 条批注
            </PopoverTrigger>
            <PopoverContent side="top" className="za-document-comment-list" aria-label="批注列表">
              <PopoverTitle className="za-document-comment-list-title">批注</PopoverTitle>
              <ol>
                {comments.map((item, itemIndex) => (
                  <li key={item.id} data-current={item.id === current?.id}>
                    <button
                      type="button"
                      className="za-document-comment-jump"
                      disabled={busy}
                      aria-label={`定位第 ${itemIndex + 1} 条批注，第 ${item.page} 页`}
                      onClick={() => {
                        setIndex(itemIndex);
                        props.onNavigate(item.block, item);
                        setListOpen(false);
                      }}
                    >
                      <span className="za-document-comment-list-page">
                        {itemIndex + 1} · 第 {item.page} 页
                      </span>
                      <q>{item.quote}</q>
                      <span className="za-document-comment-list-text">{item.comment}</span>
                    </button>
                    <div className="za-document-comment-list-actions">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        aria-label={`编辑第 ${itemIndex + 1} 条批注`}
                        onClick={() => editItem(item)}
                      >
                        <SquarePen className="size-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        disabled={busy}
                        aria-label={`移除第 ${itemIndex + 1} 条批注`}
                        onClick={() => removeItem(item)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ol>
            </PopoverContent>
          </Popover>
        ) : (
          <span className="za-document-comment-count">选择文档中的段落添加批注</span>
        )}
        {comments.length ? (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className="za-document-comment-desktop-action"
              aria-label="上一条批注"
              disabled={index <= 0}
              onClick={() => move(-1)}
            >
              <ArrowUp className="size-4" />
            </Button>
            <Button
              className="za-document-comment-desktop-action"
              variant="ghost"
              size="icon-sm"
              aria-label="下一条批注"
              disabled={index >= comments.length - 1}
              onClick={() => move(1)}
            >
              <ChevronDown className="size-4" />
            </Button>
          </>
        ) : null}
        {current ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="za-document-comment-mobile-action"
                  aria-label="批注操作"
                  disabled={busy}
                />
              }
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="center">
              <DropdownMenuItem disabled={index <= 0} onClick={() => move(-1)}>
                上一条批注
              </DropdownMenuItem>
              <DropdownMenuItem disabled={index >= comments.length - 1} onClick={() => move(1)}>
                下一条批注
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => editItem(current)}>编辑当前批注</DropdownMenuItem>
              <DropdownMenuItem onClick={() => removeItem(current)}>移除当前批注</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            publish([]);
            props.onSelection(null);
            props.onEnabled(false);
          }}
        >
          取消
        </Button>
        {comments.length ? (
          <Button size="sm" disabled={busy || !onRequestRevision} onClick={() => void send()}>
            {busy ? <span className="za-reader-button-spinner" /> : <Check className="size-3" />}
            发送
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="za-document-comment-error">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
