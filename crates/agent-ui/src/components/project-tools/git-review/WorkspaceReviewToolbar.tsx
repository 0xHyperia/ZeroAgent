import { useRef, useState } from "react";
import WrapText from "~icons/lucide/wrap-text";
import { useLocale } from "../../../i18n";
import { copyTextToClipboard } from "../../../lib/shared/clipboard";
import { getFileTypeIcon } from "../../chat/fileTypeIcons";
import {
  Columns2,
  Copy,
  DiffSquare,
  Eye,
  File,
  FoldVertical,
  GitBranch,
  ImageIcon,
  List,
  MoreHorizontal,
  Package,
  RefreshCw,
  Search,
} from "../../IconSet";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "../../ui/popover";
import type { WorkspaceGitPresentation } from "../workspaceGitReviewState";
import type { PatchChunk } from "./model";

const toolbarIcon = "za-review-icon";
const nextLayout = { unified: "split", split: "auto", auto: "unified" } as const;

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
      <PopoverTrigger
        className={toolbarIcon}
        aria-label={title}
        title={title}
        disabled={!rows.length}
      >
        <Search className="size-4" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        initialFocus={inputRef}
        className="max-w-[calc(100vw-1rem)] p-1.5"
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
  onOpenGitActions,
  wide,
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
  onOpenGitActions?: () => void;
  wide: boolean;
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
  const layout = nextLayout[presentation.layout];
  const layoutLabel = {
    auto: zh ? "切换为自动布局" : "Switch to Auto diff",
    split: zh ? "切换为并排视图" : "Switch to split diff",
    unified: zh ? "切换为统一视图" : "Switch to unified diff",
  }[layout];
  const LayoutIcon =
    presentation.layout === "auto" ? DiffSquare : presentation.layout === "split" ? Columns2 : List;
  const ExpandIcon = expanded ? FoldVertical : List;
  const preferences = [
    ["fullContext", File, zh ? "加载完整文件" : "Load full files"],
    ["richPreview", ImageIcon, zh ? "渲染预览" : "Rich preview"],
    ["wordDiffs", DiffSquare, zh ? "词级差异" : "Word diffs"],
    ["hideWhitespace", Eye, zh ? "隐藏空白字符" : "Hide white space"],
    ["hideImports", Package, zh ? "隐藏导入内容" : "Hide imports"],
  ] as const;
  const options = zh ? "变更选项" : "Changes options";
  return (
    <div className="za-review-controls">
      <DropdownMenu>
        <DropdownMenuTrigger
          type="button"
          className={toolbarIcon}
          aria-label={options}
          title={options}
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {!wide && (
            <>
              <DropdownMenuItem onSelect={onRefresh} disabled={refreshing}>
                <RefreshCw className="size-4" />
                {refresh}
              </DropdownMenuItem>
              <DropdownMenuCheckboxItem
                checked={presentation.wrapLines}
                closeOnClick
                onCheckedChange={(wrapLines) => onPresentationChange({ wrapLines })}
              >
                <WrapText className="size-4" />
                {wrap}
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem onSelect={onToggleExpanded}>
                <ExpandIcon className="size-4" />
                {expand}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onPresentationChange({ layout })}>
                <LayoutIcon className="size-4" />
                {layoutLabel}
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
            disabled={!applyCommand}
            title={zh ? "在 Git Bash 或兼容 shell 中使用" : "Use in Git Bash or a compatible shell"}
            onSelect={() => {
              if (!applyCommand) return;
              void copyTextToClipboard(applyCommand).then((ok) =>
                setCopyState(ok ? "ok" : "error"),
              );
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
      <ReviewFileJump rows={rows} onJump={onJump} />
      <div className="za-review-wide-actions">
        <button
          type="button"
          className={toolbarIcon}
          aria-label={refresh}
          title={refresh}
          disabled={refreshing}
          onClick={onRefresh}
        >
          <RefreshCw className={refreshing ? "size-4 animate-spin" : "size-4"} />
        </button>
        <button
          type="button"
          className={toolbarIcon}
          aria-label={wrap}
          title={wrap}
          aria-pressed={presentation.wrapLines}
          onClick={() => onPresentationChange({ wrapLines: !presentation.wrapLines })}
        >
          <WrapText className="size-4" />
        </button>
        <button
          type="button"
          className={toolbarIcon}
          aria-label={expand}
          title={expand}
          onClick={onToggleExpanded}
        >
          <ExpandIcon className="size-4" />
        </button>
        <button
          type="button"
          className={toolbarIcon}
          aria-label={layoutLabel}
          title={layoutLabel}
          onClick={() => onPresentationChange({ layout })}
        >
          <LayoutIcon className="size-4" />
        </button>
      </div>
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
