import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { getFileTypeIcon } from "@liveagent/ui/components/chat/fileTypeIcons";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FolderOpen,
  Github,
} from "@liveagent/ui/components/IconSet";
import type { FileTreeEntry } from "@liveagent/ui/components/project-tools/file-tree/model";
import {
  encodeGitHubPath,
  normalizeGitHubRepositoryUrl,
} from "@liveagent/ui/components/project-tools/git-review/model";
import {
  workspaceGitPathFromRoot,
  workspaceGitRelativePath,
} from "@liveagent/ui/components/project-tools/workspaceGitPaths";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { LabelTooltip } from "@liveagent/ui/components/ui/label-tooltip";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import { localEditorFileIo } from "@liveagent/ui/components/workspace-editor/workspaceEditorFileIo";
import {
  isWorkspaceEditablePreviewPath,
  isWorkspacePreviewPath,
} from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import {
  workspaceImageAbsolutePathForCopy,
  workspaceImageRelativePathForCopy,
} from "@liveagent/ui/components/workspace-editor/workspaceImageViewer";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { GitClient, GitRepositoryState } from "@liveagent/ui/lib/git/types";
import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";
import { invokeFs } from "@liveagent/ui/lib/tools/fsBackend";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import AndroidIcon from "~icons/logos/android-icon";
import GitIcon from "~icons/logos/git-icon";
import WslIcon from "~icons/logos/linux-tux";
import PyCharmIcon from "~icons/logos/pycharm";
import TerminalIcon from "~icons/logos/terminal";
import VisualStudioIcon from "~icons/logos/visual-studio";
import VSCodeIcon from "~icons/logos/visual-studio-code";
import FileSearchIcon from "~icons/lucide/file-search-2";
import FoldersIcon from "~icons/lucide/folders";
import CursorIcon from "~icons/material-icon-theme/cursor";
import type { WorkspaceFileRequest } from "./useDesktopWorkspaceTabs";
import "./desktop-workspace-file-header.css";

export function workspaceFileName(path: string) {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[/\\]/)
      .at(-1) || path
  );
}

function fileRepositoryDetails(request: WorkspaceFileRequest, repository: GitRepositoryState) {
  if (repository.status !== "ready") return null;
  const absolute = workspaceGitPathFromRoot(request.workdir, request.path);
  const relative = absolute && workspaceGitRelativePath(repository.repoRoot, absolute);
  if (!relative) return null;
  const remote = normalizeGitHubRepositoryUrl(repository.remoteUrl);
  const trackedPrefix = repository.remoteName ? `${repository.remoteName}/` : "";
  const branch =
    trackedPrefix && repository.upstream.startsWith(trackedPrefix)
      ? repository.upstream.slice(trackedPrefix.length)
      : "";
  const github =
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(remote) &&
    branch &&
    !repository.entries.some(
      (entry) => entry.path === relative && (entry.untracked || entry.indexStatus === "A"),
    )
      ? `${remote}/blob/${encodeURIComponent(branch)}/${encodeGitHubPath(relative)}${request.line ? `#L${request.line}${request.endLine && request.endLine > request.line ? `-L${request.endLine}` : ""}` : ""}`
      : "";
  return { relative, github };
}

type DirectorySnapshot = {
  entries: FileTreeEntry[];
  error?: boolean;
  hasMore?: boolean;
};

const DEFAULT_OPEN_TARGET = { id: "default", label: "Default app", Icon: FolderOpen } as const;
const WORKSPACE_OPEN_TARGETS = [
  { id: "vscode", label: "VS Code", Icon: VSCodeIcon },
  { id: "visual-studio", label: "Visual Studio", Icon: VisualStudioIcon },
  { id: "vscode-insiders", label: "VS Code Insiders", Icon: VSCodeIcon },
  { id: "cursor", label: "Cursor", Icon: CursorIcon },
  DEFAULT_OPEN_TARGET,
  { id: "terminal", label: "Terminal", Icon: TerminalIcon, directory: true },
  { id: "git-bash", label: "Git Bash", Icon: GitIcon, directory: true },
  { id: "wsl", label: "WSL", Icon: WslIcon, directory: true },
  { id: "android-studio", label: "Android Studio", Icon: AndroidIcon },
  { id: "pycharm", label: "PyCharm", Icon: PyCharmIcon },
] as const;
const WORKSPACE_OPEN_TARGET_KEY = "zeroagent.workspace.openTarget";

function preferredOpenTarget() {
  try {
    return window.localStorage.getItem(WORKSPACE_OPEN_TARGET_KEY);
  } catch {
    return null;
  }
}

const FILE_TOOLBAR_COMPACT_WIDTH = 625;

function isWithinDirectory(path: string, directory: string) {
  const expectedPrefix = directory ? `${directory}/` : "";
  if (!path.startsWith(expectedPrefix)) return false;
  const name = path.slice(expectedPrefix.length);
  return Boolean(name && name !== "." && name !== ".." && !/[/\\]/.test(name));
}

function BreadcrumbDirectory({
  workdir,
  directory,
  currentFile,
  depth = 0,
  onOpenFile,
}: {
  workdir: string;
  directory: string;
  currentFile: string;
  depth?: number;
  onOpenFile: (path: string) => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [snapshot, setSnapshot] = useState<DirectorySnapshot>();
  const [expanded, setExpanded] = useState(() => new Map<string, boolean>());
  const selected = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    void invokeFs<{ entries: FileTreeEntry[]; hasMore?: boolean }>("fs_list", {
      workdir,
      path: directory || undefined,
      depth: 1,
      offset: 0,
      max_results: 200,
      show_hidden: true,
    }).then(
      ({ entries, hasMore }) => {
        if (cancelled) return;
        setSnapshot({
          hasMore,
          entries: entries
            .map((entry) => ({ ...entry, path: entry.path.replace(/\\/g, "/") }))
            .filter((entry) => isWithinDirectory(entry.path, directory))
            .sort((left, right) =>
              left.kind === right.kind
                ? workspaceFileName(left.path).localeCompare(
                    workspaceFileName(right.path),
                    locale,
                    {
                      numeric: true,
                    },
                  )
                : left.kind === "dir"
                  ? -1
                  : 1,
            ),
        });
      },
      () => {
        if (!cancelled) setSnapshot({ entries: [], error: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [workdir, directory, locale]);

  useLayoutEffect(() => {
    const entry = selected.current;
    const panel = entry?.closest<HTMLElement>("[data-workspace-breadcrumb-picker]");
    if (!snapshot || !entry || !panel) return;
    const { top, height } = entry.getBoundingClientRect();
    panel.scrollTop += top - panel.getBoundingClientRect().top - (panel.clientHeight - height) / 2;
  }, [snapshot]);

  const notice = !snapshot
    ? zh
      ? "正在读取…"
      : "Loading…"
    : snapshot.error
      ? zh
        ? "无法读取文件夹"
        : "Could not read folder"
      : snapshot.hasMore
        ? zh
          ? "仅显示前 200 项"
          : "Showing the first 200 items"
        : snapshot.entries.length === 0
          ? zh
            ? "文件夹为空"
            : "Folder is empty"
          : null;
  return (
    <>
      {snapshot?.entries.map((entry) => {
        const folder = entry.kind === "dir";
        const open = folder && (expanded.get(entry.path) ?? currentFile.startsWith(`${entry.path}/`));
        const active = entry.path === currentFile;
        const Icon = folder ? ChevronRight : getFileTypeIcon(entry.path, "file");
        return (
          <div key={entry.path}>
            <button
              ref={active ? selected : undefined}
              type="button"
              className="za-breadcrumb-entry"
              style={{ paddingInlineStart: 5 + depth * 12 }}
              aria-current={active ? "page" : undefined}
              aria-expanded={folder ? open : undefined}
              onClick={() => {
                if (!folder) {
                  onOpenFile(entry.path);
                  return;
                }
                setExpanded((previous) => new Map(previous).set(entry.path, !open));
              }}
            >
              <Icon
                aria-hidden="true"
                className={folder ? "za-breadcrumb-chevron size-3" : "size-4 shrink-0"}
              />
              <span className="min-w-0 truncate">{workspaceFileName(entry.path)}</span>
            </button>
            {open && (
              <BreadcrumbDirectory
                workdir={workdir}
                directory={entry.path}
                currentFile={currentFile}
                depth={depth + 1}
                onOpenFile={onOpenFile}
              />
            )}
          </div>
        );
      })}
      {notice && (
        <p role="status" className="px-2 py-1.5 text-xs text-muted-foreground">
          {notice}
        </p>
      )}
    </>
  );
}

function WorkspaceBreadcrumbs({
  request,
  active,
  onOpenFile,
}: {
  request: WorkspaceFileRequest;
  active: boolean;
  onOpenFile: (path: string) => void;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const relative = workspaceImageRelativePathForCopy(request.workdir, request.path);
  const isLocal = !request.remote && !/^(?:[/\\]|[a-z]:)/i.test(relative);
  const parts = relative.split("/").filter((part) => part && part !== ".");
  const pathRef = useRef<HTMLElement>(null);
  const [firstVisible, setFirstVisible] = useState(0);
  const breadcrumbId = useId();
  const [picker, setPicker] = useState<{ id: string; index: number; directory: string } | null>(
    null,
  );
  const pickerIndex = picker?.index ?? -1;
  const pickerOpen = active && picker !== null && pickerIndex >= firstVisible;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Path changes can replace observed DOM nodes.
  useLayoutEffect(() => {
    const nav = pathRef.current;
    const list = nav?.querySelector("ol");
    if (!active || !nav || !list) return;
    const segments = Array.from(list.children);
    const measure = () => {
      const width = nav.clientWidth;
      if (!width) return;
      const style = getComputedStyle(list);
      const gap = parseFloat(style.columnGap) || 0;
      let room =
        width -
        list.clientLeft * 2 -
        (parseFloat(style.paddingInlineStart) || 0) -
        (parseFloat(style.paddingInlineEnd) || 0);
      const filename = segments.at(-1)?.firstElementChild;
      room -=
        filename instanceof HTMLElement
          ? filename.scrollWidth
          : (segments.at(-1)?.getBoundingClientRect().width ?? 0);
      let start = segments.length - 1;
      while (start > 0) {
        const required = segments[start - 1].getBoundingClientRect().width + gap;
        if (required > room) break;
        room -= required;
        start -= 1;
      }
      setFirstVisible(Math.max(0, start));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    for (const segment of segments) observer.observe(segment);
    measure();
    return () => observer.disconnect();
  }, [active, relative, request.workdir]);
  useLayoutEffect(() => {
    if (!active || (pickerIndex >= 0 && pickerIndex < firstVisible)) setPicker(null);
  }, [active, firstVisible, pickerIndex]);
  if (!isLocal || parts.includes("..")) {
    return (
      <LabelTooltip
        label={request.path}
        side="bottom"
        render={
          <span className="za-workspace-file-path-label">{workspaceFileName(request.path)}</span>
        }
      />
    );
  }
  return (
    <Popover
      open={pickerOpen}
      triggerId={picker?.id}
      onOpenChange={(open, details) => {
        if (!open) {
          setPicker(null);
          return;
        }
        const trigger = details.trigger;
        const directory = trigger?.getAttribute("data-directory");
        if (trigger && directory != null) {
          setPicker({
            id: trigger.id,
            index: Number(trigger.getAttribute("data-breadcrumb-index")),
            directory,
          });
        }
      }}
    >
      <nav
        ref={pathRef}
        className="za-workspace-file-path"
        aria-label={zh ? "文件路径" : "File path"}
      >
        <ol>
          {[workspaceFileName(request.workdir), ...parts].map((part, index) => {
            const last = index === parts.length;
            const segment = parts.slice(0, index).join("/");
            const path = last ? parts.slice(0, -1).join("/") : segment;
            const label = zh ? `浏览 ${part}` : `Browse ${part}`;
            return (
              <li
                className="za-workspace-file-path-segment"
                data-collapsed={index < firstVisible ? "" : undefined}
                inert={index < firstVisible || undefined}
                key={segment}
              >
                <LabelTooltip
                  label={last ? relative : part}
                  side="bottom"
                  disabled={pickerOpen}
                  render={
                    <PopoverTrigger
                      type="button"
                      id={`${breadcrumbId}-${index}`}
                      data-breadcrumb-index={index}
                      data-directory={path}
                      className="za-workspace-file-path-label"
                      aria-label={label}
                      aria-current={last ? "page" : undefined}
                    >
                      {part}
                    </PopoverTrigger>
                  }
                />
                {!last && (
                  <ChevronRight
                    aria-hidden="true"
                    className="size-2.5 shrink-0 text-muted-foreground"
                  />
                )}
              </li>
            );
          })}
        </ol>
      </nav>
      <PopoverContent
        align="start"
        className="za-breadcrumb-picker"
        aria-label={zh ? "选择文件" : "Choose file"}
        data-workspace-breadcrumb-picker=""
        onKeyDown={(event) => {
          const { key, currentTarget, target } = event;
          if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
          const rows = [
            ...currentTarget.querySelectorAll<HTMLButtonElement>(".za-breadcrumb-entry"),
          ];
          const current = target instanceof HTMLButtonElement ? rows.indexOf(target) : -1;
          const next =
            key === "Home"
              ? 0
              : key === "End"
                ? rows.length - 1
                : key === "ArrowDown"
                  ? Math.min(current + 1, rows.length - 1)
                  : Math.max(current - 1, 0);
          if (!rows[next]) return;
          event.preventDefault();
          rows[next].focus();
        }}
      >
        {picker && (
          <BreadcrumbDirectory
            key={picker.directory}
            workdir={request.workdir}
            directory={picker.directory}
            currentFile={relative}
            onOpenFile={(path) => {
              setPicker(null);
              onOpenFile(path);
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

export function DesktopWorkspaceFileHeader({
  active,
  request,
  modeActions,
  viewAction,
  comparisonActions,
  fileTree,
  editorTools,
  setFormatTools,
  onOpenFile,
  onError,
  readDraft,
  beforeOpen,
  gitClient,
}: {
  active: boolean;
  request: WorkspaceFileRequest;
  modeActions: ReactNode;
  viewAction?: ReactNode;
  comparisonActions?: ReactNode;
  fileTree?: { open: boolean; toggle: () => void };
  editorTools?: boolean;
  setFormatTools: (element: HTMLDivElement | null) => void;
  onOpenFile: (path: string) => void;
  onError: (message: string) => void;
  readDraft: () => string | undefined;
  beforeOpen: () => Promise<boolean>;
  gitClient?: GitClient;
}) {
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const absolutePath = workspaceImageAbsolutePathForCopy(request.workdir, request.path);
  const relativePath = workspaceImageRelativePathForCopy(request.workdir, request.path);
  const header = useRef<HTMLElement | null>(null);
  const activeRequest = useRef<WorkspaceFileRequest | null>(null);
  const [compact, setCompact] = useState(false);
  const [formatTools, setFormatToolsNode] = useState<HTMLDivElement | null>(null);
  const [hasFormatTools, setHasFormatTools] = useState(false);
  const [formatOpen, setFormatOpen] = useState(false);
  const [openWith, setOpenWith] = useState(false);
  const [editorTargets, setEditorTargets] = useState<string[]>([]);
  const [preferredTarget, setPreferredTarget] = useState(preferredOpenTarget);
  const [repository, setRepository] = useState<GitRepositoryState | null>(null);
  const details = repository && fileRepositoryDetails(request, repository);
  const openTargets = WORKSPACE_OPEN_TARGETS.filter(
    ({ id }) => id === "default" || editorTargets.includes(id),
  );
  const editable =
    !isWorkspacePreviewPath(request.path) || isWorkspaceEditablePreviewPath(request.path);
  const primaryTarget =
    openTargets.find(({ id }) => id === preferredTarget) ??
    (editable
      ? openTargets.find((target) => target.id !== "default" && !("directory" in target))
      : undefined) ??
    DEFAULT_OPEN_TARGET;
  const comparing = Boolean(comparisonActions);
  const relative = details?.relative ?? relativePath;
  const canCopyRelative = Boolean(relative && !/^(?:[/\\]|[a-z]:)/i.test(relative));
  const formatToolsRef = useCallback(
    (element: HTMLDivElement | null) => {
      setFormatToolsNode(element);
      setFormatTools(element);
    },
    [setFormatTools],
  );
  useLayoutEffect(() => {
    activeRequest.current = active ? request : null;
    return () => {
      activeRequest.current = null;
    };
  }, [active, request]);
  useLayoutEffect(() => {
    const node = header.current;
    if (!active || !node) return;
    const apply = (width: number) => setCompact(width > 0 && width < FILE_TOOLBAR_COMPACT_WIDTH);
    apply(node.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) apply(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    if (!formatTools) return;
    const update = () => {
      const present = formatTools.childElementCount > 0;
      setHasFormatTools(present);
      if (!present) setFormatOpen(false);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(formatTools, { childList: true });
    return () => observer.disconnect();
  }, [formatTools]);
  useEffect(() => {
    if (!active || !openWith || !gitClient || request.remote) return;
    let listening = true;
    void gitClient.status(request.workdir).then(
      (next) => {
        if (listening) setRepository(next);
      },
      () => {
        if (listening) setRepository(null);
      },
    );
    return () => {
      listening = false;
    };
  }, [active, gitClient, openWith, request.remote, request.workdir]);
  useEffect(() => {
    if (!active || request.remote) return;
    setPreferredTarget(preferredOpenTarget());
    let listening = true;
    void invokeFs<string[]>("fs_workspace_editor_targets", {}).then(
      (targets) => {
        if (listening) setEditorTargets(targets);
      },
      () => {
        if (listening) setEditorTargets([]);
      },
    );
    return () => {
      listening = false;
    };
  }, [active, request.remote]);
  useEffect(() => {
    if (!active) {
      setFormatOpen(false);
      setOpenWith(false);
      setRepository(null);
      setEditorTargets([]);
    }
  }, [active]);
  useEffect(() => {
    if (!compact) setFormatOpen(false);
  }, [compact]);
  useEffect(() => setFormatOpen(false), [comparing]);
  const openFileLabel = copy("在默认应用中打开", "Open in default application");
  const openPrimaryLabel =
    primaryTarget.id === "default"
      ? openFileLabel
      : copy(`在 ${primaryTarget.label} 中打开`, `Open in ${primaryTarget.label}`);
  const rememberTarget = (id: string) => {
    setPreferredTarget(id);
    try {
      window.localStorage.setItem(WORKSPACE_OPEN_TARGET_KEY, id);
    } catch {
      // The selected target remains usable for this tab without storage.
    }
  };
  const open = async (mode: "open" | "reveal", remember = false) => {
    try {
      if (mode === "open" && !(await beforeOpen())) return;
      await invokeFs("fs_open_workspace_path", {
        workdir: request.workdir,
        path: request.path,
        mode,
      });
      if (remember) rememberTarget("default");
    } catch {
      onError(copy("无法打开文件", "Could not open the file"));
    }
  };
  const saveCopy = async () => {
    try {
      if (!(await beforeOpen()) || activeRequest.current !== request) return;
      await invokeFs("fs_save_workspace_copy", { workdir: request.workdir, path: request.path });
    } catch {
      onError(copy("无法另存文件", "Could not save a copy of the file"));
    }
  };
  const copyContents = async () => {
    try {
      const content = readDraft() ?? (await localEditorFileIo.read(request)).content;
      if (await copyTextToClipboard(content)) return;
    } catch {
      // Use the same recovery for unavailable file contents and clipboard failures.
    }
    onError(copy("无法复制文件内容", "Could not copy file contents"));
  };
  const openEditor = async (id: string, remember = false) => {
    try {
      if (!(await beforeOpen())) return;
      await invokeFs("fs_open_workspace_editor", {
        workdir: request.workdir,
        path: request.path,
        editor: id,
        line: request.line,
        column: request.column,
      });
      if (remember) rememberTarget(id);
    } catch {
      onError(copy("无法在此编辑器中打开文件", "Could not open the file in this editor"));
    }
  };
  const copyPath = (path: string) => {
    void copyTextToClipboard(path).then((copied) => {
      if (!copied) onError(copy("无法复制文件路径", "Could not copy the file path"));
    });
  };
  const copyRelativePath = async () => {
    const state = repository ?? (await gitClient?.status(request.workdir).catch(() => null));
    if (activeRequest.current !== request) return;
    const repositoryPath = state && fileRepositoryDetails(request, state)?.relative;
    copyPath(repositoryPath || relativePath);
  };
  const formatLabel = copy("文件控件", "File controls");
  const fileOptionsLabel = copy("文件选项", "File options");
  const treeLabel = copy("切换文件树", "Toggle file tree");
  const overflowTools = compact || editorTools;
  const fileControlLabel = overflowTools && hasFormatTools ? formatLabel : fileOptionsLabel;
  const openWithLabel = copy("打开方式", "Open with");
  const runFileOption = (action: () => void | Promise<void>) => {
    setFormatOpen(false);
    void action();
  };
  const fileOptionClass =
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-muted focus-visible:bg-muted";
  return (
    <header
      ref={header}
      className="za-workspace-file-header"
      data-desktop-workspace-file-header=""
      data-comparison={comparing || undefined}
    >
      <WorkspaceBreadcrumbs request={request} active={active} onOpenFile={onOpenFile} />
      <div className="za-workspace-file-actions">
        {modeActions && <div className="za-workspace-file-mode-actions">{modeActions}</div>}
        <div className="za-workspace-file-tool-group" role="group" aria-label={formatLabel}>
          <Popover open={active && formatOpen} onOpenChange={setFormatOpen}>
            <LabelTooltip
              label={fileControlLabel}
              side="bottom"
              disabled={formatOpen}
              render={
                <PopoverTrigger
                  hidden={Boolean(
                    request.remote &&
                      (!overflowTools || !hasFormatTools) &&
                      !(comparing && viewAction),
                  )}
                  aria-label={fileControlLabel}
                  render={<Button type="button" size="icon-xs" variant="ghost" />}
                >
                  <FileSearchIcon aria-hidden="true" className="size-4" />
                </PopoverTrigger>
              }
            />
            <PopoverContent
              keepMounted
              align="end"
              className="w-fit min-w-44 max-w-[calc(100vw-16px)] p-1.5"
              aria-label={formatLabel}
            >
              {!request.remote && (
                <div>
                  <button
                    type="button"
                    className={fileOptionClass}
                    onClick={() => runFileOption(() => copyPath(absolutePath))}
                  >
                    <Copy className="size-4" /> {copy("复制路径", "Copy path")}
                  </button>
                  {canCopyRelative && (
                    <button
                      type="button"
                      className={fileOptionClass}
                      onClick={() => runFileOption(copyRelativePath)}
                    >
                      <Copy className="size-4" /> {copy("复制相对路径", "Copy relative path")}
                    </button>
                  )}
                  {editable && (
                    <button
                      type="button"
                      className={fileOptionClass}
                      onClick={() => runFileOption(copyContents)}
                    >
                      <Copy className="size-4" /> {copy("复制文件内容", "Copy file contents")}
                    </button>
                  )}
                </div>
              )}
              {comparing && viewAction && (
                <div className="za-workspace-file-diff-view-action">{viewAction}</div>
              )}
              {overflowTools && (
                <div
                  ref={formatToolsRef}
                  className="za-workspace-file-format-tools za-workspace-file-format-popover"
                />
              )}
            </PopoverContent>
          </Popover>
          {!comparing && viewAction}
          {comparisonActions}
          {!overflowTools && (
            <div ref={formatToolsRef} className="za-workspace-file-format-tools" />
          )}
          {fileTree && (
            <TooltipButton
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={treeLabel}
              tooltip={treeLabel}
              tooltipSide="bottom"
              aria-pressed={fileTree.open}
              onClick={fileTree.toggle}
            >
              <FoldersIcon aria-hidden="true" className="size-4" />
            </TooltipButton>
          )}
          {!request.remote && (
            <div className="za-workspace-file-open">
              <TooltipButton
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                aria-label={openPrimaryLabel}
                tooltip={openPrimaryLabel}
                tooltipSide="bottom"
                onClick={() =>
                  void (primaryTarget.id === "default"
                    ? open("open")
                    : openEditor(primaryTarget.id))
                }
              >
                <primaryTarget.Icon aria-hidden="true" className="size-3.5" />
                <span className="za-workspace-file-action-label">{copy("打开", "Open")}</span>
              </TooltipButton>
              <DropdownMenu open={active && openWith} onOpenChange={setOpenWith}>
                <LabelTooltip
                  label={openWithLabel}
                  side="bottom"
                  disabled={openWith}
                  render={
                    <DropdownMenuTrigger
                      render={
                        <Button type="button" size="icon-sm" variant="ghost" className="h-7 w-6" />
                      }
                      aria-label={openWithLabel}
                    >
                      <ChevronDown className="size-3" />
                    </DropdownMenuTrigger>
                  }
                />
                <DropdownMenuContent align="end" className="min-w-44">
                  {openTargets.map(({ id, label, Icon }) => (
                    <DropdownMenuItem
                      key={id}
                      onClick={() =>
                        void (id === "default" ? open("open", true) : openEditor(id, true))
                      }
                    >
                      <Icon aria-hidden="true" className="size-4" />
                      {id === "default" ? copy("默认应用", label) : label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => void open("reveal")}>
                    {copy("打开所在文件夹", "Open containing folder")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void saveCopy()}>
                    {copy("另存为…", "Save as…")}
                  </DropdownMenuItem>
                  {details?.github && (
                    <DropdownMenuItem
                      onClick={() => {
                        void openUrl(details.github).catch(() =>
                          onError(
                            copy("无法在 GitHub 打开此文件", "Could not open this file on GitHub"),
                          ),
                        );
                      }}
                    >
                      <Github className="size-4" />
                      {copy("在 GitHub 上打开", "Open in GitHub")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
