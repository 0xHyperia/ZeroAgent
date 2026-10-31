import {
  BookOpen,
  ChartColumn,
  Check,
  FileText,
  FolderOpen,
  Globe,
  Plus,
  Search,
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
import { useEffect, useRef, useState } from "react";
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

export type CloudComposerPicker = "projects" | "files" | "tools";
export type CloudComposerMenu = CloudComposerPicker | "add" | null;

export function CloudChatWorkToolbar(props: {
  open: CloudComposerMenu;
  disabled: boolean;
  projectDisabled?: boolean;
  busy?: boolean;
  projectName?: string;
  onOpen: (kind: CloudComposerPicker, anchor: HTMLElement) => void;
}) {
  return (
    <div className="cloud-composer-context-tray" role="toolbar" aria-label="工作上下文">
      {(
        [
          {
            id: "projects",
            label: props.busy ? "正在更新项目…" : props.projectName || "选择项目",
            icon: FolderOpen,
          },
          { id: "files", label: "文件", icon: BookOpen },
          { id: "tools", label: "工具", icon: Globe },
        ] as const
      ).map(({ id, label, icon: Icon }) => (
        <Button
          key={id}
          variant="ghost"
          size="sm"
          disabled={props.disabled || (id === "projects" && props.projectDisabled)}
          aria-label={
            id === "projects" && props.projectName && !props.busy
              ? `当前项目：${props.projectName}`
              : label
          }
          aria-haspopup="dialog"
          aria-expanded={props.open === id}
          data-open={props.open === id || undefined}
          onClick={(event) => props.onOpen(id, event.currentTarget)}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          <span className="truncate">{label}</span>
        </Button>
      ))}
    </div>
  );
}

type Entry = { id: string; name: string; file?: CloudChatFile; project?: CloudProject };
export function CloudChatContextPicker(props: {
  kind: CloudComposerPicker | null;
  anchor: HTMLElement | null;
  mobile: boolean;
  scope: string;
  revision: number;
  projectsClient: CloudChatProjectsClient;
  filesClient: CloudChatFilesClient;
  captureGuard: CloudAccountGuard;
  attachedIds: readonly string[];
  selectedProjectId?: string;
  disabled: boolean;
  researchEnabled: boolean;
  onClose: () => void;
  onSelectProject: (project: CloudProject | null) => Promise<void>;
  onAttach: (file: CloudChatFile) => void;
  onBrowse: (kind: "projects" | "files") => void;
  onCreateProject: () => void;
  onToggleResearch: () => void;
  onFillDraft: (text: string) => void;
  onFocusComposer: () => void;
}) {
  const { kind, scope, revision, projectsClient, filesClient, captureGuard } = props;
  const lastKind = useRef<CloudComposerPicker>("files");
  if (kind) lastKind.current = kind;
  const visibleKind = kind ?? lastKind.current;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const loadingRef = useRef(false);
  const actionRef = useRef(false);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const focusAfterClose = useRef<"anchor" | "composer" | "none">("anchor");
  const loadPage = async (pageKind: "files" | "projects", before = "") => {
    if (pageKind === "files") {
      const page = await filesClient.list({ before });
      return {
        entries: page.files.map((file) => ({ id: file.id, name: file.name, file })),
        cursor: page.nextCursor,
      };
    }
    const page = await projectsClient.listProjects(before);
    return {
      entries: page.items.map((project) => ({ id: project.id, name: project.name, project })),
      cursor: page.next_before_id,
    };
  };
  // Each open/view/account refresh retires pending list results, including failures.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry/revision/scope explicitly invalidate this bounded page.
  useEffect(() => {
    const request = ++epoch.current;
    if (!kind) {
      setLoading(false);
      loadingRef.current = false;
      return;
    }
    setEntries([]);
    setCursor("");
    setQuery("");
    setError("");
    if (kind) focusAfterClose.current = "anchor";
    if (kind === "tools") {
      setLoading(false);
      loadingRef.current = false;
      return;
    }
    const guard = captureGuard();
    loadingRef.current = true;
    setLoading(true);
    void loadPage(kind)
      .then((page) => {
        guard();
        if (epoch.current === request) {
          setEntries(page.entries);
          setCursor(page.cursor);
        }
      })
      .catch(() => {
        try {
          guard();
          if (epoch.current === request) setError("加载失败，请重试。");
        } catch {
          /* Retired account/view. */
        }
      })
      .finally(() => {
        if (epoch.current === request) {
          loadingRef.current = false;
          setLoading(false);
        }
      });
    return () => {
      epoch.current++;
    };
  }, [kind, scope, revision, retry, projectsClient, filesClient, captureGuard]);
  async function more() {
    if (!kind || kind === "tools" || !cursor || loadingRef.current) return;
    const request = epoch.current,
      guard = captureGuard();
    loadingRef.current = true;
    setLoading(true);
    setError("");
    try {
      const page = await loadPage(kind, cursor);
      guard();
      if (epoch.current !== request) return;
      setEntries((old) => [
        ...old,
        ...page.entries.filter((item) => !old.some((other) => item.id === other.id)),
      ]);
      setCursor(page.cursor);
    } catch {
      try {
        guard();
        if (epoch.current === request) setError("加载失败，请重试。");
      } catch {
        /* Retired scope. */
      }
    } finally {
      if (epoch.current === request) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }
  async function choose(entry: Entry | null) {
    if (!kind || props.disabled || actionRef.current) return;
    const request = epoch.current;
    actionRef.current = true;
    setBusy(true);
    setError("");
    try {
      if (kind === "projects") await props.onSelectProject(entry?.project ?? null);
      else if (entry?.file && cloudFileCanReference(entry.file)) props.onAttach(entry.file);
      if (epoch.current !== request) return;
      focusAfterClose.current = kind === "files" ? "composer" : "anchor";
      props.onClose();
    } catch (cause) {
      if (epoch.current === request)
        setError(cause instanceof Error ? cause.message : "操作失败，请重试。");
    } finally {
      actionRef.current = false;
      setBusy(false);
    }
  }
  function closeFor(action: () => void, focus: "composer" | "none" = "none") {
    if (!kind) return;
    focusAfterClose.current = focus;
    props.onClose();
    action();
  }
  const title =
    visibleKind === "projects" ? "选择项目" : visibleKind === "files" ? "从资料库添加" : "选择工具";
  const initialFocus = () =>
    props.mobile || kind === "tools" ? popupRef.current : searchRef.current;
  const finalFocus = () => {
    if (focusAfterClose.current === "composer") {
      props.onFocusComposer();
      return false as const;
    }
    return focusAfterClose.current === "none" ? (false as const) : props.anchor;
  };
  const filtered = entries.filter((item) =>
    item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim()),
  );
  const content = (
    <div className="cloud-context-picker-body">
      {visibleKind !== "tools" ? (
        <>
          <div className="cloud-context-picker-search">
            <Search className="size-4" aria-hidden="true" />
            <Input
              ref={searchRef}
              value={query}
              aria-label={visibleKind === "projects" ? "筛选已加载项目" : "筛选已加载文件"}
              placeholder={visibleKind === "projects" ? "筛选已加载项目" : "筛选已加载文件"}
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
          {visibleKind === "projects" ? (
            <button
              type="button"
              className="cloud-picker-row"
              disabled={busy || props.disabled}
              onClick={() => closeFor(props.onCreateProject)}
            >
              <Plus className="size-4" />
              新建项目
            </button>
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
            {visibleKind === "projects" && props.selectedProjectId ? (
              <button
                type="button"
                data-picker-entry
                className="cloud-picker-row"
                disabled={busy || props.disabled}
                onClick={() => void choose(null)}
              >
                移出当前项目
              </button>
            ) : null}
            {filtered.map((entry) => {
              const attached = props.attachedIds.includes(entry.id);
              const unavailable = entry.file && !cloudFileCanReference(entry.file);
              const selected =
                visibleKind === "projects" ? props.selectedProjectId === entry.id : attached;
              return (
                <button
                  type="button"
                  key={entry.id}
                  data-picker-entry
                  className="cloud-picker-row"
                  aria-pressed={selected}
                  disabled={busy || props.disabled || Boolean(unavailable) || attached}
                  onClick={() => void choose(entry)}
                >
                  {entry.project ? (
                    <FolderOpen className="size-4 shrink-0" />
                  ) : (
                    <FileText className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0 flex-1 truncate">
                    {entry.name}
                    {unavailable && entry.file ? (
                      <span className="block text-xs text-muted-foreground">
                        {cloudFileStatus(entry.file)}
                      </span>
                    ) : null}
                  </span>
                  {selected ? (
                    <Check
                      className="size-4 shrink-0"
                      aria-label={attached ? "已添加" : "当前项目"}
                    />
                  ) : null}
                </button>
              );
            })}
            {!loading && !error && !filtered.length ? (
              <p role="status" className="cloud-picker-status">
                {query
                  ? "已加载的条目中没有匹配结果"
                  : visibleKind === "files"
                    ? "还没有可用文件，上传后会显示在这里。"
                    : "还没有项目，创建一个开始工作。"}
              </p>
            ) : null}
          </div>
          {loading ? (
            <p role="status" className="cloud-picker-status">
              正在加载…
            </p>
          ) : null}
          {cursor ? (
            <button
              type="button"
              className="cloud-picker-row"
              disabled={loading || busy}
              onClick={() => void more()}
            >
              加载更多
            </button>
          ) : null}
          {visibleKind === "files" ? (
            <button
              type="button"
              className="cloud-picker-row cloud-picker-footer"
              onClick={() => closeFor(() => props.onBrowse("files"))}
            >
              <BookOpen className="size-4" />
              浏览全部文件
            </button>
          ) : null}
        </>
      ) : (
        <>
          <button
            type="button"
            className="cloud-picker-row"
            aria-pressed={props.researchEnabled}
            disabled={props.disabled}
            onClick={() => closeFor(props.onToggleResearch, "composer")}
          >
            <Globe className="size-4 shrink-0" />
            <span>
              <span className="block">公开联网研究</span>
              <span className="block text-xs text-muted-foreground">
                发送前确认要公开搜索的研究主题
              </span>
            </span>
            {props.researchEnabled ? <Check className="ml-auto size-4" /> : null}
          </button>
          <button
            type="button"
            className="cloud-picker-row"
            disabled={props.disabled}
            onClick={() =>
              closeFor(
                () => props.onFillDraft("请帮我分析数据，先与我确认数据来源、分析目标和交付格式。"),
                "composer",
              )
            }
          >
            <ChartColumn className="size-4 shrink-0" />
            <span>
              <span className="block">数据分析</span>
              <span className="block text-xs text-muted-foreground">
                准备分析目标，发送后由云端执行
              </span>
            </span>
          </button>
        </>
      )}
      {busy ? (
        <p role="status" className="cloud-picker-status">
          正在更新项目…
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="cloud-picker-status text-destructive">
          {error}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => setRetry((old) => old + 1)}
          >
            重试
          </button>
        </div>
      ) : null}
    </div>
  );
  if (props.mobile)
    return (
      <Sheet
        open={kind !== null}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
      >
        <SheetPopup
          ref={popupRef}
          side="bottom"
          closeLabel={`关闭${title}`}
          className="cloud-context-picker-sheet rounded-t-3xl"
          initialFocus={initialFocus}
          finalFocus={finalFocus}
        >
          <SheetHeader className="px-5 pb-2 pt-5">
            <SheetTitle>{title}</SheetTitle>
            <SheetDescription className="sr-only">
              选择当前账户的上下文，关闭后返回输入。
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
        if (!open) props.onClose();
      }}
    >
      <PopoverContent
        ref={popupRef}
        anchor={props.anchor ?? undefined}
        side="bottom"
        align="start"
        sideOffset={6}
        aria-label={title}
        initialFocus={initialFocus}
        finalFocus={finalFocus}
        className="cloud-context-picker w-72 max-w-[calc(100vw-24px)] p-1.5"
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
