import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { getFileTypeIcon } from "@liveagent/ui/components/chat/fileTypeIcons";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  FolderOpen,
  Github,
  MoreHorizontal,
  Pin,
  Save,
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
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@liveagent/ui/components/ui/context-menu";
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
  workspacePathExtension,
} from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import {
  workspaceImageAbsolutePathForCopy,
  workspaceImageRelativePathForCopy,
} from "@liveagent/ui/components/workspace-editor/workspaceImageViewer";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { GitClient, GitRepositoryState } from "@liveagent/ui/lib/git/types";
import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";
import { resolveSourceLanguage } from "@liveagent/ui/lib/sourceLanguages";
import { invokeFs } from "@liveagent/ui/lib/tools/fsBackend";
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import AndroidIcon from "~icons/logos/android-icon";
import GitIcon from "~icons/logos/git-icon";
import WslIcon from "~icons/logos/linux-tux";
import PyCharmIcon from "~icons/logos/pycharm";
import TerminalIcon from "~icons/logos/terminal";
import VisualStudioIcon from "~icons/logos/visual-studio";
import VSCodeIcon from "~icons/logos/visual-studio-code";
import CursorIcon from "~icons/material-icon-theme/cursor";
import type { WorkspaceFileRequest } from "./useWorkspaceTabs";
import { WorkspaceFileTreeIcon } from "./WorkspaceFileTreeIcon";
import "./workspace-file-header.css";

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

const WORKSPACE_OPEN_TARGETS = [
  { id: "vscode", label: "VS Code", Icon: VSCodeIcon },
  { id: "visual-studio", label: "Visual Studio", Icon: VisualStudioIcon },
  { id: "vscode-insiders", label: "VS Code Insiders", Icon: VSCodeIcon },
  { id: "cursor", label: "Cursor", Icon: CursorIcon },
  { id: "terminal", label: "Terminal", Icon: TerminalIcon },
  { id: "git-bash", label: "Git Bash", Icon: GitIcon },
  { id: "wsl", label: "WSL", Icon: WslIcon },
  { id: "android-studio", label: "Android Studio", Icon: AndroidIcon },
  { id: "pycharm", label: "PyCharm", Icon: PyCharmIcon },
] as const;
type FileApplication = { id: string; name: string; iconDataUrl?: string | null };
type FileApplications = {
  defaultApplication: FileApplication | null;
  alternatives: FileApplication[];
};

function applicationDisplayKey(name: string) {
  return name.toLowerCase().replace("visual studio code", "vs code").replace(" - ", " ");
}

function FileApplicationIcon({
  application,
  path,
}: {
  application?: FileApplication;
  path: string;
}) {
  const Icon = getFileTypeIcon(path, "file");
  return application?.iconDataUrl ? (
    <img src={application.iconDataUrl} alt="" className="size-4 shrink-0 object-contain" />
  ) : (
    <Icon aria-hidden="true" className="size-4 shrink-0" />
  );
}

const FILE_TOOLBAR_COMPACT_WIDTH = 625;

export function WorkspaceFileTabMenuItems({
  request,
  gitClient,
  nativeFileActions = true,
  onKeepOpen,
  readText,
  isCurrent = () => true,
  beforeOpen,
  onError,
}: {
  request: WorkspaceFileRequest;
  gitClient?: GitClient;
  nativeFileActions?: boolean;
  onKeepOpen?: () => void;
  readText: () => string | undefined;
  isCurrent?: () => boolean;
  beforeOpen?: () => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const { path, workdir, remote, stagedAttachment, line, column } = request;
  const native = nativeFileActions && !remote && !stagedAttachment;
  const canCopyText = !isWorkspacePreviewPath(path) || isWorkspaceEditablePreviewPath(path);
  const codeTools =
    canCopyText &&
    (isWorkspacePreviewPath(path) || resolveSourceLanguage(path) !== "plaintext") &&
    !["csv", "tsv"].includes(workspacePathExtension(path));
  const [applications, setApplications] = useState<FileApplications>();
  const [editors, setEditors] = useState<string[]>([]);
  const [github, setGithub] = useState("");
  useEffect(() => {
    if (!native) return;
    let current = true;
    void invokeFs<FileApplications>("fs_workspace_file_apps", { workdir, path }).then(
      (result) => {
        if (current) setApplications(result);
      },
      () => {},
    );
    if (codeTools)
      void invokeFs<string[]>("fs_workspace_editor_targets", {}).then(
        (result) => {
          if (current) setEditors(result);
        },
        () => {},
      );
    if (gitClient)
      void gitClient.status(workdir).then(
        (result) => {
          if (current) setGithub(fileRepositoryDetails(request, result)?.github ?? "");
        },
        () => {},
      );
    return () => {
      current = false;
    };
  }, [codeTools, gitClient, native, path, request, workdir]);
  const primary = applications?.defaultApplication ?? undefined;
  const alternatives = applications?.alternatives ?? [];
  const targets = WORKSPACE_OPEN_TARGETS.filter(
    ({ id, label }) =>
      editors.includes(id) &&
      (line ||
        ![primary, ...alternatives].some(
          (item) => item && applicationDisplayKey(item.name) === applicationDisplayKey(label),
        )),
  );
  const open = async (command: string, args?: Record<string, unknown>) => {
    try {
      if (!isCurrent()) return;
      if (args?.mode !== "reveal" && (await beforeOpen?.()) === false) return;
      if (isCurrent()) await invokeFs(command, { path, workdir, ...args });
    } catch {
      if (isCurrent()) onError(copy("无法完成文件操作", "Could not complete the file operation"));
    }
  };
  const copyValue = async (content: () => string | Promise<string>, message: string) => {
    try {
      if (!isCurrent()) return;
      const value = await content();
      if (!isCurrent() || (await copyTextToClipboard(value))) return;
    } catch {
      // The path may have become inaccessible while the menu was open.
    }
    if (isCurrent()) onError(message);
  };
  return (
    <>
      {native && (
        <>
          <ContextMenuItem onSelect={() => open("fs_open_workspace_path", { mode: "open" })}>
            <FileApplicationIcon application={primary} path={path} />
            {primary
              ? copy(`在 ${primary.name} 中打开`, `Open in ${primary.name}`)
              : copy("在默认应用中打开", "Open in default app")}
          </ContextMenuItem>
          {(alternatives.length > 0 || targets.length > 0) && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <ExternalLink />
                {copy("打开方式", "Open with")}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="za-workspace-compact-menu">
                {alternatives.map((application) => (
                  <ContextMenuItem
                    key={application.id}
                    onSelect={() =>
                      open("fs_open_workspace_file_app", { application: application.id })
                    }
                  >
                    <FileApplicationIcon application={application} path={path} />
                    {application.name}
                  </ContextMenuItem>
                ))}
                {targets.map(({ id, label, Icon }) => (
                  <ContextMenuItem
                    key={id}
                    onSelect={() => open("fs_open_workspace_editor", { editor: id, line, column })}
                  >
                    <Icon className="size-4" />
                    {label}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          {github && (
            <ContextMenuItem
              onSelect={() => {
                if (isCurrent())
                  void openUrl(github).catch(() => {
                    if (isCurrent()) onError(copy("无法打开 GitHub", "Could not open GitHub"));
                  });
              }}
            >
              <Github />
              {copy("在 GitHub 上打开", "Open in GitHub")}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => open("fs_save_workspace_copy")}>
            <Save />
            {copy("另存为…", "Save as…")}
          </ContextMenuItem>
        </>
      )}
      <ContextMenuItem
        onSelect={() =>
          void copyValue(
            () => workspaceImageAbsolutePathForCopy(workdir, path),
            copy("无法复制文件路径", "Could not copy the file path"),
          )
        }
      >
        <Copy />
        {copy("复制路径", "Copy path")}
      </ContextMenuItem>
      {(canCopyText || readText() !== undefined) && (
        <ContextMenuItem
          onSelect={() =>
            void copyValue(
              async () => {
                const cached = readText();
                if (cached !== undefined) return cached;
                if (remote || stagedAttachment) throw new Error("File contents unavailable");
                return (await localEditorFileIo.read(request)).content;
              },
              copy("无法复制文件内容", "Could not copy file contents"),
            )
          }
        >
          <Copy />
          {copy("复制文件内容", "Copy file contents")}
        </ContextMenuItem>
      )}
      {native && (
        <ContextMenuItem onSelect={() => open("fs_open_workspace_path", { mode: "reveal" })}>
          <FolderOpen />
          {copy("打开所在文件夹", "Open containing folder")}
        </ContextMenuItem>
      )}
      {onKeepOpen && (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={onKeepOpen}>
            <Pin />
            {copy("固定标签页", "Keep tab open")}
          </ContextMenuItem>
        </>
      )}
    </>
  );
}

function isWithinDirectory(path: string, directory: string) {
  const expectedPrefix = directory ? `${directory}/` : "";
  if (!path.startsWith(expectedPrefix)) return false;
  const name = path.slice(expectedPrefix.length);
  return Boolean(name && name !== "." && name !== ".." && !/[/\\]/.test(name));
}

function BreadcrumbDirectory({
  workdir,
  directory,
  selectedPath,
  depth = 0,
  onOpenFile,
}: {
  workdir: string;
  directory: string;
  selectedPath?: string;
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
        const active = entry.path === selectedPath;
        const open = folder && (expanded.get(entry.path) ?? active);
        const Icon = folder ? ChevronRight : getFileTypeIcon(entry.path, "file");
        return (
          <div key={entry.path}>
            <button
              ref={active ? selected : undefined}
              type="button"
              className="za-breadcrumb-entry"
              style={{ paddingInlineStart: 5 + depth * 12 }}
              aria-current={active ? (folder ? "location" : "page") : undefined}
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
  const [picker, setPicker] = useState<{ id: string; index: number } | null>(null);
  const pickerIndex = picker?.index ?? -1;
  const pickerOpen = active && pickerIndex >= firstVisible && pickerIndex <= parts.length;
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
      triggerId={picker?.id ?? null}
      onOpenChange={(open, details) => {
        if (!open) {
          setPicker(null);
          return;
        }
        const trigger = details.trigger;
        if (trigger) {
          setPicker({
            id: trigger.id,
            index: Number(trigger.getAttribute("data-breadcrumb-index")),
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
            key={JSON.stringify([request.workdir, relative, pickerIndex])}
            workdir={request.workdir}
            directory={parts.slice(0, Math.max(0, pickerIndex - 1)).join("/")}
            selectedPath={pickerIndex > 0 ? parts.slice(0, pickerIndex).join("/") : undefined}
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

export function WorkspaceFileHeader({
  active,
  nativeFileActions = true,
  request,
  modeActions,
  viewAction,
  comparisonActions,
  fileTree,
  setFormatTools,
  onOpenFile,
  onError,
  readDraft,
  beforeOpen,
  gitClient,
}: {
  active: boolean;
  nativeFileActions?: boolean;
  request: WorkspaceFileRequest;
  modeActions: ReactNode;
  viewAction?: ReactNode;
  comparisonActions?: ReactNode;
  fileTree?: { open: boolean; toggle: () => void };
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
  const actionGroupRef = useRef<HTMLFieldSetElement>(null);
  const overflowTriggerRef = useRef<HTMLButtonElement>(null);
  const compactRef = useRef(false);
  const restoreToolFocus = useRef(false);
  const activeRequest = useRef<WorkspaceFileRequest | null>(null);
  const [compact, setCompact] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [controlsPortal, setControlsPortal] = useState<HTMLElement | null>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [openWith, setOpenWith] = useState(false);
  const [editorTargets, setEditorTargets] = useState<string[]>([]);
  const [applicationSnapshot, setApplicationSnapshot] = useState<{
    path: string;
    workdir: string;
    applications: FileApplications;
  }>();
  const [repository, setRepository] = useState<GitRepositoryState | null>(null);
  const details = repository && fileRepositoryDetails(request, repository);
  const editable =
    !isWorkspacePreviewPath(request.path) || isWorkspaceEditablePreviewPath(request.path);
  const codeTools =
    editable &&
    (isWorkspacePreviewPath(request.path) || resolveSourceLanguage(request.path) !== "plaintext") &&
    !["csv", "tsv"].includes(workspacePathExtension(request.path));
  const applications =
    active &&
    applicationSnapshot?.path === request.path &&
    applicationSnapshot.workdir === request.workdir
      ? applicationSnapshot.applications
      : undefined;
  const defaultApplication = applications?.defaultApplication ?? undefined;
  const openTargets = codeTools
    ? WORKSPACE_OPEN_TARGETS.filter(
        ({ id, label }) =>
          editorTargets.includes(id) &&
          (request.line ||
            ![defaultApplication, ...(applications?.alternatives ?? [])].some(
              (item) => item && applicationDisplayKey(item.name) === applicationDisplayKey(label),
            )),
      )
    : [];
  const comparing = Boolean(comparisonActions);
  const relative = details?.relative ?? relativePath;
  const canCopyRelative = Boolean(relative && !/^(?:[/\\]|[a-z]:)/i.test(relative));
  useLayoutEffect(() => {
    activeRequest.current = active ? request : null;
    return () => {
      activeRequest.current = null;
    };
  }, [active, request]);
  useLayoutEffect(() => {
    const node = header.current;
    if (!active || !node) return;
    const apply = (width: number) => {
      if (!width) return;
      setControlsPortal(node.closest<HTMLElement>('[data-slot="sheet-popup"]'));
      const next = width < FILE_TOOLBAR_COMPACT_WIDTH;
      if (next === compactRef.current) return;
      const focused = node.ownerDocument.activeElement;
      restoreToolFocus.current =
        focused === overflowTriggerRef.current ||
        Boolean(actionGroupRef.current?.contains(focused));
      compactRef.current = next;
      setControlsOpen(false);
      setOptionsOpen(false);
      setOpenWith(false);
      setCompact(next);
    };
    apply(node.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) apply(entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [active]);
  useLayoutEffect(() => {
    if (!restoreToolFocus.current) return;
    restoreToolFocus.current = false;
    const target = compact
      ? overflowTriggerRef.current
      : actionGroupRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    target?.focus({ preventScroll: true });
  }, [compact]);
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
    if (!active || !nativeFileActions || request.remote) return;
    const path = request.path;
    const workdir = request.workdir;
    let generation = 0;
    const refresh = () => {
      const lookup = ++generation;
      void invokeFs<FileApplications>("fs_workspace_file_apps", { path, workdir }).then(
        (applications) => {
          if (lookup === generation) setApplicationSnapshot({ path, workdir, applications });
        },
        () => {
          if (lookup === generation) setApplicationSnapshot(undefined);
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      generation++;
      window.removeEventListener("focus", refresh);
    };
  }, [active, nativeFileActions, request.path, request.remote, request.workdir]);
  useEffect(() => {
    if (!active || !nativeFileActions || request.remote || !codeTools) return;
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
  }, [active, codeTools, nativeFileActions, request.remote]);
  useEffect(() => {
    if (!active) {
      setControlsOpen(false);
      setOptionsOpen(false);
      setOpenWith(false);
      setRepository(null);
      setEditorTargets([]);
      setApplicationSnapshot(undefined);
    }
  }, [active]);
  const openFileLabel = copy("在默认应用中打开", "Open in default application");
  const openPrimaryLabel = defaultApplication
    ? copy(`在 ${defaultApplication.name} 中打开`, `Open in ${defaultApplication.name}`)
    : openFileLabel;
  const open = async (mode: "open" | "reveal", application?: FileApplication) => {
    try {
      if (mode === "open" && !(await beforeOpen())) return;
      if (activeRequest.current !== request) return;
      const { workdir, path } = request;
      if (application) {
        await invokeFs("fs_open_workspace_file_app", {
          workdir,
          path,
          application: application.id,
        });
      } else {
        await invokeFs("fs_open_workspace_path", { workdir, path, mode });
      }
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
  const openEditor = async (id: string) => {
    try {
      if (!(await beforeOpen()) || activeRequest.current !== request) return;
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
  const openWithLabel = copy("打开方式", "Open with");
  const fileActions = (
    <fieldset
      ref={actionGroupRef}
      className="za-workspace-file-tool-group"
      aria-label={formatLabel}
    >
      {viewAction}
      {comparisonActions}
      {!request.remote && (
        <DropdownMenu open={active && optionsOpen} onOpenChange={setOptionsOpen}>
          <LabelTooltip
            label={fileOptionsLabel}
            side="bottom"
            disabled={optionsOpen}
            render={
              <DropdownMenuTrigger
                aria-label={fileOptionsLabel}
                render={<Button type="button" size="icon-xs" variant="ghost" />}
              >
                <MoreHorizontal aria-hidden="true" className="size-4" />
              </DropdownMenuTrigger>
            }
          />
          <DropdownMenuContent
            align="end"
            className="za-workspace-compact-menu za-workspace-file-options-menu"
          >
            <DropdownMenuItem onSelect={() => copyPath(absolutePath)}>
              <Copy className="size-4" /> {copy("复制路径", "Copy path")}
            </DropdownMenuItem>
            {canCopyRelative && (
              <DropdownMenuItem onSelect={() => void copyRelativePath()}>
                <Copy className="size-4" /> {copy("复制相对路径", "Copy relative path")}
              </DropdownMenuItem>
            )}
            {editable && (
              <DropdownMenuItem onSelect={() => void copyContents()}>
                <Copy className="size-4" /> {copy("复制文件内容", "Copy file contents")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <div ref={setFormatTools} className="za-workspace-file-format-tools" />
      {fileTree && (
        <TooltipButton
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={treeLabel}
          tooltip={treeLabel}
          tooltipSide="bottom"
          aria-pressed={fileTree.open}
          data-workspace-file-tree-toggle=""
          onClick={() => {
            setControlsOpen(false);
            fileTree.toggle();
          }}
        >
          <WorkspaceFileTreeIcon className="size-4" />
        </TooltipButton>
      )}
      {nativeFileActions && !request.remote && (
        <div className="za-workspace-file-open">
          <TooltipButton
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            aria-label={openPrimaryLabel}
            tooltip={openPrimaryLabel}
            tooltipSide="bottom"
            onClick={() => void open("open")}
          >
            <FileApplicationIcon application={defaultApplication} path={request.path} />
            <span>{copy("打开", "Open")}</span>
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
            <DropdownMenuContent align="end" className="za-workspace-compact-menu">
              <DropdownMenuItem data-preferred="" onClick={() => void open("open")}>
                <FileApplicationIcon application={defaultApplication} path={request.path} />
                <span className="min-w-0 truncate">
                  {defaultApplication?.name ?? copy("默认应用", "Default app")}
                </span>
                {defaultApplication && (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {copy("默认应用", "Default")}
                  </span>
                )}
              </DropdownMenuItem>
              {applications?.alternatives.map((application) => (
                <DropdownMenuItem
                  key={application.id}
                  onClick={() => void open("open", application)}
                >
                  <FileApplicationIcon application={application} path={request.path} />
                  <span className="min-w-0 truncate">{application.name}</span>
                </DropdownMenuItem>
              ))}
              {openTargets.length > 0 && <DropdownMenuSeparator />}
              {openTargets.map(({ id, label, Icon }) => (
                <DropdownMenuItem key={id} onClick={() => void openEditor(id)}>
                  <Icon aria-hidden="true" className="size-4" />
                  {label}
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
    </fieldset>
  );
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
        {compact ? (
          <Popover
            open={active && controlsOpen}
            onOpenChange={(open) => {
              if (open)
                setControlsPortal(header.current?.closest<HTMLElement>('[data-slot="sheet-popup"]') ?? null);
              setControlsOpen(open);
            }}
          >
            <LabelTooltip
              label={formatLabel}
              side="bottom"
              disabled={controlsOpen}
              render={
                <PopoverTrigger
                  render={<button ref={overflowTriggerRef} type="button" />}
                  aria-label={formatLabel}
                  className="za-workspace-file-overflow-trigger"
                >
                  <MoreHorizontal aria-hidden="true" className="size-4" />
                </PopoverTrigger>
              }
            />
            <PopoverContent
              keepMounted
              align="end"
              portalContainer={controlsPortal ?? undefined}
              aria-label={formatLabel}
              className="za-workspace-compact-menu za-workspace-file-overflow"
            >
              {fileActions}
            </PopoverContent>
          </Popover>
        ) : (
          fileActions
        )}
      </div>
    </header>
  );
}
