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
  MoreHorizontal,
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
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import { localEditorFileIo } from "@liveagent/ui/components/workspace-editor/workspaceEditorFileIo";
import { isWorkspacePreviewPath } from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import {
  workspaceImageAbsolutePathForCopy,
  workspaceImageRelativePathForCopy,
} from "@liveagent/ui/components/workspace-editor/workspaceImageViewer";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { GitClient, GitRepositoryState } from "@liveagent/ui/lib/git/types";
import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";
import { invokeFs } from "@liveagent/ui/lib/tools/fsBackend";
import { type ReactNode, useEffect, useId, useState } from "react";
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
  { id: "vscode", label: "VS Code" },
  { id: "vscode-insiders", label: "VS Code Insiders" },
  { id: "cursor", label: "Cursor" },
] as const;

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
      <span className="za-workspace-file-path-label" title={request.path}>
        {workspaceFileName(request.path)}
      </span>
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
        {[workspaceFileName(request.workdir), ...parts].map((part, index) => {
          const last = index === parts.length;
          const segment = parts.slice(0, index).join("/");
          const path = last ? segment.slice(0, Math.max(0, segment.lastIndexOf("/"))) : segment;
          const label = zh ? `浏览 ${part}` : `Browse ${part}`;
          return (
            <div className="za-workspace-file-path-segment" key={segment}>
              {index !== 0 && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
              <DropdownMenuTrigger
                type="button"
                id={`${breadcrumbId}-${index}`}
                data-directory={path}
                className="za-workspace-file-path-label"
                aria-label={label}
                title={part}
                aria-current={last ? "page" : undefined}
              >
                {part}
              </DropdownMenuTrigger>
            </div>
          );
        })}
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
  setFormatTools,
  onOpenFile,
  onError,
  readDraft,
  gitClient,
}: {
  active: boolean;
  request: WorkspaceFileRequest;
  modeActions: ReactNode;
  setFormatTools: (element: HTMLDivElement | null) => void;
  onOpenFile: (path: string) => void;
  onError: (message: string) => void;
  readDraft: () => string | undefined;
  gitClient?: GitClient;
}) {
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const absolutePath = workspaceImageAbsolutePathForCopy(request.workdir, request.path);
  const relativePath = workspaceImageRelativePathForCopy(request.workdir, request.path);
  const [fileOptionsOpen, setFileOptionsOpen] = useState(false);
  const [openWith, setOpenWith] = useState(false);
  const [editorTargets, setEditorTargets] = useState<string[]>([]);
  const [repository, setRepository] = useState<GitRepositoryState | null>(null);
  const details = repository && fileRepositoryDetails(request, repository);
  useEffect(() => {
    if (!active || !fileOptionsOpen || !gitClient || request.remote) return;
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
  }, [active, fileOptionsOpen, gitClient, request.remote, request.workdir]);
  useEffect(() => {
    if (!active || !openWith || request.remote) return;
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
  }, [active, openWith, request.remote]);
  useEffect(() => {
    if (!active) {
      setFileOptionsOpen(false);
      setOpenWith(false);
      setRepository(null);
      setEditorTargets([]);
    }
  }, [active]);
  const openFileLabel = copy("在默认应用中打开", "Open in default application");
  const open = (mode: "open" | "reveal") => {
    void invokeFs("fs_open_workspace_path", {
      workdir: request.workdir,
      path: request.path,
      mode,
    }).catch(() => onError(copy("无法打开文件", "Could not open the file")));
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
  const openEditor = (id: string) => {
    void invokeFs("fs_open_workspace_editor", {
      workdir: request.workdir,
      path: request.path,
      editor: id,
      line: request.line,
      column: request.column,
    }).catch(() =>
      onError(copy("无法在此编辑器中打开文件", "Could not open the file in this editor")),
    );
  };
  return (
    <header className="za-workspace-file-header" data-desktop-workspace-file-header="">
      <WorkspaceBreadcrumbs request={request} active={active} onOpenFile={onOpenFile} />
      <div className="za-workspace-file-actions">
        {modeActions}
        <div ref={setFormatTools} className="za-workspace-file-format-tools" />
        {!request.remote && (
          <>
            <DropdownMenu
              open={active && fileOptionsOpen}
              onOpenChange={(open) => {
                setRepository(null);
                setFileOptionsOpen(open);
              }}
            >
              <DropdownMenuTrigger
                render={
                  <Button type="button" size="icon-sm" variant="ghost" className="rounded-full" />
                }
                aria-label={copy("文件选项", "File options")}
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void copyTextToClipboard(absolutePath)}>
                  <Copy className="size-4" />
                  {copy("复制文件路径", "Copy file path")}
                </DropdownMenuItem>
                {!/^(?:[/\\]|[a-z]:)/i.test(relativePath) && (
                  <DropdownMenuItem onClick={() => void copyTextToClipboard(relativePath)}>
                    <Copy className="size-4" />
                    {copy("复制项目相对路径", "Copy project-relative path")}
                  </DropdownMenuItem>
                )}
                {details?.relative && (
                  <DropdownMenuItem onClick={() => void copyTextToClipboard(details.relative)}>
                    <Copy className="size-4" />
                    {copy("复制仓库相对路径", "Copy repository-relative path")}
                  </DropdownMenuItem>
                )}
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
                    <ExternalLink className="size-4" />
                    {copy("在 GitHub 上打开", "Open in GitHub")}
                  </DropdownMenuItem>
                )}
                {(!isWorkspacePreviewPath(request.path) ||
                  /\.(?:md|markdown|mdx|html?|txt|csv|tsv|json|xml)$/i.test(request.path)) && (
                  <DropdownMenuItem onClick={() => void copyContents()}>
                    <Copy className="size-4" />
                    {copy("复制文件内容", "Copy file contents")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="za-workspace-file-open">
              <TooltipButton
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                aria-label={openFileLabel}
                tooltip={openFileLabel}
                onClick={() => open("open")}
              >
                <ExternalLink className="size-3.5" />
                <span className="za-workspace-file-action-label">{copy("打开", "Open")}</span>
              </TooltipButton>
              <DropdownMenu
                open={active && openWith}
                onOpenChange={(open) => {
                  setEditorTargets([]);
                  setOpenWith(open);
                }}
              >
                <DropdownMenuTrigger
                  render={
                    <Button type="button" size="icon-sm" variant="ghost" className="h-7 w-6" />
                  }
                  aria-label={copy("打开方式", "Open with")}
                >
                  <ChevronDown className="size-3" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => open("open")}>
                    <ExternalLink className="size-4" /> {openFileLabel}
                  </DropdownMenuItem>
                  {WINDOWS_EDITORS.filter(({ id }) => editorTargets.includes(id)).map(
                    ({ id, label }) => (
                      <DropdownMenuItem key={id} onClick={() => openEditor(id)}>
                        <FilePenLine className="size-4" /> {label}
                      </DropdownMenuItem>
                    ),
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => open("reveal")}>
                    <FolderOpen className="size-4" />{" "}
                    {copy("在文件管理器中显示", "Reveal in file manager")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
