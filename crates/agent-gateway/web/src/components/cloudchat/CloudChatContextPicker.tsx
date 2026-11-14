import {
  Blend,
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  FolderOpen,
  Plus,
  Search,
  Upload,
} from "@liveagent/ui/components/IconSet";
import { Input } from "@liveagent/ui/components/ui/input";
import { Popover, PopoverContent } from "@liveagent/ui/components/ui/popover";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "@liveagent/ui/components/ui/sheet";
import { TooltipButton as Button } from "@liveagent/ui/components/ui/tooltip-button";
import { ExtensionMark } from "@liveagent/ui/features/extensions/ExtensionMark";
import {
  type ExtensionPackage,
  type ExtensionSkill,
  extensionComposerEntry,
} from "@liveagent/ui/features/extensions/extensionTypes";
import { useLocale } from "@liveagent/ui/i18n";
import { formatUploadedFileSize } from "@liveagent/ui/lib/chat/uploadedFiles";
import {
  extensionDescription,
  extensionDisplayName,
  extensionSearchText,
  parseExtensionReference,
} from "@liveagent/ui/lib/extensions/presentation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  type CloudChatFile,
  type CloudChatFilesClient,
  cloudFileCanReference,
  cloudFileStatus,
} from "@/lib/cloudChatFiles";
import type {
  CloudAccountGuard,
  CloudChatProjectsClient,
  CloudProject,
} from "@/lib/cloudChatProjects";
import { type CloudSpaceClient, CloudSpaceError, type CloudSpaceItem } from "@/lib/cloudSpace";
import { CloudProjectIcon } from "./CloudProjectIcon";
import { CloudSpaceFormatIcon } from "./CloudSpaceCover";

export type CloudComposerPicker = "projects" | "files" | "tools";
export type CloudComposerMenu = CloudComposerPicker | "add" | null;
export type CloudComposerFileReview = {
  name: string;
  files: CloudChatFile[];
  nextCursor: string;
};

export function CloudChatWorkToolbar(props: {
  compact?: boolean;
  open: CloudComposerMenu;
  disabled: boolean;
  projectDisabled?: boolean;
  busy?: boolean;
  project?: Pick<CloudProject, "name" | "icon" | "color">;
  onOpen: (kind: CloudComposerPicker, anchor: HTMLElement) => void;
}) {
  const { locale } = useLocale();
  const en = locale === "en-US";
  const project = props.project;
  return (
    <div
      className="cloud-composer-context-tray"
      data-compact-work-tools={props.compact ? "" : undefined}
      role="toolbar"
      aria-label={en ? "Work context" : "工作上下文"}
    >
      {(
        [
          {
            id: "projects",
            label: props.busy
              ? en
                ? "Updating project…"
                : "正在更新项目…"
              : project?.name || (en ? "Choose project" : "选择项目"),
            icon: FolderOpen,
          },
          { id: "files", label: en ? "Files" : "文件", icon: BookOpen },
          {
            id: "tools",
            label: props.compact ? (en ? "Skills" : "技能") : en ? "Plugins" : "插件",
            icon: Blend,
          },
        ] as const
      )
        .filter(({ id }) => !props.compact || id !== "files")
        .map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            data-cloud-work-tool={id}
            data-composer-option-block={props.compact ? "" : undefined}
            variant="ghost"
            size="sm"
            disabled={props.disabled || (id === "projects" && props.projectDisabled)}
            aria-label={
              id === "projects" && project && !props.busy
                ? en
                  ? `Current project ${project.name}`
                  : `当前项目：${project.name}`
                : label
            }
            aria-haspopup="dialog"
            aria-expanded={props.open === id}
            data-open={props.open === id || undefined}
            onClick={(event) => props.onOpen(id, event.currentTarget)}
          >
            {id === "projects" && project ? (
              <CloudProjectIcon
                icon={project.icon}
                color={project.color}
                className="size-4 shrink-0"
              />
            ) : (
              <Icon className="size-4 shrink-0" aria-hidden="true" />
            )}
            <span className="truncate">
              {props.compact && id === "projects" && !project && !props.busy
                ? en
                  ? "Project"
                  : "项目"
                : label}
            </span>
          </Button>
        ))}
    </div>
  );
}

type Entry = {
  id: string;
  name: string;
  file?: CloudChatFile;
  resource?: CloudSpaceItem;
  project?: CloudProject;
};
const recentLibrary = { category: "recent", scope: "all", folder: "" } as const;

export function CloudChatContextPicker(props: {
  kind: CloudComposerPicker | null;
  anchor: HTMLElement | null;
  mobile: boolean;
  scope: string;
  projectsClient: CloudChatProjectsClient;
  filesClient: CloudChatFilesClient;
  spaceClient: Pick<CloudSpaceClient, "list">;
  captureGuard: CloudAccountGuard;
  attachedIds: readonly string[];
  fileReview?: CloudComposerFileReview;
  selectedProject?: Pick<CloudProject, "id" | "name" | "icon" | "color">;
  disabled: boolean;
  onClose: () => void;
  onSelectProject: (project: CloudProject | null) => Promise<void>;
  onAttach: (file: CloudChatFile) => void;
  onAttachResource: (item: CloudSpaceItem, signal: AbortSignal) => Promise<void>;
  attachmentDisabledReason?: string;
  onUpload: () => void;
  uploadDisabledReason?: string;
  onBrowse: (kind: "projects" | "files") => void;
  onCreateProject: () => void;
  extensions: ExtensionPackage[];
  extensionsLoading?: boolean;
  extensionsFailed?: boolean;
  onRetryExtensions?: () => void;
  selectedSkillFiles?: readonly string[];
  onRemoveSkill?: (file: string) => void;
  onTryExtension: (pkg: ExtensionPackage, skill: ExtensionSkill) => void;
  onViewExtension?: (pkg: ExtensionPackage) => void;
  onCustomize: () => void;
  onFocusComposer: () => void;
}) {
  const { kind, scope, projectsClient, filesClient, spaceClient, captureGuard, fileReview } = props;
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "en-US" ? en : zh);
  const lastKind = useRef<CloudComposerPicker>("files");
  if (kind) lastKind.current = kind;
  const visibleKind = kind ?? lastKind.current;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attaching, setAttaching] = useState<string>();
  const [listFailure, setListFailure] = useState<"first" | "more" | "changed" | null>(null);
  const [actionError, setActionError] = useState("");
  const epoch = useRef(0);
  const loadingRef = useRef(false);
  const actionRef = useRef<number | null>(null);
  const libraryRequest = useRef<AbortController | null>(null);
  const attachmentRequest = useRef<AbortController | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listActionRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const pageFocus = useRef<{
    action: HTMLButtonElement;
    fallback: HTMLElement;
    previousRows: Set<string | undefined>;
    request: number;
  } | null>(null);
  const focusAfterClose = useRef<"anchor" | "composer" | "none">("anchor");
  const searchingLibrary = kind === "files" && !fileReview;
  const libraryQuery = searchingLibrary ? query.trim() : "";
  const queryTooLong = new TextEncoder().encode(libraryQuery).length > 200;

  const requestPage = useCallback(
    async (
      pageKind: "files" | "projects" | "library",
      before = "",
      fallbackFocus?: HTMLElement | null,
      search = "",
      signal?: AbortSignal,
    ) => {
      if (loadingRef.current || actionRef.current !== null) return;
      const request = epoch.current;
      const guard = captureGuard();
      loadingRef.current = true;
      setLoading(true);
      try {
        let nextEntries: Entry[];
        let nextCursor: string;
        if (pageKind === "library") {
          const page = await spaceClient.list(recentLibrary, search, "updated", before, signal);
          nextEntries = page.items.flatMap((item) =>
            item.kind === "folder" || item.trashed
              ? []
              : [{ id: item.site_version_id ?? item.target_id, name: item.name, resource: item }],
          );
          nextCursor = page.next_cursor;
        } else if (pageKind === "files") {
          const page = await filesClient.list({ before });
          nextEntries = page.files.map((file) => ({ id: file.id, name: file.name, file }));
          nextCursor = page.nextCursor;
        } else {
          const page = await projectsClient.listProjects(before);
          nextEntries = page.items.map((project) => ({
            id: project.id,
            name: project.name,
            project,
          }));
          nextCursor = page.next_before_id;
        }
        guard();
        if (epoch.current !== request || signal?.aborted) return;
        const action = listActionRef.current;
        if (!nextCursor && action && fallbackFocus && action.ownerDocument.activeElement === action)
          pageFocus.current = {
            action,
            fallback: fallbackFocus,
            previousRows: new Set(
              before
                ? Array.from(
                    popupRef.current?.querySelectorAll<HTMLElement>("[data-picker-entry]") ?? [],
                    (row) => row.dataset.pickerEntry,
                  )
                : [],
            ),
            request,
          };
        setEntries((old) =>
          before
            ? [...old, ...nextEntries.filter((item) => !old.some((other) => other.id === item.id))]
            : nextEntries,
        );
        setCursor(nextCursor);
        setListFailure(null);
      } catch (cause) {
        try {
          guard();
          if (epoch.current !== request || signal?.aborted) return;
          setListFailure(
            before && cause instanceof CloudSpaceError && cause.status === 409
              ? "changed"
              : before
                ? "more"
                : "first",
          );
        } catch {
          /* Retired account/view. */
        }
      } finally {
        if (epoch.current === request) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [captureGuard, filesClient, projectsClient, spaceClient],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: Wait for the requested page and its paging action to commit together.
  useLayoutEffect(() => {
    const pending = pageFocus.current;
    if (!pending || cursor) return;
    pageFocus.current = null;
    const { activeElement, body } = pending.action.ownerDocument;
    if (
      epoch.current !== pending.request ||
      (activeElement !== pending.action && activeElement !== body)
    )
      return;
    const row = Array.from(
      popupRef.current?.querySelectorAll<HTMLButtonElement>(
        '[data-picker-entry]:not(:disabled):not([aria-disabled="true"])',
      ) ?? [],
    ).find((item) => !pending.previousRows.has(item.dataset.pickerEntry));
    if (row) row.focus();
    else pending.fallback.focus({ preventScroll: true });
  }, [entries, cursor]);

  // The picker owns an open view. Unrelated sidebar updates don't retire a choice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope retires reads and actions belonging to the previous account/conversation.
  useEffect(() => {
    epoch.current++;
    loadingRef.current = false;
    actionRef.current = null;
    setLoading(false);
    setBusy(false);
    setAttaching(undefined);
    if (!kind) return;
    const review = kind === "files" ? fileReview : undefined;
    setEntries(review?.files.map((file) => ({ id: file.id, name: file.name, file })) ?? []);
    setCursor(review?.nextCursor ?? "");
    setQuery(review?.name ?? "");
    setListFailure(null);
    setActionError("");
    focusAfterClose.current = review ? "composer" : "anchor";
    if (kind === "projects") void requestPage(kind);
    return () => {
      epoch.current++;
      attachmentRequest.current?.abort();
    };
  }, [kind, scope, requestPage, fileReview]);

  // The account and composer scope retire the previous search even when its text matches.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scope scopes results to the current conversation.
  useEffect(() => {
    if (!searchingLibrary) return;
    const controller = new AbortController();
    libraryRequest.current = controller;
    loadingRef.current = false;
    setEntries([]);
    setCursor("");
    setListFailure(null);
    setActionError("");
    setLoading(!queryTooLong);
    const read = () => void requestPage("library", "", null, libraryQuery, controller.signal);
    const timer = libraryQuery && !queryTooLong ? window.setTimeout(read, 180) : undefined;
    if (!libraryQuery) read();
    return () => {
      epoch.current++;
      window.clearTimeout(timer);
      controller.abort();
      libraryRequest.current = null;
    };
  }, [searchingLibrary, scope, libraryQuery, queryTooLong, requestPage]);

  async function choose(entry: Entry | null) {
    if (!kind || props.disabled || actionRef.current !== null) return;
    const request = epoch.current;
    actionRef.current = request;
    setBusy(true);
    setActionError("");
    const controller = entry?.resource ? new AbortController() : undefined;
    if (controller) {
      attachmentRequest.current = controller;
      setAttaching(entry?.id);
    }
    try {
      if (kind === "projects") await props.onSelectProject(entry?.project ?? null);
      else if (entry?.resource && controller)
        await props.onAttachResource(entry.resource, controller.signal);
      else if (entry?.file && cloudFileCanReference(entry.file)) props.onAttach(entry.file);
      if (epoch.current !== request || controller?.signal.aborted) return;
      focusAfterClose.current = kind === "files" ? "composer" : "anchor";
      props.onClose();
    } catch (cause) {
      if (epoch.current === request && !controller?.signal.aborted)
        setActionError(
          cause instanceof Error
            ? cause.message
            : copy("操作失败，请重试。", "Could not apply the change. Try again."),
        );
    } finally {
      if (actionRef.current === request) {
        actionRef.current = null;
        setBusy(false);
        setAttaching(undefined);
      }
      if (attachmentRequest.current === controller) attachmentRequest.current = null;
    }
  }
  function dismiss() {
    attachmentRequest.current?.abort();
    props.onClose();
  }
  function closeFor(action: () => void, focus: "composer" | "none" = "none") {
    if (!kind) return;
    focusAfterClose.current = focus;
    dismiss();
    action();
  }
  const title =
    visibleKind === "projects"
      ? copy("选择项目", "Choose a project")
      : visibleKind === "files"
        ? fileReview
          ? copy("核对最近文件", "Review recent files")
          : copy("添加文件", "Add files")
        : copy("插件与技能", "Plugins and skills");
  const filterLabel =
    visibleKind === "projects"
      ? copy("筛选项目", "Filter projects")
      : fileReview
        ? copy("筛选文件", "Filter files")
        : copy("搜索资料", "Search library");
  const uploadBlocked = Boolean(props.uploadDisabledReason) || props.disabled;
  const hasPageAction = Boolean(cursor || listFailure === "first");
  const initialFocus = () => (props.mobile ? popupRef.current : searchRef.current);
  const finalFocus = () => {
    if (focusAfterClose.current === "composer") {
      props.onFocusComposer();
      return false as const;
    }
    return focusAfterClose.current === "none" ? (false as const) : props.anchor;
  };
  const selectedProject = visibleKind === "projects" ? props.selectedProject : undefined;
  const filtered = searchingLibrary
    ? entries
    : entries.filter(
        (item) =>
          item.id !== selectedProject?.id &&
          item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
      );
  const extensionQuery = query.trim().toLocaleLowerCase();
  const matchingSkills = props.extensions.flatMap((pkg) => {
    const skill = extensionComposerEntry(pkg);
    return skill && extensionSearchText(pkg, skill).includes(extensionQuery)
      ? [{ pkg, skill }]
      : [];
  });
  const extensionGroups = [
    { kind: "plugin", label: copy("插件", "Plugins") },
    { kind: "skill", label: copy("独立技能", "Standalone skills") },
  ] as const;
  const content = (
    <div className="cloud-context-picker-body">
      {visibleKind === "files" && fileReview && !props.mobile ? (
        <h2 className="px-2.5 pb-1 pt-2 text-sm font-semibold">{title}</h2>
      ) : null}
      {visibleKind !== "tools" ? (
        <>
          {selectedProject ? (
            <section
              aria-label={copy("当前项目", "Current project")}
              className="mb-1 flex min-w-0 shrink-0 items-center gap-2 rounded-lg bg-muted/60 px-2.5 py-1.5"
            >
              <CloudProjectIcon
                icon={selectedProject.icon}
                color={selectedProject.color}
                className="size-4 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={selectedProject.name}>
                  {selectedProject.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {copy("当前项目", "Current project")}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="shrink-0 max-[820px]:min-h-11"
                aria-label={copy(
                  `从${selectedProject.name}移出`,
                  `Remove from ${selectedProject.name}`,
                )}
                disabled={busy || props.disabled}
                onClick={() => void choose(null)}
              >
                {copy("移出", "Remove")}
              </Button>
            </section>
          ) : null}
          <div className="cloud-context-picker-search">
            <Search className="size-4" aria-hidden="true" />
            <Input
              ref={searchRef}
              value={query}
              aria-label={filterLabel}
              placeholder={filterLabel}
              readOnly={Boolean(attaching)}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  popupRef.current
                    ?.querySelector<HTMLButtonElement>("[data-picker-entry]:not(:disabled)")
                    ?.focus();
                }
              }}
            />
          </div>
          {visibleKind === "files" && fileReview ? (
            <p className="cloud-picker-status">
              {copy(
                "选取已保存的文件，把它加到草稿。",
                "Select the saved file to add it to your draft.",
              )}
            </p>
          ) : null}
          {visibleKind === "projects" ? (
            <button
              type="button"
              className="cloud-picker-row"
              disabled={busy || props.disabled}
              onClick={() => closeFor(props.onCreateProject)}
            >
              <Plus className="size-4" />
              {copy("新建项目", "New project")}
            </button>
          ) : null}
          {searchingLibrary && filtered.length > 0 ? (
            <p className="cloud-picker-section-label">
              {libraryQuery ? copy("搜索结果", "Search results") : copy("最近资料", "Recent files")}
            </p>
          ) : null}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Delegates arrow keys from resource buttons without introducing a container tab stop. */}
          <div
            className="cloud-context-picker-results"
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
              ];
              const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (at < 0 || !buttons.length) return;
              event.preventDefault();
              buttons[
                (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
              ]?.focus();
            }}
          >
            {filtered.map((entry) => {
              const attached = visibleKind === "files" && props.attachedIds.includes(entry.id);
              const unavailable = entry.file
                ? !cloudFileCanReference(entry.file)
                : entry.resource?.kind === "artifact"
                  ? entry.resource.state !== "ready"
                  : entry.resource?.state === "uploading";
              const adding = attaching === entry.id;
              const blocked = Boolean(props.attachmentDisabledReason) && visibleKind === "files";
              const savedAt = fileReview && entry.file ? new Date(entry.file.created_at) : null;
              const details =
                fileReview && entry.file
                  ? [
                      formatUploadedFileSize(entry.file.size),
                      savedAt && Number.isFinite(savedAt.getTime())
                        ? savedAt.toLocaleString(locale, { dateStyle: "short", timeStyle: "short" })
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : null;
              return (
                <button
                  type="button"
                  key={entry.id}
                  data-picker-entry={entry.id}
                  className="cloud-picker-row"
                  aria-pressed={visibleKind === "files" ? attached : undefined}
                  disabled={
                    !adding && (busy || props.disabled || blocked || unavailable || attached)
                  }
                  aria-disabled={adding || undefined}
                  onClick={() => void choose(entry)}
                >
                  {entry.project ? (
                    <CloudProjectIcon
                      icon={entry.project.icon}
                      color={entry.project.color}
                      className="size-4 shrink-0"
                    />
                  ) : entry.resource ? (
                    <CloudSpaceFormatIcon item={entry.resource} className="size-4 shrink-0" />
                  ) : (
                    <FileText className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate" title={entry.name}>
                      {entry.name}
                    </span>
                    {details ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {details}
                      </span>
                    ) : null}
                    {unavailable && entry.file ? (
                      <span className="block text-xs text-muted-foreground">
                        {cloudFileStatus(entry.file, locale)}
                      </span>
                    ) : null}
                    {adding ? (
                      <span role="status" className="block text-xs text-muted-foreground">
                        {copy("正在添加…", "Adding…")}
                      </span>
                    ) : entry.resource && (unavailable || entry.resource.kind === "artifact") ? (
                      <span className="block text-xs text-muted-foreground">
                        {unavailable
                          ? copy("暂不可引用", "Unavailable to attach")
                          : entry.resource.site_version_id
                            ? copy("站点", "Site")
                            : copy("成果", "Artifact")}
                      </span>
                    ) : null}
                  </span>
                  {attached ? (
                    <Check className="size-4 shrink-0" aria-label={copy("已添加", "Added")} />
                  ) : null}
                </button>
              );
            })}
            {!loading && !listFailure && !filtered.length ? (
              <p role="status" className="cloud-picker-status">
                {searchingLibrary && queryTooLong
                  ? copy("搜索词太长，请缩短后再试。", "Shorten the search term and try again.")
                  : searchingLibrary && libraryQuery
                    ? copy("没有找到匹配的资料。", "No matching files or artifacts.")
                    : query
                      ? copy("已加载的条目中没有匹配结果。", "No matches in the loaded items.")
                      : visibleKind === "files"
                        ? copy("还没有可引用的文件。", "There are no files to attach yet.")
                        : selectedProject
                          ? copy("已加载的项目中没有其他可选项。", "No other loaded projects.")
                          : copy(
                              "还没有项目，创建一个开始工作。",
                              "Create a project to organize your work.",
                            )}
              </p>
            ) : null}
          </div>
          {actionError ? (
            <p role="alert" className="cloud-picker-status">
              {actionError}
            </p>
          ) : null}
          {listFailure && !loading ? (
            <p role="alert" className="cloud-picker-status">
              {listFailure === "changed"
                ? copy("资料列表已更新，请重新读取。", "The library changed. Reload this search.")
                : listFailure === "more"
                  ? copy(
                      "暂时无法加载更多。已加载的条目仍可使用。",
                      "Could not load more. You can still use the items already loaded.",
                    )
                  : copy("列表加载失败，请重试。", "Could not load this list. Try again.")}
            </p>
          ) : null}
          {loading && !hasPageAction ? (
            <p role="status" className="cloud-picker-status">
              {copy("正在加载…", "Loading…")}
            </p>
          ) : null}
          {hasPageAction ? (
            <button
              ref={listActionRef}
              type="button"
              className="cloud-picker-row"
              aria-disabled={loading || busy}
              onClick={() => {
                if (searchingLibrary) {
                  void requestPage(
                    "library",
                    listFailure === "changed" ? "" : cursor,
                    initialFocus(),
                    libraryQuery,
                    libraryRequest.current?.signal,
                  );
                } else if (kind && kind !== "tools") void requestPage(kind, cursor, initialFocus());
              }}
            >
              {loading ? (
                <span role="status">{copy("正在加载…", "Loading…")}</span>
              ) : listFailure === "more" ? (
                copy("重试加载更多", "Retry loading more")
              ) : listFailure === "changed" ? (
                copy("重新读取", "Reload results")
              ) : listFailure ? (
                copy("重试", "Retry")
              ) : (
                copy("加载更多", "Load more")
              )}
            </button>
          ) : null}
          {visibleKind === "projects" ? (
            <div className="cloud-picker-footer">
              <button
                type="button"
                className="cloud-picker-row"
                disabled={busy}
                onClick={() => closeFor(() => props.onBrowse("projects"))}
              >
                <FolderOpen className="size-4 shrink-0" aria-hidden="true" />
                {copy("管理项目", "Manage projects")}
                <ChevronRight className="ml-auto size-4 shrink-0" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {visibleKind === "files" ? (
            <>
              {(props.attachmentDisabledReason || props.uploadDisabledReason) && !attaching && (
                <p className="cloud-picker-status" role="status">
                  {props.attachmentDisabledReason || props.uploadDisabledReason}
                </p>
              )}
              <div className="cloud-picker-file-actions">
                {fileReview ? null : (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={uploadBlocked}
                    onClick={() => closeFor(props.onUpload, "composer")}
                  >
                    <Upload className="size-4" aria-hidden="true" />
                    {copy("上传文件", "Upload files")}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => closeFor(() => props.onBrowse("files"))}
                >
                  <BookOpen className="size-4" aria-hidden="true" />
                  {copy("浏览资料空间", "Browse library")}
                </Button>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <>
          <div className="cloud-context-picker-search">
            <Search className="size-4" aria-hidden="true" />
            <Input
              ref={searchRef}
              value={query}
              aria-label={copy("搜索插件与技能", "Search plugins and skills")}
              placeholder={copy("搜索插件与技能", "Search plugins and skills")}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  popupRef.current
                    ?.querySelector<HTMLButtonElement>("[data-picker-entry]:not(:disabled)")
                    ?.focus();
                }
              }}
            />
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Delegates keyboard navigation between the skill buttons. */}
          <div
            className="cloud-context-picker-results cloud-context-extension-results"
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              const buttons = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  "[data-picker-entry]:not(:disabled)",
                ),
              ];
              const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
              if (at < 0 || !buttons.length) return;
              event.preventDefault();
              buttons[
                (at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length
              ]?.focus();
            }}
          >
            {extensionGroups.map(({ kind, label }) => {
              const items = matchingSkills.filter(({ pkg }) => pkg.kind === kind);
              if (items.length === 0) return null;
              return (
                <fieldset className="min-w-0" key={kind}>
                  <legend className="cloud-picker-section-label">{label}</legend>
                  {items.map(({ pkg, skill }) => {
                    const name = extensionDisplayName(pkg, locale);
                    const description = extensionDescription(pkg, locale);
                    const selectedFile = props.selectedSkillFiles?.find(
                      (file) => parseExtensionReference(file)?.packageId === pkg.id,
                    );
                    const pinned = selectedFile ? parseExtensionReference(selectedFile) : undefined;
                    const summary =
                      pinned && props.onRemoveSkill
                        ? copy(
                            `草稿引用修订 ${pinned.version} · 点击移除`,
                            `Draft revision ${pinned.version} · Remove reference`,
                          )
                        : description;
                    return (
                      <div className="cloud-picker-extension-row" key={pkg.id}>
                        <button
                          type="button"
                          data-picker-entry
                          aria-pressed={Boolean(selectedFile)}
                          className="cloud-picker-row"
                          title={summary || name}
                          disabled={props.disabled}
                          onClick={() =>
                            closeFor(
                              () =>
                                selectedFile && props.onRemoveSkill
                                  ? props.onRemoveSkill(selectedFile)
                                  : props.onTryExtension(pkg, skill),
                              "composer",
                            )
                          }
                        >
                          <ExtensionMark id={pkg.id} small />
                          <span className="min-w-0 flex-1 truncate">
                            {name}
                            {summary && (
                              <span className="block truncate text-xs text-muted-foreground">
                                {summary}
                              </span>
                            )}
                          </span>
                          {selectedFile && <Check className="size-4 shrink-0" aria-hidden="true" />}
                        </button>
                        {props.onViewExtension && (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={copy(`查看${name}详情`, `View ${name} details`)}
                            onClick={() => closeFor(() => props.onViewExtension?.(pkg))}
                          >
                            <ChevronRight className="size-3.5" />
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </fieldset>
              );
            })}
            {props.extensionsLoading && (
              <p role="status" className="cloud-picker-status">
                {copy("正在加载插件与技能…", "Loading plugins and skills…")}
              </p>
            )}
            {props.extensionsFailed && (
              <div className="cloud-picker-status flex items-center justify-between gap-2">
                <p role="alert">
                  {copy("暂时无法加载插件与技能。", "Could not load plugins and skills.")}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="shrink-0 max-[820px]:min-h-11"
                  onClick={() => {
                    initialFocus()?.focus();
                    props.onRetryExtensions?.();
                  }}
                >
                  {copy("重试", "Retry")}
                </Button>
              </div>
            )}
            {!props.extensionsLoading && !props.extensionsFailed && !matchingSkills.length && (
              <p role="status" className="cloud-picker-status">
                {query
                  ? copy("没有匹配的插件或技能", "No matching plugins or skills")
                  : copy(
                      "还没有启用的插件或技能。",
                      "Explore the catalog to enable a plugin or skill.",
                    )}
              </p>
            )}
          </div>
          <button
            type="button"
            className="cloud-picker-row cloud-picker-footer"
            onClick={() => closeFor(props.onCustomize)}
          >
            <Blend className="size-4 shrink-0" aria-hidden="true" />
            {copy("发现插件与技能", "Explore plugins and skills")}
            <ChevronRight className="ml-auto size-4 shrink-0" aria-hidden="true" />
          </button>
        </>
      )}
      {busy && visibleKind === "projects" ? (
        <p role="status" className="cloud-picker-status">
          {copy("正在更新项目…", "Updating project…")}
        </p>
      ) : null}
    </div>
  );
  if (props.mobile)
    return (
      <Sheet
        open={kind !== null}
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
      >
        <SheetPopup
          ref={popupRef}
          side="bottom"
          data-browser-back-surface=""
          closeLabel={copy(`关闭${title}`, `Close ${title}`)}
          className="cloud-context-picker-sheet za-mobile-choice-sheet"
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          <SheetHeader className="px-5 pb-2 pt-5">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription className="sr-only">
              {copy(
                "选择当前账户的上下文，关闭后返回输入。",
                "Choose context from your account, then return to the composer.",
              )}
            </SheetDescription>
          </SheetHeader>
          {content}
        </SheetPopup>
      </Sheet>
    );
  return (
    <Popover
      open={kind !== null}
      onOpenChange={(open) => {
        if (!open) dismiss();
      }}
    >
      <PopoverContent
        ref={popupRef}
        anchor={props.anchor ?? undefined}
        side={visibleKind === "files" ? "top" : "bottom"}
        align="start"
        sideOffset={({ side }) => {
          if (!searchingLibrary || side !== "top" || !props.anchor) return 6;
          const card = props.anchor
            .closest("[data-composer-layout]")
            ?.querySelector("[data-composer-single-line]");
          return card
            ? 6 +
                Math.max(
                  0,
                  props.anchor.getBoundingClientRect().top - card.getBoundingClientRect().top,
                )
            : 6;
        }}
        aria-label={title}
        initialFocus={initialFocus}
        finalFocus={finalFocus}
        className={`cloud-context-picker max-w-[calc(100vw-24px)] p-1.5 ${visibleKind === "tools" ? "w-[352px]" : "w-72"}`}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
