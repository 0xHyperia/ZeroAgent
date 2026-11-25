import "@liveagent/ui/i18n/namespaces/projectTools";
import { useRef, useState } from "react";
import { useLocale } from "../../../i18n";
import { copyTextToClipboard } from "../../../lib/shared/clipboard";
import { getFileTypeIcon } from "../../chat/fileTypeIcons";
import { Copy, DiffSquare, Eye, File, GitBranch, ImageIcon, Package } from "../../IconSet";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { LabelTooltip } from "../../ui/label-tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import { TooltipButton } from "../../ui/tooltip-button";
import type { WorkspaceGitPresentation } from "../workspaceGitReviewState";
import type { PatchChunk } from "./model";

const toolbarIcon = "za-review-icon";
const nextLayout = { unified: "split", split: "auto", auto: "unified" } as const;

function ReviewLayoutIcon({ layout }: { layout: WorkspaceGitPresentation["layout"] }) {
  return (
    <svg aria-hidden="true" className="size-4" viewBox="0 0 16 16" fill="none">
      <rect
        x="2"
        y="2.67"
        width="12"
        height="10.66"
        rx="1.87"
        stroke="currentColor"
        strokeWidth="1.05"
      />
      <g opacity=".5">
        {layout === "auto" ? (
          <>
            <path d="M4.25 4.54H11.65L3.64 10.76V5.14a.6.6 0 0 1 .61-.6Z" fill="#f84e63" />
            <path d="M12.36 5.24V10.86a.6.6 0 0 1-.6.6H4.34Z" fill="#36d958" />
          </>
        ) : layout === "split" ? (
          <>
            <rect x="3.64" y="4.54" width="3.8" height="6.92" rx=".6" fill="#f84e63" />
            <rect x="8.55" y="4.54" width="3.81" height="6.92" rx=".6" fill="#36d958" />
          </>
        ) : (
          <>
            <rect x="3.64" y="4.54" width="8.72" height="3.02" rx=".6" fill="#f84e63" />
            <rect x="3.64" y="8.44" width="8.72" height="3.02" rx=".6" fill="#36d958" />
          </>
        )}
      </g>
    </svg>
  );
}

const reviewGlyphs = {
  files:
    "M4.1 4V3.4A1.4 1.4 0 0 1 5.5 2h3l1.25 1.35h3.55a1.45 1.45 0 0 1 1.45 1.45v5.05a1.4 1.4 0 0 1-1.4 1.4h-.8M2.8 4.75h3.1l1.2 1.25h3.5A1.4 1.4 0 0 1 12 7.4v4.9a1.45 1.45 0 0 1-1.45 1.45H2.8a1.45 1.45 0 0 1-1.45-1.45V6.2A1.45 1.45 0 0 1 2.8 4.75Z",
  jump: "M6.55 13.45H4.05a1.3 1.3 0 0 1-1.3-1.3V3.15a1.3 1.3 0 0 1 1.3-1.3H9.1l3.3 3.25v2.45M8.7 2.2v2.4a.9.9 0 0 0 .9.9H12M12.45 12.55l1.7 1.7",
  refresh:
    "M13.55 2.3v3.65H9.9m3.55-.3A5.85 5.85 0 0 0 2.4 5M2.45 13.7v-3.65H6.1m-3.55.3A5.85 5.85 0 0 0 13.6 11",
  wrap: "M13 2.6v10.8m-3.5-7.7H5.15a2 2 0 0 0 0 4h4.3M5.5 7.6 3.35 9.7l2.15 2.15",
  collapse:
    "M8.8 6.3h4.5M8.8 9.7h2.8M4.25 2.7v3.7m-1.6-1.5 1.6 1.6 1.6-1.6m-1.6 8.4V9.6m-1.6 1.5 1.6-1.6 1.6 1.6",
  expand:
    "M8.8 5.3h4.5m-4.5 2.7h4.5m-4.5 2.7h2.8M4.25 3.4v9.2m-1.6-7.5 1.6-1.6 1.6 1.6m-3.2 5.8 1.6 1.6 1.6-1.6",
} as const;

function ReviewGlyph({
  name,
  spinning = false,
}: {
  name: keyof typeof reviewGlyphs | "more";
  spinning?: boolean;
}) {
  return (
    <svg
      aria-hidden="true"
      data-review-glyph={name}
      className={spinning ? "size-4 animate-spin" : "size-4"}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.1"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {name === "more" ? (
        <path d="M3.3 8h.01M8 8h.01m4.69 0h.01" strokeWidth="2.15" />
      ) : (
        <path d={reviewGlyphs[name]} />
      )}
      {name === "jump" && <circle cx="10.65" cy="10.7" r="2.65" />}
    </svg>
  );
}

function ReviewFileJump({ rows, onJump }: { rows: PatchChunk[]; onJump: (key: string) => void }) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const title = zh ? "跳转到文件" : "Jump to file";
  const matches = rows.filter((row) =>
    row.label.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const select = (key: string) => {
    setOpen(false);
    onJump(key);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setQuery("");
        setOpen(next);
      }}
    >
      <LabelTooltip
        label={title}
        side="bottom"
        disabled={open || !rows.length}
        render={
          <PopoverTrigger className={toolbarIcon} aria-label={title} disabled={!rows.length}>
            <ReviewGlyph name="jump" />
          </PopoverTrigger>
        }
      />
      <PopoverContent
        align="end"
        initialFocus={inputRef}
        className="w-[360px] max-w-[calc(100vw-1rem)] p-1.5"
        aria-label={title}
      >
        <input
          ref={inputRef}
          aria-label={title}
          placeholder={zh ? "筛选变更文件…" : "Filter changed files…"}
          className="h-8 w-full rounded-lg border border-border px-2 text-sm outline-none focus-visible:border-ring"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing || !matches[0]) return;
            event.preventDefault();
            select(matches[0].key);
          }}
        />
        <div className="mt-1 max-h-60 overflow-y-auto">
          {matches.map((row) => {
            const Icon = getFileTypeIcon(row.label, "file");
            return (
              <button
                type="button"
                key={row.key}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent focus-visible:bg-accent"
                title={row.label}
                onClick={() => select(row.key)}
              >
                <Icon className="size-3.5 shrink-0" />
                <span className="truncate">{row.label}</span>
              </button>
            );
          })}
          {!matches.length && (
            <p className="px-2 py-3 text-xs text-muted-foreground">
              {zh ? "没有匹配的文件" : "No matching files"}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function WorkspaceReviewToolbar({
  presentation,
  onPresentationChange,
  supportsFullContext,
  supportsWhitespace,
  rows,
  onJump,
  expanded,
  onToggleExpanded,
  refreshing,
  onRefresh,
  applyCommand,
  loadApplyCommand,
  onOpenGitActions,
  wide,
  singleFile,
  tree,
}: {
  presentation: WorkspaceGitPresentation;
  onPresentationChange: (patch: Partial<WorkspaceGitPresentation>) => void;
  supportsFullContext: boolean;
  supportsWhitespace: boolean;
  rows: PatchChunk[];
  onJump: (key: string) => void;
  expanded: boolean;
  onToggleExpanded: () => void;
  refreshing: boolean;
  onRefresh: () => void;
  applyCommand: string | null;
  loadApplyCommand?: () => Promise<string | null>;
  onOpenGitActions?: () => void;
  wide: boolean;
  singleFile?: boolean;
  tree?: { open: boolean; toggle: () => void };
}) {
  const { locale, t } = useLocale();
  const zh = locale === "zh-CN";
  const [copyState, setCopyState] = useState<"idle" | "ok" | "error">("idle");
  const refresh = t("projectTools.fileTree.refresh");
  const wrap = zh ? "自动换行" : "Word wrap";
  const expand = expanded
    ? zh
      ? "折叠所有差异"
      : "Collapse all diffs"
    : zh
      ? "展开所有差异"
      : "Expand all diffs";
  const currentLayout =
    singleFile && presentation.layout === "auto" ? "unified" : presentation.layout;
  const layout = singleFile && currentLayout === "split" ? "unified" : nextLayout[currentLayout];
  const layoutLabel = {
    auto: zh ? "切换为自动布局" : "Switch to Auto diff",
    split: zh ? "切换为并排视图" : "Switch to split diff",
    unified: zh ? "切换为统一视图" : "Switch to unified diff",
  }[layout];
  const preferences = [
    ["fullContext", File, zh ? "加载完整文件" : "Load full files"],
    ["richPreview", ImageIcon, zh ? "渲染预览" : "Rich preview"],
    ["wordDiffs", DiffSquare, zh ? "词级差异" : "Word diffs"],
    ["hideWhitespace", Eye, zh ? "隐藏空白字符" : "Hide white space"],
    ["hideImports", Package, zh ? "隐藏导入内容" : "Hide imports"],
  ] as const;
  const options = zh ? "变更选项" : "Changes options";
  const treeLabel = tree?.open
    ? zh
      ? "隐藏文件树"
      : "Hide file tree"
    : zh
      ? "显示文件树"
      : "Show file tree";
  return (
    // biome-ignore lint/a11y/useSemanticElements: Floating actions use a named accessibility group.
    <div
      className="za-review-controls"
      role="group"
      aria-label={zh ? "变更工具" : "Changes controls"}
      data-wide={wide || undefined}
      data-single-file-toolbar={singleFile || undefined}
    >
      {singleFile && (
        <TooltipButton
          type="button"
          variant="ghost"
          size="icon-xs"
          className={toolbarIcon}
          aria-label={layoutLabel}
          title={layoutLabel}
          tooltipSide="bottom"
          onClick={() => onPresentationChange({ layout })}
        >
          <ReviewLayoutIcon layout={currentLayout} />
        </TooltipButton>
      )}
      <DropdownMenu>
        <LabelTooltip
          label={options}
          side="bottom"
          render={
            <DropdownMenuTrigger
              type="button"
              className={toolbarIcon}
              aria-label={options}
              aria-busy={refreshing && !wide}
            >
              {refreshing && !wide ? (
                <ReviewGlyph name="refresh" spinning />
              ) : (
                <ReviewGlyph name="more" />
              )}
            </DropdownMenuTrigger>
          }
        />
        <DropdownMenuContent align="end" className="min-w-52">
          {(!wide || singleFile) && (
            <>
              <DropdownMenuItem onSelect={onRefresh} disabled={refreshing}>
                <ReviewGlyph name="refresh" />
                {refresh}
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                checked={presentation.wrapLines}
                closeOnClick
                onCheckedChange={(wrapLines) => onPresentationChange({ wrapLines })}
              >
                <ReviewGlyph name="wrap" />
                {wrap}
              </DropdownMenuCheckboxItem>
              {!singleFile && (
                <DropdownMenuItem onSelect={() => onPresentationChange({ layout })}>
                  <ReviewLayoutIcon layout={currentLayout} />
                  {layoutLabel}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onSelect={onToggleExpanded}>
                <ReviewGlyph name={expanded ? "collapse" : "expand"} />
                {expand}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {preferences.map(([key, Icon, label]) => (
            <DropdownMenuCheckboxItem
              key={key}
              checked={presentation[key]}
              disabled={
                (key === "fullContext" && !supportsFullContext) ||
                (key === "hideWhitespace" && !supportsWhitespace)
              }
              closeOnClick
              onCheckedChange={(checked) => onPresentationChange({ [key]: checked })}
            >
              <Icon className="size-4" />
              {label}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuItem
            disabled={!applyCommand && !loadApplyCommand}
            title={zh ? "在 Git Bash 或兼容 shell 中使用" : "Use in Git Bash or a compatible shell"}
            onSelect={() => {
              void (async () => {
                const command = applyCommand ?? (await loadApplyCommand?.());
                setCopyState(command && (await copyTextToClipboard(command)) ? "ok" : "error");
              })().catch(() => setCopyState("error"));
            }}
          >
            <Copy className="size-4" />
            {zh ? "复制 git apply 命令" : "Copy git apply command"}
          </DropdownMenuItem>
          {onOpenGitActions && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onOpenGitActions}>
                <GitBranch className="size-4" />
                {zh ? "Git 操作" : "Git actions"}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {!singleFile && <ReviewFileJump rows={rows} onJump={onJump} />}
      {!singleFile && (
        <div className="za-review-wide-actions">
          <TooltipButton
            type="button"
            variant="ghost"
            size="icon-xs"
            className={toolbarIcon}
            aria-label={refresh}
            title={refresh}
            tooltipSide="bottom"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <ReviewGlyph name="refresh" spinning={refreshing} />
          </TooltipButton>
          <TooltipButton
            type="button"
            variant="ghost"
            size="icon-xs"
            className={toolbarIcon}
            aria-label={wrap}
            title={wrap}
            tooltipSide="bottom"
            aria-pressed={presentation.wrapLines}
            onClick={() => onPresentationChange({ wrapLines: !presentation.wrapLines })}
          >
            <ReviewGlyph name="wrap" />
          </TooltipButton>
          <TooltipButton
            type="button"
            variant="ghost"
            size="icon-xs"
            className={toolbarIcon}
            aria-label={expand}
            title={expand}
            tooltipSide="bottom"
            onClick={onToggleExpanded}
          >
            <ReviewGlyph name={expanded ? "collapse" : "expand"} />
          </TooltipButton>
          <TooltipButton
            type="button"
            variant="ghost"
            size="icon-xs"
            className={toolbarIcon}
            aria-label={layoutLabel}
            title={layoutLabel}
            tooltipSide="bottom"
            onClick={() => onPresentationChange({ layout })}
          >
            <ReviewLayoutIcon layout={currentLayout} />
          </TooltipButton>
        </div>
      )}
      {!singleFile && tree && (
        <TooltipButton
          type="button"
          variant="ghost"
          size="icon-xs"
          className={toolbarIcon}
          aria-pressed={tree.open}
          data-review-action="files"
          aria-label={treeLabel}
          title={treeLabel}
          tooltipSide="bottom"
          onClick={tree.toggle}
        >
          <ReviewGlyph name="files" />
        </TooltipButton>
      )}
      <span className="sr-only" role="status">
        {copyState === "ok"
          ? zh
            ? "已复制 git apply 命令"
            : "Copied git apply command"
          : copyState === "error"
            ? zh
              ? "无法复制 git apply 命令"
              : "Could not copy git apply command"
            : ""}
      </span>
    </div>
  );
}
