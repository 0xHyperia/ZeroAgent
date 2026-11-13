import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { usesMobileReturnKey } from "../../lib/chat/sendShortcut";
import { Check, Trash2 } from "../IconSet";
import { Button } from "../ui/button";
import { TooltipButton } from "../ui/tooltip-button";

export function DocumentCommentEditor({
  formRef,
  inputRef,
  position,
  value,
  editing,
  canSave,
  canSend,
  confirmDismiss,
  onChange,
  onSave,
  onCancel,
  onDelete,
}: {
  formRef: RefObject<HTMLFormElement | null>;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  position: { x: number; y: number } | null | undefined;
  value: string;
  editing: boolean;
  canSave: boolean;
  canSend: boolean;
  confirmDismiss: boolean;
  onChange: (value: string) => void;
  onSave: (sendBatch: boolean) => void;
  onCancel: () => void;
  onDelete: () => void;
}) {
  const compactText = useRef<HTMLSpanElement>(null);
  const [wrapped, setWrapped] = useState(false);
  const expanded = editing || wrapped;
  const mobileReturn = usesMobileReturnKey();
  useLayoutEffect(() => {
    const measure = compactText.current;
    if (!measure || editing) return;
    const checkWidth = () => setWrapped(measure.offsetHeight > 22);
    checkWidth();
    const observer = new ResizeObserver(checkWidth);
    observer.observe(measure);
    return () => observer.disconnect();
  }, [editing]);

  const text = `${value}\u200b`;
  return (
    <form
      ref={formRef}
      className="za-document-comment-editor"
      aria-label={editing ? "编辑批注" : "新建批注"}
      data-editing={editing}
      data-expanded={expanded}
      data-confirm-dismiss={confirmDismiss}
      data-anchor-hidden={position === null || undefined}
      style={
        position
          ? ({
              "--za-comment-editor-left": `${position.x}px`,
              "--za-comment-editor-top": `${position.y}px`,
            } as CSSProperties)
          : undefined
      }
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSave(false);
      }}
    >
      <span ref={compactText} className="za-document-comment-measure" aria-hidden="true">
        {text}
      </span>
      <div className="za-document-comment-body" data-value={text}>
        <textarea
          ref={inputRef}
          aria-label="修改建议"
          placeholder="描述更改或提出问题"
          enterKeyHint={mobileReturn ? "enter" : undefined}
          rows={1}
          maxLength={2000}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229 ||
              event.shiftKey ||
              event.altKey
            )
              return;
            const send = event.ctrlKey || event.metaKey;
            if (mobileReturn && !send) {
              event.stopPropagation();
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            if (!event.repeat && (send ? canSend : canSave)) onSave(send);
          }}
        />
      </div>
      {editing ? (
        <div className="za-document-comment-footer">
          <TooltipButton
            variant="ghost"
            size="icon-sm"
            tooltip="删除批注"
            aria-label="删除批注"
            onClick={onDelete}
          >
            <Trash2 className="size-4" aria-hidden="true" />
          </TooltipButton>
          <Button variant="outline" size="sm" onClick={onCancel}>
            取消
          </Button>
          <Button type="submit" size="sm" disabled={!canSave}>
            保存
          </Button>
        </div>
      ) : (
        <TooltipButton
          type="submit"
          size="icon-sm"
          className="za-document-comment-add"
          tooltip="添加批注"
          tooltipShortcut={mobileReturn ? undefined : "Enter"}
          disabled={!canSave}
          aria-label="添加批注"
        >
          <Check className="size-4" aria-hidden="true" />
        </TooltipButton>
      )}
    </form>
  );
}
