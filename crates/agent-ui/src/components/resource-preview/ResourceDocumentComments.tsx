import { type RefObject, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  MessageSquareText,
  MoreHorizontal,
  SquarePen,
  Trash2,
} from "../IconSet";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { TooltipButton } from "../ui/tooltip-button";
import type {
  DocumentPageGeometry,
  DocumentRegion,
  DocumentSelection,
  DocumentSelectionAnchor,
} from "./docxReaderDocument";
import { PreviewIdentityContext } from "./PreviewChrome";
import { usePreviewReadingState } from "./readingSession";
import { useReaderFloatingPosition } from "./useReaderFloatingPosition";

export type DocumentRevisionTarget =
  | { kind: "sheet"; sheet: string; range: string; anchor?: string }
  | {
      kind: "slide";
      slide: number;
      slideId?: string;
      slideTitle?: string;
      element?: {
        id: string;
        name: string;
        kind: string;
        rotation?: number;
        bounds?: DocumentRegion;
      };
      point?: { x: number; y: number };
      elementOffset?: { x: number; y: number };
      elementIds?: string[];
    };
type PdfRevisionTarget = {
  pageCount: number;
  pageWidth: number;
  pageHeight: number;
  kind: "point" | "region" | "text";
};
export type DocumentRevisionComment = {
  id: string;
  page: number;
  block: string;
  start: number;
  end: number;
  quote: string;
  comment: string;
  region?: DocumentRegion;
  anchors?: DocumentSelectionAnchor[];
  kind?: "image";
  target?: DocumentRevisionTarget;
  pdf?: PdfRevisionTarget;
  document?: DocumentPageGeometry;
};
export type RevisionSelection = DocumentSelection & {
  quote: string;
  page: number;
  visible?: boolean;
  target?: DocumentRevisionTarget;
  pdf?: PdfRevisionTarget;
};
function selectionKey(value: RevisionSelection | null) {
  return value ? JSON.stringify([value.id, value.start, value.end, value.region]) : "";
}

export function documentRevisionLocation(item: Pick<DocumentRevisionComment, "target" | "page">) {
  if (item.target?.kind === "sheet") return `${item.target.sheet} · ${item.target.range}`;
  if (item.target?.kind === "slide")
    return `第 ${item.target.slide} 张${item.target.element?.name ? ` · ${item.target.element.name}` : ""}`;
  return `第 ${item.page} 页`;
}

export type RevisionSelectionBounds = {
  target: DOMRectReadOnly;
  viewport: DOMRectReadOnly;
  observe?: Element;
  align?: "end";
};

/** Explicit submission only. Host supplies immutable resource authority and the normal send path. */
export function ResourceDocumentComments(props: {
  enabled: boolean;
  onEnabled: (enabled: boolean) => void;
  selection: RevisionSelection | null;
  onSelection: (selection: RevisionSelection | null) => void;
  onNavigate: (block: string, comment?: DocumentRevisionComment, source?: "marker") => void;
  onMarks: (comments: readonly DocumentRevisionComment[]) => void;
  exitRef?: RefObject<(() => void) | null>;
  editRef?: RefObject<((id: string, source?: "marker") => void) | null>;
  dismissSelectionRef?: RefObject<(() => boolean) | null>;
  toolbarTarget?: HTMLElement | null;
  prepareEvidence?: (comments: readonly DocumentRevisionComment[]) => Promise<readonly File[]>;
  resolveSelectionBounds?: (selection: RevisionSelection) => RevisionSelectionBounds | undefined;
  sheetSelection?: boolean;
}) {
  const { onRequestRevision } = useContext(PreviewIdentityContext);
  const [comments, setComments] = usePreviewReadingState("documentComments", []);
  const [input, setInput] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const hasUncommittedInput = Boolean(
    input.trim() &&
      !(
        props.sheetSelection &&
        editing &&
        comments.some((comment) => comment.id === editing && comment.comment === input.trim())
      ),
  );
  const editingSelection = useRef<RevisionSelection | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (props.selection) {
      if (selectionKey(props.selection) !== selectionKey(editingSelection.current)) {
        const existing = comments.find(
          (item) =>
            (props.selection?.kind === "image" &&
              item.kind === "image" &&
              item.block === props.selection.id) ||
            selectionKey({ ...item, id: item.block, x: 0, y: 0 }) === selectionKey(props.selection),
        );
        setEditing(existing?.id ?? null);
        setInput(existing?.comment ?? "");
      }
      editingSelection.current = props.selection;
    } else {
      editingSelection.current = null;
      setEditing(null);
      setInput("");
    }
  }, [props.selection, comments]);
  const [index, setIndex] = useState(0);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listSource, setListSource] = useState<"toolbar" | "queue" | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const floating = useReaderFloatingPosition(props.enabled || comments.length > 0);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const { selection, resolveSelectionBounds } = props;
  const overlay = floating.root;
  useLayoutEffect(() => {
    const root = overlay.current;
    if (!root || !selection || !resolveSelectionBounds) return;
    const parent = root.parentElement;
    const update = () => {
      const bounds = resolveSelectionBounds(selection);
      const area = root.getBoundingClientRect();
      if (!bounds) return setPosition(null);
      const { target, viewport, align } = bounds;
      if (
        target.right < viewport.left ||
        target.left > viewport.right ||
        target.bottom < viewport.top ||
        target.top > viewport.bottom
      )
        return setPosition(null);
      const width = Math.min(360, area.width - 24);
      const left = align === "end" ? target.right - width : target.left;
      const x = Math.max(12, Math.min(left - area.left, area.width - width - 12));
      const bottom = Math.min(target.bottom, viewport.bottom) - area.top;
      const y = Math.max(8, Math.min(bottom, area.height - 64));
      setPosition((previous) => (previous?.x === x && previous.y === y ? previous : { x, y }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(root);
    const target = resolveSelectionBounds(selection)?.observe;
    if (target) observer.observe(target);
    parent?.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      parent?.removeEventListener("scroll", update, true);
    };
  }, [overlay, selection, resolveSelectionBounds]);
  const key = selectionKey(selection);
  const hasAnchor = !resolveSelectionBounds || !!position;
  const inputVisible = !!selection && selection.visible !== false && hasAnchor && props.enabled;
  const focusedKey = useRef("");
  useEffect(() => {
    if (!key || (props.sheetSelection && !inputVisible)) focusedKey.current = "";
    if (inputVisible && inputRef.current && focusedKey.current !== key) {
      inputRef.current.focus({ preventScroll: true });
      focusedKey.current = key;
    }
  }, [inputVisible, key, props.sheetSelection]);
  function exit() {
    if (busy) return;
    if (comments.length || input.trim()) setConfirmDiscard(true);
    else {
      props.onSelection(null);
      props.onEnabled(false);
    }
  }
  useEffect(() => {
    if (props.exitRef) props.exitRef.current = exit;
    return () => {
      if (props.exitRef) props.exitRef.current = null;
    };
  });
  useEffect(() => {
    const ref = props.dismissSelectionRef;
    if (!ref) return;
    ref.current = () => {
      if (busy || hasUncommittedInput) {
        if (props.sheetSelection) inputRef.current?.focus({ preventScroll: true });
        return false;
      }
      props.onSelection(null);
      return true;
    };
    return () => {
      ref.current = null;
    };
  }, [
    props.dismissSelectionRef,
    props.onSelection,
    props.sheetSelection,
    busy,
    hasUncommittedInput,
  ]);
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
      ...(selection.kind ? { kind: selection.kind } : {}),
      ...(selection.region ? { region: selection.region } : {}),
      ...(selection.anchors ? { anchors: selection.anchors } : {}),
      ...(selection.target ? { target: selection.target } : {}),
      ...(selection.pdf ? { pdf: selection.pdf } : {}),
      ...(selection.document ? { document: selection.document } : {}),
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
    if (
      !onRequestRevision ||
      inFlight.current ||
      busy ||
      !comments.length ||
      (props.sheetSelection && hasUncommittedInput)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const evidence = await props.prepareEvidence?.(comments);
      if (await onRequestRevision(comments, evidence)) {
        publish([]);
        props.onSelection(null);
        props.onEnabled(false);
      } else setError("批注尚未发送，请先检查当前对话状态。批注已保留。");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "未能发送，批注已保留。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    if (props.editRef)
      props.editRef.current = (id, source) => {
        const item = comments.find((item) => item.id === id);
        if (item && !busy) editItem(item, source);
      };
    return () => {
      if (props.editRef) props.editRef.current = null;
    };
  });
  const current = comments[Math.min(index, comments.length - 1)];
  function move(direction: number) {
    if (props.sheetSelection && props.selection && props.dismissSelectionRef?.current?.() === false)
      return;
    const next = Math.max(0, Math.min(comments.length - 1, index + direction));
    setIndex(next);
    if (comments[next]) props.onNavigate(comments[next].block, comments[next]);
  }
  function editItem(item: DocumentRevisionComment | undefined, source?: "marker") {
    if (
      !item ||
      busy ||
      (props.sheetSelection && props.selection && props.dismissSelectionRef?.current?.() === false)
    )
      return;
    setIndex(comments.indexOf(item));
    setListSource(null);
    props.onNavigate(item.block, item, source);
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
      region: item.region,
      anchors: item.anchors,
      kind: item.kind,
      target: item.target,
      pdf: item.pdf,
      document: item.document,
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
    if (!next.length) setListSource(null);
  }
  function reviewList(source: "toolbar" | "queue") {
    const toolbar = source === "toolbar";
    return (
      <Popover
        open={listSource === source && !!comments.length}
        onOpenChange={(open) =>
          setListSource((previous) => (open ? source : previous === source ? null : previous))
        }
      >
        {toolbar ? (
          <PopoverTrigger
            render={<TooltipButton variant="ghost" size="icon-sm" tooltip="批注" />}
            disabled={busy || !comments.length}
            aria-label="批注"
          >
            <MessageSquareText className="size-4" />
          </PopoverTrigger>
        ) : (
          <PopoverTrigger
            openOnHover
            delay={180}
            closeDelay={160}
            className="za-document-comment-count"
            disabled={busy}
            aria-label={`查看 ${comments.length} 条批注`}
          >
            这 {comments.length} 条批注
          </PopoverTrigger>
        )}
        <PopoverContent
          side={toolbar ? "bottom" : "top"}
          align={toolbar ? "end" : "center"}
          initialFocus={(type) => type === "keyboard"}
          className="za-document-comment-list"
          aria-label="批注列表"
        >
          <PopoverTitle className="sr-only">批注</PopoverTitle>
          <ol>
            {comments.map((item, itemIndex) => (
              <li key={item.id} data-current={item.id === current?.id}>
                <button
                  type="button"
                  className="za-document-comment-jump"
                  disabled={busy}
                  aria-label={`定位第 ${itemIndex + 1} 条批注，${documentRevisionLocation(item)}`}
                  onClick={() => {
                    setIndex(itemIndex);
                    props.onNavigate(item.block, item);
                    setListSource(null);
                  }}
                >
                  <span className="za-document-comment-list-page">
                    {documentRevisionLocation(item)}
                  </span>
                  {item.quote && <q>{item.quote}</q>}
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
    );
  }
  const toolbarReview = props.toolbarTarget
    ? createPortal(reviewList("toolbar"), props.toolbarTarget)
    : null;
  if (!props.enabled && !comments.length) return toolbarReview;
  return (
    <fieldset
      ref={floating.root}
      className="za-document-comments"
      aria-label="文档批注"
      disabled={busy}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (props.dismissSelectionRef) props.dismissSelectionRef.current?.();
          else props.onSelection(null);
        }
      }}
    >
      {toolbarReview}
      {selection && inputVisible ? (
        <form
          className="za-document-comment-input"
          style={
            props.sheetSelection
              ? undefined
              : {
                  left: resolveSelectionBounds ? position?.x : Math.max(16, selection.x),
                  top:
                    resolveSelectionBounds && position
                      ? position.y + 8
                      : Math.max(72, selection.y + 8),
                }
          }
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <div className="za-document-comment-field">
            <input
              ref={inputRef}
              aria-label="修改建议"
              placeholder="描述更改或提出问题"
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
              <Check className="size-4" />
            </Button>
          </div>
        </form>
      ) : null}
      <div ref={floating.bar} className="za-document-comment-queue" style={floating.style}>
        <button
          type="button"
          className="za-document-comment-drag"
          aria-label="移动批注工具条，方向键调整位置"
          {...floating.handle}
        >
          <GripVertical className="size-4" />
        </button>
        {comments.length ? (
          reviewList("queue")
        ) : (
          <span className="za-document-comment-count">选中内容并提出修改要求</span>
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
              <ChevronUp className="size-4" />
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
        <Button variant="ghost" size="sm" disabled={busy} onClick={exit}>
          取消
        </Button>
        {comments.length ? (
          <Button
            className="za-document-comment-send"
            size="sm"
            disabled={busy || !onRequestRevision || (props.sheetSelection && hasUncommittedInput)}
            onClick={() => void send()}
          >
            {busy ? <span className="za-reader-button-spinner" /> : null}
            发送
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="za-document-comment-error">
          {error}
        </p>
      ) : null}
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>要舍弃批注吗？</AlertDialogTitle>
            <AlertDialogDescription>你还有未发送的批注。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setConfirmDiscard(false)}>
              保留批注
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                publish([]);
                setInput("");
                props.onSelection(null);
                props.onEnabled(false);
                setConfirmDiscard(false);
              }}
            >
              放弃
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </fieldset>
  );
}
