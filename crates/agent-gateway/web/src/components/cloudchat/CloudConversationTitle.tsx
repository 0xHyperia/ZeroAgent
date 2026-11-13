import { SquarePen } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export function CloudConversationTitle({
  title,
  onRename,
  renameRequest = 0,
  compact = false,
  onReturnFocus,
}: {
  title: string;
  onRename: (title: string) => Promise<void>;
  renameRequest?: number;
  compact?: boolean;
  onReturnFocus?: () => HTMLElement | null;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const cancelled = useRef(false);
  const restoreTriggerFocus = useRef(false);
  const lastRenameRequest = useRef(renameRequest);
  useEffect(() => {
    if (lastRenameRequest.current === renameRequest) return;
    lastRenameRequest.current = renameRequest;
    if (pending.current) return;
    cancelled.current = false;
    setDraft(title);
    setError("");
    setEditing(true);
  }, [renameRequest, title]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (restoreTriggerFocus.current) {
      restoreTriggerFocus.current = false;
      const trigger = triggerRef.current;
      if (trigger && trigger.ownerDocument.activeElement === trigger.ownerDocument.body) {
        trigger.focus({ preventScroll: true });
      }
    }
  }, [editing]);
  const finishEditing = () => {
    const input = inputRef.current;
    restoreTriggerFocus.current = !compact && Boolean(input && input.ownerDocument.activeElement === input);
    setEditing(false);
  };
  const cancel = () => {
    cancelled.current = true;
    finishEditing();
    setError("");
  };
  async function commit() {
    if (pending.current || cancelled.current) return;
    const value = draft.trim();
    if (!value) {
      setError("标题不能为空");
      return;
    }
    if (value === title) {
      cancel();
      return;
    }
    pending.current = true;
    setSaving(true);
    setError("");
    try {
      await onRename(value);
      if (mounted.current) finishEditing();
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "标题保存失败，请重试");
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  const editor = editing ? (
    <div className="relative min-w-0">
      <input
        ref={inputRef}
        aria-label="对话标题"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? "cloud-title-error" : undefined}
        className="cloud-title-input"
        value={draft}
        maxLength={200}
        readOnly={saving}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setError("");
        }}
        onBlur={() => {
          if (!compact && !error) void commit();
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            if (!pending.current) cancel();
          }
          if (event.key === "Enter") {
            event.preventDefault();
            event.stopPropagation();
            void commit();
          }
        }}
      />
      {saving ? (
        <span className="sr-only" role="status">
          正在保存标题
        </span>
      ) : null}
      {error ? (
        <p id="cloud-title-error" role="alert" className={compact ? "mt-2 text-sm text-destructive" : "cloud-title-error"}>
          {error}
        </p>
      ) : null}
    </div>
  ) : null;
  if (compact) {
    return (
      <Dialog open={editing} onOpenChange={(open) => { if (!open && !pending.current) cancel(); }}>
        <DialogContent initialFocus={inputRef} finalFocus={onReturnFocus}>
          <DialogHeader><DialogTitle>重命名对话</DialogTitle></DialogHeader>
          <DialogBody>{editor}</DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" className="min-h-11" disabled={saving} onClick={cancel}>取消</Button>
            <Button type="button" className="min-h-11" disabled={saving || !draft.trim()} onClick={() => void commit()}>保存</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <div className="cloud-conversation-title min-w-0">
      <button
        ref={triggerRef}
        type="button"
        className={editing ? "hidden" : "cloud-title-trigger"}
        aria-label={`修改对话标题：${title}`}
        onClick={() => {
          cancelled.current = false;
          setDraft(title);
          setError("");
          setEditing(true);
        }}
      >
        <span className="truncate">{title}</span>
        <SquarePen className="cloud-title-pencil size-3.5 shrink-0" aria-hidden="true" />
      </button>
      {editor}
    </div>
  );
}
