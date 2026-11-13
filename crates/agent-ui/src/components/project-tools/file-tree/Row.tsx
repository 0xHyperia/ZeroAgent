// Memoized virtual-list rows for the right-dock file tree panel.
//
// Shared implementation owned by @liveagent/ui. Host-specific icons, settings
// and backend capabilities resolve through the current application's contracts.

import { ChevronRight, Loader2 } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type CSSProperties,
  memo,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "../../../lib/shared/utils";
import { getFileTypeIcon } from "../../chat/fileTypeIcons";
import { FILE_TREE_ROW_HEIGHT, type FileTreeKind } from "./model";

export type FileTreeRowProps = {
  height?: number;
  path: string;
  name: string;
  kind: FileTreeKind;
  hidden: boolean;
  depth: number;
  expanded: boolean;
  selected: boolean;
  loading: boolean;
  title: string;
  // All callbacks are identity-stable in the panel so memoization holds and
  // an unchanged row never re-renders.
  onToggle: (path: string, expanded: boolean) => void;
  onSelect: (path: string) => void;
  onOpen: (path: string, temporary?: boolean) => void;
  transientFiles?: boolean;
  onContextMenu?: (event: ReactMouseEvent, path: string) => void;
  decoration?: ReactNode;
  changeTone?: "added" | "deleted" | "modified" | "directory";
  sectioned?: boolean;
  onDragStart?: (event: ReactDragEvent, path: string, kind: FileTreeKind) => void;
  onDragEnd?: () => void;
};

export const FileTreeRow = memo(function FileTreeRow(props: FileTreeRowProps) {
  const {
    height = FILE_TREE_ROW_HEIGHT,
    path,
    name,
    kind,
    hidden,
    depth,
    expanded,
    selected,
    loading,
    title,
    onToggle,
    onSelect,
    onOpen,
    transientFiles,
    onContextMenu,
    decoration,
    changeTone,
    sectioned,
    onDragStart,
    onDragEnd,
  } = props;
  const { t } = useLocale();
  const TypeIcon = getFileTypeIcon(path, kind, { expanded });
  const activateRow = () => {
    onSelect(path);
    if (kind === "dir") {
      onToggle(path, expanded);
      return;
    }
    if (transientFiles) onOpen(path, true);
    else onOpen(path);
  };
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={kind === "dir" ? expanded : undefined}
      aria-level={sectioned ? depth + 1 : undefined}
      data-workspace-change-tone={changeTone}
      tabIndex={0}
      className={cn(
        "group flex w-full cursor-pointer select-none items-center rounded-md leading-5",
        "hover:bg-muted/70 hover:text-foreground",
        sectioned
          ? "za-workspace-tree-row gap-[5px] pr-[3px] text-[13px]"
          : "gap-1 pr-2 text-xs text-muted-foreground",
        selected && "bg-muted text-foreground",
      )}
      style={
        sectioned
          ? ({ height, "--za-workspace-tree-depth": depth } as CSSProperties)
          : { height, paddingLeft: 6 + depth * 14 }
      }
      title={title}
      draggable={Boolean(onDragStart)}
      onDragStart={(event) => onDragStart?.(event, path, kind)}
      onDragEnd={onDragEnd}
      onClick={(event) => {
        if (!transientFiles || kind === "dir" || event.detail < 2) activateRow();
      }}
      onDoubleClick={transientFiles && kind === "file" ? () => onOpen(path, false) : undefined}
      onKeyDown={(event) => {
        if (event.currentTarget !== event.target || (event.key !== "Enter" && event.key !== " "))
          return;
        event.preventDefault();
        activateRow();
      }}
      onContextMenu={onContextMenu ? (event) => onContextMenu(event, path) : undefined}
    >
      {kind === "dir" ? (
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center justify-center rounded hover:bg-background",
            sectioned ? "size-4" : "size-5",
            hidden && "opacity-60 group-hover:opacity-80",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(path, expanded);
          }}
          title={expanded ? t("projectTools.fileTree.collapse") : t("projectTools.fileTree.expand")}
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ChevronRight
              className={cn(
                "size-3.5 transition-transform",
                changeTone === "directory" && "text-muted-foreground",
                expanded && "rotate-90",
              )}
            />
          )}
        </button>
      ) : !changeTone ? (
        <span className={cn("shrink-0", sectioned ? "size-4" : "size-5")} />
      ) : null}
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center bg-transparent p-0",
          "text-left text-inherit leading-5",
          sectioned ? "gap-[5px]" : "gap-1.5",
          hidden && "opacity-60 group-hover:opacity-80",
        )}
      >
        {changeTone !== "directory" && (
          <TypeIcon className={cn("shrink-0", sectioned ? "size-4" : "size-3.5")} />
        )}
        <span className={cn("min-w-0", changeTone ? "za-workspace-tree-change-name" : "truncate")}>
          {name}
        </span>
      </div>
      {decoration}
    </div>
  );
});

export type FileTreeErrorRowProps = {
  depth: number;
  message: string;
};

// Per-directory error/notice line rendered as its own (measured) virtual row.
export const FileTreeErrorRow = memo(function FileTreeErrorRow(props: FileTreeErrorRowProps) {
  const { depth, message } = props;
  return (
    <div
      className="break-all px-3 py-1 text-xs text-amber-600"
      style={{ paddingLeft: 12 + depth * 14 }}
    >
      {message}
    </div>
  );
});
