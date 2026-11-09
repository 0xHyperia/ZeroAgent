import { type CSSProperties, type RefObject, useRef } from "react";
import { useLocale } from "../../i18n";
import { ArrowUp, Trash2, X } from "../IconSet";
import { Popover, PopoverContent } from "../ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { TooltipButton as Button } from "../ui/tooltip-button";
import type { ImageComment, ImagePoint } from "./conversationImageAnnotation";

function pointStyle(point: ImagePoint) {
  return { left: `${point.x * 100}%`, top: `${point.y * 100}%` };
}

export function ConversationImageComments({
  comments,
  editor,
  style,
  reader,
  disabled,
  onEditor,
  onSave,
  onDelete,
}: {
  comments: readonly ImageComment[];
  editor: ImageComment | undefined;
  style: CSSProperties;
  reader: RefObject<HTMLElement | null>;
  disabled: boolean;
  onEditor: (comment: ImageComment | undefined) => void;
  onSave: (comment: ImageComment) => void;
  onDelete: (id: string) => void;
}) {
  const zh = useLocale().locale === "zh-CN";
  const layer = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const addField = useRef<HTMLInputElement>(null);
  const editField = useRef<HTMLTextAreaElement>(null);
  const index = comments.findIndex(({ id }) => id === editor?.id);
  const editing = index !== -1;
  const title = editing ? (zh ? "编辑评论" : "Edit comment") : zh ? "添加评论" : "Add comment";
  const restoreFocus = (id?: string) => {
    requestAnimationFrame(() => {
      const pin = id
        ? Array.from(
            layer.current?.querySelectorAll<HTMLButtonElement>("[data-image-comment]") ?? [],
          ).find((entry) => entry.dataset.imageComment === id)
        : undefined;
      (pin ?? reader.current)?.focus({
        preventScroll: true,
      });
    });
  };
  const dismiss = () => {
    onEditor(undefined);
    restoreFocus(editing ? editor?.id : undefined);
  };
  return (
    <div ref={layer} className="za-image-comment-layer" data-image-gesture-exempt="" style={style}>
      {comments.map((comment, position) => {
        const active = editor?.id === comment.id;
        return (
          <Tooltip key={comment.id} disabled={active}>
            <TooltipTrigger
              render={<button type="button" className="za-image-comment-pin" disabled={disabled} />}
              style={pointStyle(comment.point)}
              data-image-comment={comment.id}
              aria-label={zh ? `编辑评论 ${position + 1}` : `Edit comment ${position + 1}`}
              aria-haspopup="dialog"
              aria-expanded={active}
              onClick={() => {
                if (!active) onEditor(comment);
              }}
            >
              {position + 1}
            </TooltipTrigger>
            <TooltipContent
              side={comment.point.x >= 0.52 ? "left" : "right"}
              className="za-image-comment-tooltip"
            >
              {comment.text}
            </TooltipContent>
          </Tooltip>
        );
      })}
      {editor && (
        <>
          <span
            ref={anchor}
            className={editing ? "za-image-comment-anchor" : "za-image-comment-number"}
            style={pointStyle(editor.point)}
            aria-hidden="true"
          >
            {!editing && comments.length + 1}
          </span>
          <Popover
            open
            onOpenChange={(open, details) => {
              if (open) return;
              if (details.reason === "escape-key") dismiss();
              else onEditor(undefined);
            }}
          >
            <PopoverContent
              key={editor.id}
              anchor={anchor}
              portalContainer={reader}
              side={editor.point.x >= 0.52 ? "left" : "right"}
              sideOffset={10}
              positionMethod="fixed"
              initialFocus={editing ? editField : addField}
              finalFocus={false}
              aria-label={title}
              className="za-image-comment-popover"
              data-editing={editing ? "" : undefined}
              data-image-gesture-exempt=""
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  event.stopPropagation();
                  dismiss();
                }
              }}
            >
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!editor.text.trim()) return;
                  onSave({ ...editor, text: editor.text.trim() });
                  restoreFocus(editing ? editor.id : undefined);
                }}
              >
                {editing ? (
                  <>
                    <textarea
                      ref={editField}
                      rows={2}
                      aria-label={title}
                      maxLength={160}
                      value={editor.text}
                      onChange={(event) => onEditor({ ...editor, text: event.currentTarget.value })}
                    />
                    <div className="za-image-comment-actions">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={zh ? "删除评论" : "Delete comment"}
                        tooltip={zh ? "删除评论" : "Delete comment"}
                        onClick={() => {
                          onDelete(editor.id);
                          restoreFocus();
                        }}
                      >
                        <Trash2 />
                      </Button>
                      <Button variant="secondary" size="sm" onClick={dismiss}>
                        {zh ? "取消" : "Cancel"}
                      </Button>
                      <Button type="submit" size="sm" disabled={!editor.text.trim()}>
                        {zh ? "保存" : "Save"}
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="za-image-comment-add">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="za-image-comment-dismiss"
                      aria-label={zh ? "取消添加评论" : "Cancel adding comment"}
                      onClick={dismiss}
                    >
                      <X />
                    </Button>
                    <input
                      ref={addField}
                      type="text"
                      aria-label={title}
                      placeholder={zh ? "添加评论…" : "Add a comment…"}
                      maxLength={160}
                      value={editor.text}
                      onChange={(event) => onEditor({ ...editor, text: event.currentTarget.value })}
                    />
                    <Button
                      type="submit"
                      size="icon-sm"
                      aria-label={title}
                      disabled={!editor.text.trim()}
                    >
                      <ArrowUp />
                    </Button>
                  </div>
                )}
              </form>
            </PopoverContent>
          </Popover>
        </>
      )}
    </div>
  );
}
