import "@liveagent/ui/i18n/namespaces/projectTools";
import {
  ContextMenuCheckboxItem,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
} from "@liveagent/ui/components/ui/context-menu";
import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";
import { COPY_FEEDBACK_DURATION, useCopyFeedback } from "@liveagent/ui/lib/shared/useCopyFeedback";
// Context menu for the right-dock file tree panel.
//
// Shared implementation owned by @liveagent/ui. Host-specific icons, settings
// and backend capabilities resolve through the current application's contracts.
// Desktop-only entries are gated at runtime via FILE_TREE_HAS_OS_INTEGRATION.

import {
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  FilePenLine,
  Folder,
  FolderOpen,
  Plus,
  RefreshCw,
  SquarePen,
  Trash2,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { type MouseEvent as ReactMouseEvent, type RefObject, useCallback, useState } from "react";
import {
  isWorkspaceEditablePreviewPath,
  isWorkspacePreviewPath,
} from "../../workspace-editor/workspaceImagePreview";
import { dirname, FILE_TREE_HAS_OS_INTEGRATION, type FileTreeKind } from "./model";

export type FileTreeContextMenuProps = {
  // Anchor relative to the panel (containerRef) coordinate space.
  anchor: { x: number; y: number };
  containerRef: RefObject<HTMLDivElement | null>;
  trigger?: HTMLButtonElement | null;
  path: string;
  displayPath?: string;
  kind: FileTreeKind;
  canMutate: boolean;
  canOpenFile: boolean;
  canInsertMention: boolean;
  showHidden: boolean;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenExternal: (path: string) => void;
  onOpenContainingDirectory: (path: string) => void;
  onStartAction: (action: "file" | "folder" | "rename", path: string) => void;
  onDelete: (path: string) => void;
  onInsertMention: (path: string, kind: FileTreeKind) => void;
  onRefresh: (path: string, kind: FileTreeKind) => void;
  onToggleHidden: () => void;
  onActionError: (message: string) => void;
};

export function FileTreeContextMenu(props: FileTreeContextMenuProps) {
  const {
    anchor,
    containerRef,
    trigger,
    path,
    displayPath,
    kind,
    canMutate,
    canOpenFile,
    canInsertMention,
    showHidden,
    onClose,
    onOpenFile,
    onOpenExternal,
    onOpenContainingDirectory,
    onStartAction,
    onDelete,
    onInsertMention,
    onRefresh,
    onToggleHidden,
    onActionError,
  } = props;
  const { t } = useLocale();
  const [closingForEscape, setClosingForEscape] = useState(false);

  const { copied, showCopied } = useCopyFeedback(false, COPY_FEEDBACK_DURATION.short);

  const hasPathAction = Boolean(path);
  const targetDirectory = kind === "dir" ? path : dirname(path);

  const handleCopy = useCallback(
    async (event: ReactMouseEvent) => {
      // Keep the copied feedback visible until the user dismisses the menu.
      event.stopPropagation();
      const pathToCopy = displayPath ?? path;
      if (!pathToCopy) return;
      const copiedOk = await copyTextToClipboard(pathToCopy);
      if (!copiedOk) {
        onActionError(t("projectTools.fileTree.copyFailed"));
        onClose();
        return;
      }
      showCopied(true);
    },
    [displayPath, onActionError, onClose, path, t, showCopied],
  );

  return (
    <ContextMenuPopup
      point={anchor}
      coordinateRoot={containerRef}
      open={!closingForEscape}
      onClose={(reason) => {
        if (reason === "escape-key" && trigger) setClosingForEscape(true);
        else onClose();
      }}
      onOpenChangeComplete={(open) => {
        if (!open && closingForEscape) {
          onClose();
          // The enclosing sheet can first reclaim focus from the removed menu.
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const focused = trigger?.ownerDocument.activeElement;
              if (
                focused === trigger?.ownerDocument.body ||
                focused === trigger?.closest('[role="dialog"]')
              )
                trigger?.focus({ preventScroll: true });
            });
          });
        }
      }}
      portalContainer={containerRef.current?.closest<HTMLElement>('[data-slot="sheet-popup"]')}
      finalFocus={trigger ? false : undefined}
      className="min-w-[min(13rem,var(--available-width,100vw))] max-w-[min(18rem,var(--available-width,100vw))] overscroll-contain text-xs"
    >
      {kind === "file" ? (
        <>
          <ContextMenuItem
            disabled={!canOpenFile}
            onClick={() => {
              onOpenFile(path);
              onClose();
            }}
          >
            {isWorkspacePreviewPath(path) ? (
              <Eye className="size-3.5" />
            ) : (
              <FilePenLine className="size-3.5" />
            )}
            {t(
              isWorkspacePreviewPath(path)
                ? "projectTools.fileTree.previewFile"
                : "projectTools.fileTree.openFile",
            )}
          </ContextMenuItem>
          {FILE_TREE_HAS_OS_INTEGRATION && !isWorkspaceEditablePreviewPath(path) ? (
            <ContextMenuItem
              disabled={!hasPathAction}
              onClick={() => {
                onOpenExternal(path);
                onClose();
              }}
            >
              <ExternalLink className="size-3.5" />
              {t("projectTools.fileTree.openExternal")}
            </ContextMenuItem>
          ) : null}
          <ContextMenuSeparator />
        </>
      ) : null}
      <ContextMenuItem
        disabled={!canMutate}
        onClick={() => {
          onStartAction("file", targetDirectory);
          onClose();
        }}
      >
        <Plus className="size-3.5" />
        {t("projectTools.fileTree.newFile")}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!canMutate}
        onClick={() => {
          onStartAction("folder", targetDirectory);
          onClose();
        }}
      >
        <Folder className="size-3.5" />
        {t("projectTools.fileTree.newFolder")}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!canMutate || !hasPathAction}
        onClick={() => {
          onStartAction("rename", path);
          onClose();
        }}
      >
        <SquarePen className="size-3.5" />
        {t("projectTools.fileTree.rename")}
      </ContextMenuItem>
      <ContextMenuItem
        className="text-destructive data-[highlighted]:bg-destructive/10 data-[highlighted]:text-destructive"
        disabled={!canMutate || !hasPathAction}
        onClick={() => {
          onDelete(path);
          onClose();
        }}
      >
        <Trash2 className="size-3.5" />
        {t("projectTools.fileTree.delete")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuCheckboxItem
        className="za-menu-item"
        checked={showHidden}
        onCheckedChange={onToggleHidden}
      >
        {showHidden ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        {t(
          showHidden
            ? "projectTools.fileTree.hideHiddenFiles"
            : "projectTools.fileTree.showHiddenFiles",
        )}
      </ContextMenuCheckboxItem>
      <ContextMenuItem
        closeOnClick={false}
        disabled={!hasPathAction}
        onClick={(event) => void handleCopy(event)}
      >
        <Copy className="size-3.5" />
        {copied ? t("projectTools.fileTree.copiedPath") : t("projectTools.fileTree.copyPath")}
      </ContextMenuItem>
      {FILE_TREE_HAS_OS_INTEGRATION ? (
        <ContextMenuItem
          disabled={!hasPathAction}
          onClick={() => {
            onOpenContainingDirectory(path);
            onClose();
          }}
        >
          <FolderOpen className="size-3.5" />
          {t("projectTools.fileTree.openContainingDirectory")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        disabled={!hasPathAction || !canInsertMention}
        onClick={() => {
          onInsertMention(path, kind);
          onClose();
        }}
      >
        <span className="flex size-3.5 items-center justify-center text-xs font-semibold">@</span>
        {t("projectTools.fileTree.insertReference")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        onClick={() => {
          onRefresh(path, kind);
          onClose();
        }}
      >
        <RefreshCw className="size-3.5" />
        {t("projectTools.fileTree.refresh")}
      </ContextMenuItem>
    </ContextMenuPopup>
  );
}
