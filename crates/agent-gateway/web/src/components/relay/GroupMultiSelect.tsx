import { Check, ChevronDown } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RelayGroup } from "@/lib/relay/client";
import { relayProviderTypeForPlatform } from "@/lib/relay/providers";

type Props = {
  groups: RelayGroup[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
  id?: string;
};

function platformLabel(platform: string) {
  const type = relayProviderTypeForPlatform(platform);
  if (type === "claude_code") return "Claude";
  if (type === "codex") return "OpenAI / Codex";
  if (type === "gemini") return "Gemini";
  return platform;
}

export function GroupMultiSelect({ groups, selectedIds, onChange, disabled, id }: Props) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedGroups = useMemo(
    () => groups.filter((group) => selectedSet.has(group.id)),
    [groups, selectedSet],
  );
  const count = selectedGroups.length;
  const selectionLabel = count
    ? zh
      ? `已选择 ${count} 个分组`
      : `${count} ${count === 1 ? "group" : "groups"} selected`
    : zh
      ? "选择一个或多个分组"
      : "Select one or more groups";

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  function toggle(groupId: number) {
    const next = new Set(selectedIds);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    onChange(groups.filter((group) => next.has(group.id)).map((group) => group.id));
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-left text-sm shadow-xs disabled:opacity-50"
      >
        <span className={selectedGroups.length ? "text-foreground" : "text-muted-foreground"}>
          {selectionLabel}
        </span>
        <ChevronDown className={`h-4 w-4 opacity-50 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          role="listbox"
          aria-multiselectable="true"
          className="layer-popover absolute mt-1 max-h-72 w-full min-w-64 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {groups.length === 0 ? (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {zh ? "暂无可用分组" : "No groups available"}
            </p>
          ) : (
            groups.map((group) => {
              const checked = selectedSet.has(group.id);
              return (
                <button
                  key={group.id}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  onClick={() => toggle(group.id)}
                  className="flex w-full items-center gap-2 rounded px-2 py-2 text-left hover:bg-accent"
                >
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded border ${checked ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}
                  >
                    {checked && <Check className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{group.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      {platformLabel(group.platform)} · {group.rate_multiplier}x
                    </span>
                  </span>
                </button>
              );
            })
          )}
        </div>
      )}
      {selectedGroups.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {selectedGroups.map((group) => (
            <span
              key={group.id}
              className="max-w-full truncate rounded border border-border/70 bg-muted/60 px-2 py-1 text-[11px]"
              title={group.name}
            >
              {group.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
