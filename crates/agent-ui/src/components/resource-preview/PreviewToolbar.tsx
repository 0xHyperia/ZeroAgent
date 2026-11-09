import { type KeyboardEvent, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "../../i18n";
import { ChevronDown, ChevronRight } from "../IconSet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TooltipButton as Button } from "../ui/tooltip-button";
import { PreviewToolbarMount } from "./PreviewChrome";
import { bindReaderZoom } from "./readerZoom";
import type { PreviewZoom } from "./readingSession";

/** Reading tools are local presentation state; the host still owns all file actions. */
export function PreviewToolbar({
  label,
  detail,
  children,
  placement = "format",
}: {
  label: string;
  detail?: ReactNode;
  children?: ReactNode;
  placement?: "format" | "options";
}) {
  const mount = useContext(PreviewToolbarMount);
  const target = placement === "options" ? (mount?.optionsTarget ?? mount?.target) : mount?.target;
  if (mount)
    return target && children
      ? createPortal(
          <fieldset
            className="za-preview-toolbar-tools"
            aria-label={label}
            style={{ border: 0, padding: 0, margin: 0 }}
          >
            {children}
          </fieldset>,
          target,
        )
      : null;
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

export function PreviewLeadingTools({ children }: { children: ReactNode }) {
  const mount = useContext(PreviewToolbarMount);
  return mount?.leadingTarget ? createPortal(children, mount.leadingTarget) : children;
}

export function PreviewPageControls({
  page,
  count,
  busy,
  inline,
  onPage,
}: {
  page: number;
  count: number;
  busy?: boolean;
  inline?: boolean;
  onPage: (page: number) => void;
}) {
  const mount = useContext(PreviewToolbarMount);
  const [input, setInput] = useState(String(page));
  useEffect(() => setInput(String(page)), [page]);
  const commit = () => {
    const target = /^\d+$/.test(input) ? Number(input) : Number.NaN;
    if (Number.isSafeInteger(target) && target >= 1 && target <= count) {
      setInput(String(target));
      onPage(target);
    } else setInput(String(page));
  };
  const controls = (
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
  return !inline && mount?.pageTarget ? createPortal(controls, mount.pageTarget) : controls;
}

export function PreviewZoomControl({
  label,
  value,
  onChange,
  maxPercent,
  actualPercent,
  gestures = true,
  fitPage = true,
  fitWidth = true,
  percentages = [25, 50, 75, 100, 125, 150, 200, 300],
}: {
  label: string;
  value: PreviewZoom;
  onChange: (value: PreviewZoom) => void;
  maxPercent?: number;
  actualPercent?: number;
  /** Image canvases implement anchor-aware pan/pinch without a second gesture listener. */
  gestures?: boolean;
  fitPage?: boolean;
  fitWidth?: boolean;
  percentages?: number[];
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const trigger = useRef<HTMLButtonElement>(null);
  const latest = useRef({ value, actualPercent, onChange });
  latest.current = { value, actualPercent, onChange };
  useEffect(() => {
    if (!gestures) return;
    const element = trigger.current?.closest<HTMLElement>(
      "[data-cloud-resource-panel],.za-resource-preview",
    );
    if (!element || element.matches('[data-variant="thumbnail"]')) return;
    return bindReaderZoom(
      element,
      () => {
        const snapshot = latest.current;
        return typeof snapshot.value === "number"
          ? snapshot.value
          : (snapshot.actualPercent ?? 100);
      },
      maxPercent ?? 400,
      (next) => latest.current.onChange(next),
    );
  }, [maxPercent, gestures]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button ref={trigger} type="button" className="za-preview-zoom-trigger" />}
        aria-label={label}
      >
        {typeof value !== "number" && actualPercent !== undefined
          ? `${Math.round(actualPercent)}%`
          : typeof value === "number"
            ? `${Math.round(Math.min(value, maxPercent ?? value) * 10) / 10}%`
            : value === "fit-page"
              ? zh
                ? "适合窗口"
                : "Fit to window"
              : zh
                ? "适合宽度"
                : "Fit to width"}
        <ChevronDown className="size-3" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="za-preview-zoom-menu">
        <DropdownMenuRadioGroup
          value={String(value)}
          onValueChange={(next) =>
            onChange(next === "fit-width" || next === "fit-page" ? next : Number(next))
          }
        >
          {percentages.map((percent) => (
            <DropdownMenuRadioItem key={percent} value={String(percent)} closeOnClick>
              {percent}%
            </DropdownMenuRadioItem>
          ))}
          {fitWidth || fitPage ? <DropdownMenuSeparator /> : null}
          {fitWidth ? (
            <DropdownMenuRadioItem value="fit-width" closeOnClick>
              {zh ? "适合宽度" : "Fit to width"}
            </DropdownMenuRadioItem>
          ) : null}
          {fitPage ? (
            <DropdownMenuRadioItem value="fit-page" closeOnClick>
              {zh ? "缩放至适合窗口" : "Fit to window"}
            </DropdownMenuRadioItem>
          ) : null}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
