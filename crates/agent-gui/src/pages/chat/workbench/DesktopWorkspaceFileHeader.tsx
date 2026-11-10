import { openUrl } from "@liveagent/app/shims/tauriOpener";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FilePenLine,
  FileText,
  Folder,
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
  DropdownMenuLabel,
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
import VSCodeIcon from "~icons/logos/visual-studio-code";
import FileSearchIcon from "~icons/lucide/file-search-2";
import FoldersIcon from "~icons/lucide/folders";
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
  path: string;
  entries: FileTreeEntry[];
  error?: boolean;
  hasMore?: boolean;
};

const WINDOWS_EDITORS = [
  { id: "vscode", label: "VS Code", Icon: VSCodeIcon },
  { id: "vscode-insiders", label: "VS Code Insiders", Icon: FilePenLine },
  { id: "cursor", label: "Cursor", Icon: FilePenLine },
] as const;

const FILE_TOOLBAR_COMPACT_WIDTH = 625;

function isWithinDirectory(path: string, directory: string) {
  const expectedPrefix = directory ? `${directory}/` : "";
  if (!path.startsWith(expectedPrefix)) return false;
  const name = path.slice(expectedPrefix.length);
  return Boolean(name && name !== "." && name !== ".." && !/[/\\]/.test(name));
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
  const breadcrumbId = useId();
  const [directory, setDirectory] = useState<string | null>(null);
  const [triggerId, setTriggerId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<DirectorySnapshot | null>(null);
  const current = directory === snapshot?.path ? snapshot : null;
  useEffect(() => {
    if (!active || directory === null) return;
    let current = true;
    void invokeFs<{ entries: FileTreeEntry[]; hasMore?: boolean }>("fs_list", {
      workdir: request.workdir,
      path: directory || undefined,
      depth: 1,
      offset: 0,
      max_results: 200,
      show_hidden: false,
    }).then(
      ({ entries, hasMore }) => {
        if (!current) return;
        setSnapshot({
          path: directory,
          hasMore,
          entries: entries
            .map((entry) => ({ ...entry, path: entry.path.replace(/\\/g, "/") }))
            .filter((entry) => isWithinDirectory(entry.path, directory))
            .sort((left, right) =>
              left.kind === right.kind
                ? workspaceFileName(left.path).localeCompare(
                    workspaceFileName(right.path),
                    locale,
                    { numeric: true },
                  )
                : left.kind === "dir"
                  ? -1
                  : 1,
            ),
        });
      },
      () => {
        if (current) setSnapshot({ path: directory, entries: [], error: true });
      },
    );
    return () => {
      current = false;
    };
  }, [active, directory, locale, request.workdir]);
  useEffect(() => {
    if (!active) {
      setDirectory(null);
      setTriggerId(null);
      setSnapshot(null);
    }
  }, [active]);
  const directoryLabel = (path: string) => workspaceFileName(path || request.workdir);
  const openPicker = (path: string) => {
    setDirectory(path);
    setSnapshot(null);
  };
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
    <DropdownMenu
      modal={false}
      open={active && directory !== null}
      triggerId={triggerId}
      onOpenChange={(open, details) => {
        const selected = details.trigger?.getAttribute("data-directory");
        if (!open) {
          setDirectory(null);
          setTriggerId(null);
        } else if (details.trigger && selected != null) {
          setTriggerId(details.trigger.id);
          openPicker(selected);
        }
      }}
    >
      <nav className="za-workspace-file-path" aria-label={zh ? "文件路径" : "File path"}>
        <ol>
          {[workspaceFileName(request.workdir), ...parts].map((part, index) => {
            const last = index === parts.length;
            const segment = parts.slice(0, index).join("/");
            const path = last ? parts.slice(0, -1).join("/") : segment;
            const label = zh ? `浏览 ${part}` : `Browse ${part}`;
            return (
              <li className="za-workspace-file-path-segment" key={segment}>
                <LabelTooltip
                  label={last ? relative : part}
                  side="bottom"
                  disabled={active && directory !== null}
                  render={
                    <DropdownMenuTrigger
                      type="button"
                      id={`${breadcrumbId}-${index}`}
                      data-directory={path}
                      className="za-workspace-file-path-label"
                      aria-label={label}
                      aria-current={last ? "page" : undefined}
                    >
                      {part}
                    </DropdownMenuTrigger>
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
      <DropdownMenuContent align="start" className="max-w-80">
        <DropdownMenuLabel className="truncate font-medium text-muted-foreground">
          {directoryLabel(directory ?? "")}
        </DropdownMenuLabel>
        {directory && (
          <DropdownMenuItem
            closeOnClick={false}
            onClick={() => openPicker(directory.split("/").slice(0, -1).join("/"))}
          >
            <FolderOpen className="size-4" />
            {zh ? "上一级" : "Parent folder"}
          </DropdownMenuItem>
        )}
        {current?.entries.map((entry) => (
          <DropdownMenuItem
            key={entry.path}
            closeOnClick={entry.kind !== "dir"}
            onClick={() => (entry.kind === "dir" ? openPicker(entry.path) : onOpenFile(entry.path))}
          >
            {entry.kind === "dir" ? <Folder className="size-4" /> : <FileText className="size-4" />}
            <span className="min-w-0 truncate">{workspaceFileName(entry.path)}</span>
          </DropdownMenuItem>
        ))}
        {(!current?.entries.length || current.hasMore) && (
          <DropdownMenuLabel className="font-normal text-muted-foreground">
            {!current
              ? zh
                ? "正在读取…"
                : "Loading…"
              : current.error
                ? zh
                  ? "无法读取文件夹"
                  : "Could not read folder"
                : current.hasMore
                  ? zh
                    ? "仅显示前 200 项"
                    : "Showing the first 200 items"
                  : zh
                    ? "文件夹为空"
                    : "Folder is empty"}
          </DropdownMenuLabel>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
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
  const [repository, setRepository] = useState<GitRepositoryState | null>(null);
  const details = repository && fileRepositoryDetails(request, repository);
  const availableEditors = WINDOWS_EDITORS.filter(({ id }) => editorTargets.includes(id));
  const editable =
    !isWorkspacePreviewPath(request.path) || isWorkspaceEditablePreviewPath(request.path);
  const primaryEditor = editable ? availableEditors[0] : undefined;
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
  const openPrimaryLabel = primaryEditor
    ? copy(`在 ${primaryEditor.label} 中打开`, `Open in ${primaryEditor.label}`)
    : openFileLabel;
  const open = async (mode: "open" | "reveal") => {
    try {
      if (mode === "open" && !(await beforeOpen())) return;
      await invokeFs("fs_open_workspace_path", {
        workdir: request.workdir,
        path: request.path,
        mode,
      });
    } catch {
      onError(copy("无法打开文件", "Could not open the file"));
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
  const openEditor = async (id: string) => {
    try {
      if (!(await beforeOpen())) return;
      await invokeFs("fs_open_workspace_editor", {
        workdir: request.workdir,
        path: request.path,
        editor: id,
        line: request.line,
        column: request.column,
      });
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
                onClick={() => void (primaryEditor ? openEditor(primaryEditor.id) : open("open"))}
              >
                {primaryEditor ? (
                  <primaryEditor.Icon className="size-3.5" />
                ) : (
                  <ExternalLink
                    aria-hidden="true"
                    className="za-workspace-file-compact-icon size-3.5"
                  />
                )}
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
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => void open("open")}>
                    <ExternalLink className="size-4" /> {openFileLabel}
                  </DropdownMenuItem>
                  {availableEditors.map(({ id, label, Icon }) => (
                    <DropdownMenuItem key={id} onClick={() => void openEditor(id)}>
                      <Icon className="size-4" /> {label}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => void open("reveal")}>
                    <FolderOpen className="size-4" />{" "}
                    {copy("在文件管理器中显示", "Reveal in file manager")}
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
