import { SquarePen } from "@liveagent/ui/components/IconSet";
import { useEffect, useRef, useState } from "react";

export function CloudConversationTitle({
  title,
  onRename,
  renameRequest = 0,
}: {
  title: string;
  onRename: (title: string) => Promise<void>;
  renameRequest?: number;
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
  const wasEditing = useRef(false);
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
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (wasEditing.current) triggerRef.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const cancel = () => {
    cancelled.current = true;
    setEditing(false);
    setError("");
  };
  async function commit() {
    if (pending.current || cancelled.current) return;
    const value = draft.trim();
    if (!value) {
      setError("标题不能为空");
      inputRef.current?.focus();
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
      if (mounted.current) setEditing(false);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : "标题保存失败，请重试");
        inputRef.current?.focus();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
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
      {editing ? (
        <div className="relative min-w-0">
          <input
            ref={inputRef}
            aria-label="对话标题"
            aria-invalid={Boolean(error)}
            aria-describedby={error ? "cloud-title-error" : undefined}
            className="cloud-title-input"
            value={draft}
            maxLength={200}
            disabled={saving}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setError("");
            }}
            onBlur={() => {
              if (!error) void commit();
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
            <p id="cloud-title-error" role="alert" className="cloud-title-error">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
