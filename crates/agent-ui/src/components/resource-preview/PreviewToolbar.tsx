import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";
import { ChevronRight } from "../IconSet";
import { TooltipButton as Button } from "../ui/tooltip-button";
import type { PreviewZoom } from "./readingSession";

/** Reading tools are local presentation state; the host still owns all file actions. */
export function PreviewToolbar({
  label,
  detail,
  children,
}: {
  label: string;
  detail?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="za-preview-toolbar">
      <div className="za-preview-toolbar-label">
        <span>{label}</span>
        {detail ? <span className="za-preview-toolbar-detail">{detail}</span> : null}
      </div>
      {children ? <div className="za-preview-toolbar-tools">{children}</div> : null}
    </div>
  );
}

export function PreviewPageControls({
  page,
  count,
  busy,
  onPage,
}: {
  page: number;
  count: number;
  busy?: boolean;
  onPage: (page: number) => void;
}) {
  const [input, setInput] = useState(String(page));
  useEffect(() => setInput(String(page)), [page]);
  const commit = () => {
    const target = /^\d+$/.test(input) ? Number(input) : Number.NaN;
    if (Number.isSafeInteger(target) && target >= 1 && target <= count) {
      setInput(String(target));
      onPage(target);
    } else setInput(String(page));
  };
  return (
    <nav className="za-preview-pages" aria-label="页面导航" aria-busy={busy}>
      <Button
        variant="ghost"
        size="sm"
        aria-label="上一页"
        tooltip="上一页"
        disabled={page <= 1 || !count}
        onClick={() => onPage(page - 1)}
      >
        <ChevronRight className="size-4 rotate-180" aria-hidden="true" />
      </Button>
      <label className="za-preview-page-number">
        <input
          aria-label="页码"
          inputMode="numeric"
          value={input}
          disabled={!count}
          onChange={(event) => setInput(event.target.value)}
          onBlur={() => setInput(String(page))}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setInput(String(page));
            }
          }}
        />
        <span aria-hidden="true"> / {count || "…"}</span>
        <span className="sr-only" aria-live="polite">
          第 {page} 页，共 {count || "…"} 页
        </span>
      </label>
      <Button
        variant="ghost"
        size="sm"
        aria-label="下一页"
        tooltip="下一页"
        disabled={!count || page >= count}
        onClick={() => onPage(page + 1)}
      >
        <ChevronRight className="size-4" aria-hidden="true" />
      </Button>
    </nav>
  );
}

export function PreviewZoomControl({
  label,
  value,
  onChange,
  maxPercent,
}: {
  label: string;
  value: PreviewZoom;
  onChange: (value: PreviewZoom) => void;
  maxPercent?: number;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next === "fit-width" || next === "fit-page" ? next : Number(next));
      }}
    >
      <option value="fit-width">适合宽度</option>
      <option value="fit-page">适合整页</option>
      {[50, 75, 100, 125, 150, 200, 300].map((percent) => (
        <option key={percent} value={percent}>
          {value === percent && maxPercent !== undefined && percent > maxPercent
            ? `${Math.round(maxPercent * 10) / 10}%（上限）`
            : `${percent}%`}
        </option>
      ))}
    </select>
  );
}

/** Scope shortcuts to the focused canvas; never consume keys from chat or toolbar inputs. */
export function previewPageKey(
  event: KeyboardEvent<HTMLElement>,
  page: number,
  count: number,
  onPage: (page: number) => void,
) {
  if (
    event.defaultPrevented ||
    event.target !== event.currentTarget ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey
  )
    return;
  const target =
    event.key === "ArrowRight" || event.key === "PageDown"
      ? Math.min(count, page + 1)
      : event.key === "ArrowLeft" || event.key === "PageUp"
        ? Math.max(1, page - 1)
        : event.key === "Home"
          ? 1
          : event.key === "End"
            ? count
            : null;
  if (target !== null && count) {
    event.preventDefault();
    onPage(target);
  }
}
