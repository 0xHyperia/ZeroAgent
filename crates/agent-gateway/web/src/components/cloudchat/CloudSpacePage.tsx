import { FileDropBoundary } from "@liveagent/ui/components/files/FileDropBoundary";
import {
  ArchiveRestore,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  FileText,
  FolderClosed,
  Globe,
  HardDrive,
  ImageIcon,
  LayoutGrid,
  List,
  LoaderCircle,
  Lock,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Share2,
  SquarePen,
  Star,
  Trash2,
  Upload,
  X,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { Input } from "@liveagent/ui/components/ui/input";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n";
import { useEffect, useRef, useState } from "react";
import type { CloudChatArtifactsClient } from "@/lib/cloudChatArtifacts";
import {
  CLOUD_FILE_ACCEPT,
  type CloudChatFilesClient,
  CloudFileUploadUnconfirmedError,
} from "@/lib/cloudChatFiles";
import { prepareCloudFileBatch } from "@/lib/cloudFileDrop";
import {
  CLOUD_RESOURCE_DRAG_MIME,
  hasCloudResourceDragPayload,
  readCloudResourceDragPayload,
  writeCloudResourceDragPayload,
} from "@/lib/cloudResourceDrag";
import {
  CLOUD_SPACE_HOME,
  type CloudSpaceClient,
  type CloudSpaceItem,
  type CloudSpaceLocation,
  CloudSpaceSaveUnconfirmedError,
  type CloudSpaceUsage,
  cloudSpaceSize,
  cloudSpaceTitle,
  type CloudSpacePage as SpacePage,
} from "@/lib/cloudSpace";
import { CloudChatFeedback } from "./CloudChatFeedback";
import { CloudSpaceCover, CloudSpaceFormatIcon, cloudSpaceFormat } from "./CloudSpaceCover";

export function CloudSpaceIcon({
  item,
  className = "",
}: {
  item: Pick<CloudSpaceItem, "kind" | "mime" | "site_version_id">;
  className?: string;
}) {
  const Icon =
    item.kind === "folder"
      ? FolderClosed
      : item.site_version_id
        ? Globe
        : item.mime.startsWith("image/")
          ? ImageIcon
          : FileText;
  return (
    <span
      className={`cloud-space-file-icon ${className}`}
      data-kind={item.kind}
      data-image={item.mime.startsWith("image/") || undefined}
    >
      <Icon className="size-5" />
    </span>
  );
}
export function CloudSpaceCapacity({
  usage,
  onClick,
}: {
  usage: CloudSpaceUsage;
  onClick?: () => void;
}) {
  const ratio = Math.min(100, (usage.used_bytes / usage.limit_bytes) * 100);
  const Root = onClick ? "button" : "div";
  return (
    <Root
      className="cloud-space-capacity"
      onClick={onClick}
      type={onClick ? "button" : undefined}
      aria-label={`存储空间：已用 ${cloudSpaceSize(usage.used_bytes)}，总共 ${cloudSpaceSize(usage.limit_bytes)}`}
    >
      <span>
        <HardDrive className="size-4" />
        <span>存储空间</span>
        <span className="ml-auto">{Math.round(ratio)}%</span>
      </span>
      <span className="cloud-space-meter">
        <span style={{ width: `${ratio}%` }} data-full={ratio >= 90 || undefined} />
      </span>
      <span className="cloud-space-capacity-label">
        已用 {cloudSpaceSize(usage.used_bytes)} / {cloudSpaceSize(usage.limit_bytes)}
      </span>
    </Root>
  );
}
function dateLabel(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}
function statusLabel(item: CloudSpaceItem) {
  if (item.kind === "folder") return "文件夹";
  if (item.site_version_id) {
    if (item.site_version_id !== item.target_id)
      return item.state === "staging" ? "站点 · 正在更新" : "站点 · 更新未完成";
    return `站点 · ${item.versions} 个版本`;
  }
  if (item.state === "ready" || item.state === "vision_ready")
    return item.kind === "artifact" ? `产出 · ${item.versions} 个版本` : "上传";
  return (
    (
      {
        uploading: "正在上传",
        uploaded: "原件已保存",
        processing: "正在解析",
        staging: "正在保存",
        failed: "解析或保存失败",
        unknown: "结果待核对",
        deleting: "正在删除",
      } as Record<string, string>
    )[item.state] ?? "暂不可用"
  );
}
type Editor = { type: "folder" | "rename" | "move" | "work"; items: CloudSpaceItem[] };
function SpaceSkeleton({ append = false }: { append?: boolean }) {
  return (
    <div className="cloud-space-skeleton" data-append={append || undefined} aria-hidden="true">
      {["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].slice(0, append ? 3 : 10).map((key) => (
        <div key={key}>
          <span className="cloud-space-skeleton-icon" />
          <span className="cloud-space-skeleton-name" />
          <span className="cloud-space-skeleton-date" />
          <span className="cloud-space-skeleton-size" />
        </div>
      ))}
    </div>
  );
}
type Props = {
  client: CloudSpaceClient;
  files: CloudChatFilesClient;
  artifacts: CloudChatArtifactsClient;
  revision?: number;
  active?: boolean;
  newFolderRequest?: number;
  storageOpen?: boolean;
  onStorageOpenChange?: (open: boolean) => void;
  location: CloudSpaceLocation;
  onNavigate: (location: CloudSpaceLocation) => void;
  onOpen: (item: CloudSpaceItem, action?: "share" | "settings") => void;
  onHandoff?: (item: CloudSpaceItem) => void;
  onReference: (
    items: readonly Pick<CloudSpaceItem, "kind" | "id" | "target_id" | "site_version_id">[],
  ) => Promise<void>;
  onCreateWork?: (text: string) => void;
  canReference: boolean;
  captureGuard: () => () => void;
  onChanged: () => void;
  onError: (cause: unknown) => void;
};

export function CloudSpacePage(props: Props) {
  const { locale } = useLocale();
  const siteView = props.location.category === "sites";
  const [workKind, setWorkKind] = useState("文档");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sitesEnabled, setSitesEnabled] = useState(false);
  const [page, setPage] = useState<SpacePage | null>(null),
    [items, setItems] = useState<CloudSpaceItem[]>([]);
  const [query, setQuery] = useState(""),
    [sort, setSort] = useState("updated"),
    [view, setView] = useState<"list" | "grid">("list");
  useEffect(() => {
    if (siteView) setView("grid");
  }, [siteView]);
  const [busy, setBusy] = useState(true),
    [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [unconfirmed, setUnconfirmed] = useState(false);
  const unconfirmedRef = useRef(false),
    reconcileRequested = useRef(false);
  const [revision, setRevision] = useState(0),
    [cursor, setCursor] = useState(""),
    [selected, setSelected] = useState<string[]>([]);
  const [loadedScope, setLoadedScope] = useState("");
  const loadSentinel = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null),
    [name, setName] = useState(""),
    [folder, setFolder] = useState("");
  const [internalCapacityOpen, setInternalCapacityOpen] = useState(false);
  const [draggingResources, setDraggingResources] = useState(false);
  const capacityOpen = props.storageOpen ?? internalCapacityOpen;
  const setCapacityOpen = props.onStorageOpenChange ?? setInternalCapacityOpen;
  const lastEditor = useRef<Editor | null>(null);
  if (editor) lastEditor.current = editor;
  const editorType = editor?.type ?? lastEditor.current?.type;
  const uploadRef = useRef<HTMLInputElement>(null),
    request = useRef<AbortController | null>(null),
    operation = useRef<AbortController | null>(null);
  const mounted = useRef(true),
    mutationLock = useRef(false),
    sequence = useRef(0),
    current = useRef(props);
  current.current = props;
  const { client, location } = props;
  useEffect(() => {
    const controller = new AbortController();
    const guard = current.current.captureGuard();
    setSitesEnabled(false);
    void props.artifacts.sites
      ?.enabled(controller.signal)
      .then((enabled) => {
        guard();
        if (!controller.signal.aborted) setSitesEnabled(enabled);
      })
      .catch(() => {
        /* The configured host owns site availability; ordinary creation remains usable. */
      });
    return () => controller.abort();
  }, [props.artifacts]);
  useEffect(() => {
    const clear = () => setDraggingResources(false);
    const observe = (event: DragEvent) => {
      if (
        current.current.active !== false &&
        event.dataTransfer &&
        hasCloudResourceDragPayload(event.dataTransfer)
      )
        setDraggingResources(true);
    };
    const leaveWindow = (event: DragEvent) => {
      if (
        !event.relatedTarget &&
        (event.clientX <= 0 ||
          event.clientY <= 0 ||
          event.clientX >= window.innerWidth ||
          event.clientY >= window.innerHeight)
      )
        clear();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") clear();
    };
    window.addEventListener("dragleave", leaveWindow);
    window.addEventListener("dragstart", observe);
    window.addEventListener("dragenter", observe);
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear, true);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("dragleave", leaveWindow);
      window.removeEventListener("dragstart", observe);
      window.removeEventListener("dragenter", observe);
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", key);
    };
  }, []);
  const locationKey = JSON.stringify(location);
  const scopeKey = JSON.stringify([locationKey, query, sort]);
  const replacingScope = loadedScope !== scopeKey;
  useEffect(() => {
    if (props.active === false) {
      setEditor(null);
      setCapacityOpen(false);
      setDraggingResources(false);
    }
  }, [props.active, setCapacityOpen]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      sequence.current++;
      request.current?.abort();
      operation.current?.abort();
    };
  }, []);
  // Location/query changes replace the result, pagination appends only to this query.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset selection and pagination when the result scope changes.
  useEffect(() => {
    setCursor("");
    setSelected([]);
  }, [locationKey, query, sort]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly refreshes the current query.
  useEffect(() => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const guard = props.captureGuard(),
      seq = ++sequence.current;
    setBusy(true);
    if (!unconfirmedRef.current) setError("");
    const timer = setTimeout(
      () => {
        void client
          .list(location, query, sort, cursor, controller.signal)
          .then((data) => {
            guard();
            if (!mounted.current || controller.signal.aborted || seq !== sequence.current) return;
            setPage(data);
            setLoadedScope(scopeKey);
            if (reconcileRequested.current) {
              reconcileRequested.current = false;
              unconfirmedRef.current = false;
              setUnconfirmed(false);
              setError("");
            }
            setItems((old) =>
              cursor
                ? [
                    ...old,
                    ...data.items.filter(
                      (item) =>
                        !old.some((prior) => prior.kind === item.kind && prior.id === item.id),
                    ),
                  ]
                : data.items,
            );
          })
          .catch((cause) => {
            if (controller.signal.aborted) return;
            try {
              guard();
              if (seq !== sequence.current) return;
              setError(
                cause instanceof TypeError
                  ? "暂时无法读取资料，请检查连接后重试。"
                  : cause instanceof Error
                    ? cause.message
                    : "资料加载失败",
              );
              current.current.onError(cause);
            } catch {
              /* retired account */
            }
          })
          .finally(() => {
            if (mounted.current && !controller.signal.aborted && seq === sequence.current)
              setBusy(false);
          });
      },
      query ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [client, query, sort, cursor, revision, props.revision, props.captureGuard, location]);
  useEffect(() => {
    const sentinel = loadSentinel.current;
    const next = page?.next_cursor;
    if (
      !sentinel ||
      !next ||
      next === cursor ||
      replacingScope ||
      busy ||
      working ||
      unconfirmed ||
      error ||
      props.active === false ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    let root = sentinel.parentElement;
    while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY))
      root = root.parentElement;
    const seq = sequence.current;
    let requested = false,
      active = true;
    const observer = new IntersectionObserver(
      (entries) => {
        if (
          !active ||
          requested ||
          seq !== sequence.current ||
          !entries.some((entry) => entry.isIntersecting)
        )
          return;
        requested = true;
        observer.disconnect();
        setCursor(next);
      },
      { root, rootMargin: "0px 0px 200px 0px" },
    );
    observer.observe(sentinel);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [page?.next_cursor, cursor, replacingScope, busy, working, unconfirmed, error, props.active]);
  function refresh() {
    if (unconfirmedRef.current) reconcileRequested.current = true;
    setCursor("");
    setRevision((value) => value + 1);
    props.onChanged();
  }
  async function run(action: (guard: () => void, signal: AbortSignal) => Promise<void>) {
    if (mutationLock.current || unconfirmedRef.current) return;
    mutationLock.current = true;
    const controller = new AbortController();
    operation.current = controller;
    const guard = props.captureGuard();
    setWorking(true);
    setError("");
    setNotice("");
    try {
      await action(() => {
        guard();
        if (!mounted.current || controller.signal.aborted) throw new Error("操作已结束");
      }, controller.signal);
      guard();
      if (mounted.current && !controller.signal.aborted) refresh();
    } catch (cause) {
      try {
        guard();
        if (mounted.current && !controller.signal.aborted) {
          if (
            cause instanceof CloudSpaceSaveUnconfirmedError ||
            cause instanceof CloudFileUploadUnconfirmedError
          ) {
            unconfirmedRef.current = true;
            setUnconfirmed(true);
          }
          setError(cause instanceof Error ? cause.message : "操作失败，请刷新后重试。");
          props.onError(cause);
        }
      } catch {
        /* retired account */
      }
    } finally {
      mutationLock.current = false;
      if (operation.current === controller) operation.current = null;
      if (mounted.current && !controller.signal.aborted) setWorking(false);
    }
  }
  function mutate(
    targets: CloudSpaceItem[],
    changes: Partial<Pick<CloudSpaceItem, "name" | "folder_id" | "starred" | "trashed">>,
  ) {
    return run(async (guard, signal) => {
      for (const item of targets) {
        guard();
        await client.update(item, changes, signal);
        guard();
        setSelected((old) => old.filter((id) => id !== item.id));
      }
      setEditor(null);
      setNotice(
        changes.trashed === true
          ? "已移入回收站。恢复前仍占用存储空间，原对话引用保留。"
          : changes.trashed === false
            ? "资料已恢复。"
            : "已保存。",
      );
    });
  }
  async function upload(files: File[], directories = 0) {
    if (props.active === false) return;
    if (mutationLock.current || unconfirmedRef.current) {
      setError(
        unconfirmedRef.current
          ? "请先刷新核对上次操作结果，再上传资料。"
          : "正在保存资料，请等待当前操作完成。",
      );
      return;
    }
    const batch = prepareCloudFileBatch(files, 20, directories);
    if (!batch.files.length) {
      if (batch.message) setError(batch.message);
      return;
    }
    await run(async (guard, signal) => {
      let count = 0;
      for (const file of batch.files) {
        guard();
        const saved = await props.files.upload(file, "", signal);
        guard();
        count++;
        if (location.folder)
          await client.update(
            {
              id: saved.id,
              kind: "file",
              name: saved.name,
              folder_id: "",
              starred: false,
              trashed: false,
              version: 0,
            },
            { folder_id: location.folder },
            signal,
          );
      }
      guard();
      setNotice(`已上传 ${count} 个文件。${batch.message}`);
    });
  }
  function openEditor(type: Editor["type"], targets: CloudSpaceItem[]) {
    setEditor({ type, items: targets });
    setName(type === "rename" ? targets[0].name : "");
    setFolder(targets[0]?.folder_id ?? "");
  }
  function navigate(next: CloudSpaceLocation) {
    setQuery("");
    setCursor("");
    props.onNavigate(next);
  }
  function open(item: CloudSpaceItem) {
    if (item.kind === "folder") navigate({ ...CLOUD_SPACE_HOME, folder: item.id });
    else props.onOpen(item);
  }
  const lastFolderRequest = useRef(props.newFolderRequest ?? 0);
  useEffect(() => {
    if (
      props.newFolderRequest === undefined ||
      props.newFolderRequest === lastFolderRequest.current
    )
      return;
    lastFolderRequest.current = props.newFolderRequest;
    if (!working && !unconfirmed) {
      setEditor({ type: "folder", items: [] });
      setName("");
      setFolder("");
    }
  }, [props.newFolderRequest, working, unconfirmed]);
  const typeOptions = [
    ["", "全部类型"],
    ["document", "文档"],
    ["spreadsheet", "表格"],
    ["presentation", "演示文稿"],
    ["pdf", "PDF"],
    ["image", "图片"],
    ["media", "音频与视频"],
    ["code", "代码与其他"],
    ["archive", "压缩包"],
    ["folder", "文件夹"],
  ];
  const originOptions = [
    ["", "全部来源"],
    ["uploads", "上传"],
    ["outputs", "AI 产出"],
  ];
  const filterMenu = (
    label: string,
    value: string,
    options: string[][],
    select: (value: string) => void,
  ) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="cloud-space-filter"
            data-active={!!value || undefined}
            aria-label={`${label}：${options.find((option) => option[0] === value)?.[1] ?? label}`}
          />
        }
      >
        {value || filtersOpen ? options.find((option) => option[0] === value)?.[1] : label}
        <ChevronDown className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" variant="soft" className="cloud-space-menu">
        {options.map(([id, text]) => (
          <DropdownMenuItem key={id} onClick={() => select(id)}>
            {value === id ? <Check className="size-4" /> : <span className="size-4" />}
            {text}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const targets = items.filter((item) => selected.includes(item.id));
  const sortOptions = [
    { id: "updated", label: "最近修改" },
    { id: "name", label: "名称" },
    { id: "size", label: "文件大小" },
  ];
  const sortLabel = sortOptions.find((option) => option.id === sort)?.label;
  const allLoadedSelected = items.length > 0 && targets.length === items.length;
  const heading =
    page?.folders.find((item) => item.id === location.folder)?.name ?? cloudSpaceTitle(location);
  const frozen = (busy && !cursor) || replacingScope || working || unconfirmed;
  const itemMenu = (item: CloudSpaceItem) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <TooltipButton
            variant="ghost"
            size="icon-sm"
            title="更多操作"
            aria-label={`${item.name}的更多操作`}
            className="cloud-space-row-more"
            disabled={frozen}
          />
        }
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" variant="soft" className="cloud-space-menu">
        <DropdownMenuItem
          onClick={() =>
            setSelected((current) =>
              current.includes(item.id)
                ? current.filter((id) => id !== item.id)
                : [...current, item.id],
            )
          }
        >
          <Check className="size-4" />
          {selected.includes(item.id) ? "取消选择" : "选择资料"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open(item)}>
          <ArrowUpRight className="size-4" />
          {item.site_version_id ? "打开站点" : `打开${item.kind === "folder" ? "文件夹" : "预览"}`}
        </DropdownMenuItem>
        {props.onHandoff &&
          item.kind !== "folder" &&
          !item.trashed &&
          ["ready", "vision_ready"].includes(item.state) && (
            <DropdownMenuItem onClick={() => props.onHandoff?.(item)}>
              {locale === "zh-CN" ? "发送到工作区" : "Send to workspace"}
            </DropdownMenuItem>
          )}
        {item.site_version_id && !item.trashed ? (
          <>
            <DropdownMenuItem onClick={() => props.onOpen(item, "share")}>
              <Share2 className="size-4" />
              分享
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => props.onOpen(item, "settings")}>
              <Settings2 className="size-4" />
              站点设置
            </DropdownMenuItem>
          </>
        ) : null}
        {item.kind !== "folder" && !item.trashed ? (
          <DropdownMenuItem
            disabled={!props.canReference}
            onClick={() =>
              void run(async (guard) => {
                await props.onReference([item]);
                guard();
              })
            }
          >
            <Plus className="size-4" />
            在对话中使用
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => void mutate([item], { starred: !item.starred })}>
          <Star className="size-4" />
          {item.starred ? "取消收藏" : "收藏"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openEditor("rename", [item])}>
          <SquarePen className="size-4" />
          重命名
        </DropdownMenuItem>
        {item.kind !== "folder" ? (
          <DropdownMenuItem onClick={() => openEditor("move", [item])}>
            <FolderClosed className="size-4" />
            移动到文件夹
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void mutate([item], { trashed: !item.trashed })}>
          {item.trashed ? <ArchiveRestore className="size-4" /> : <Trash2 className="size-4" />}
          {item.trashed ? "恢复资料" : "移入回收站"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  // Keep one keyed list across layouts so grouping never recreates loaded covers.
  const folders = items.filter((item) => item.kind === "folder");
  const documents = items.filter((item) => item.kind !== "folder");
  const entries: Array<CloudSpaceItem | "folders" | "files"> =
    view === "grid" && !siteView && folders.length
      ? ["folders", ...folders, ...(documents.length ? ["files" as const, ...documents] : [])]
      : items;
  return (
    <FileDropBoundary
      className={`cloud-space-page ${siteView ? "cloud-space-sites" : ""}`}
      aria-label="个人资料空间"
      active={props.active !== false}
      resetKey={locationKey}
      fileLabel={`松开上传到${location.folder ? `“${heading}”` : "资料空间"}`}
      hint="单个文件不超过32 MiB；上传不会自动发送消息"
      disabledReason={
        unconfirmed
          ? "请先刷新核对上次操作结果，再上传资料。"
          : working
            ? "正在保存资料，请等待当前操作完成。"
            : location.scope === "trash"
              ? "请先返回资料空间或文件夹，再上传资料。"
              : undefined
      }
      onFiles={(files, directories) => void upload(files, directories)}
      onRejected={setError}
    >
      <header className="cloud-space-heading">
        <div className="min-w-0">
          <h1>{heading}</h1>
        </div>
        <div className="cloud-space-heading-actions">
          <div className="cloud-space-search">
            <Search className="size-4" />
            <Input
              aria-label="搜索全部资料"
              placeholder={siteView ? "搜索站点" : "搜索资料"}
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <TooltipButton
                title="清除搜索"
                aria-label="清除搜索"
                variant="ghost"
                size="icon-sm"
                onClick={() => setQuery("")}
              >
                <X className="size-3.5" />
              </TooltipButton>
            ) : null}
            <TooltipButton
              className="cloud-space-mobile-filter"
              title="筛选资料"
              aria-label="筛选资料"
              variant="ghost"
              size="icon-sm"
              onClick={() => setFiltersOpen(true)}
            >
              <Settings2 className="size-4" />
            </TooltipButton>
          </div>
          <Button
            variant="outline"
            className="cloud-space-upload"
            disabled={working || unconfirmed}
            onClick={() => uploadRef.current?.click()}
          >
            <Upload className="size-4" />
            <span>上传</span>
          </Button>
          {siteView && props.onCreateWork ? (
            <Button
              className="cloud-space-create"
              disabled={working || unconfirmed || !props.canReference}
              onClick={() => {
                setWorkKind("站点");
                openEditor("work", []);
              }}
            >
              <Plus className="size-4" />
              创建站点
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button className="cloud-space-create" disabled={working || unconfirmed} />}
              >
                <Plus className="size-4" />用 AI 创建
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" variant="soft" className="cloud-space-menu">
                {props.onCreateWork ? (
                  <>
                    {["文档", "表格", "演示文稿", ...(sitesEnabled ? ["站点"] : [])].map((kind) => (
                      <DropdownMenuItem
                        key={kind}
                        disabled={!props.canReference}
                        onClick={() => {
                          setWorkKind(kind);
                          openEditor("work", []);
                        }}
                      >
                        {kind === "站点" ? (
                          <Globe className="size-4" />
                        ) : (
                          <FileText className="size-4" />
                        )}
                        {kind}
                        <span className="ml-auto text-xs text-muted-foreground">
                          用 ZeroAgent 创作
                        </span>
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuItem onClick={() => openEditor("folder", [])}>
                  <FolderClosed className="size-4" />
                  新建文件夹
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => uploadRef.current?.click()}>
                  <Upload className="size-4" />
                  上传文件
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>
      {draggingResources ? (
        <FileDropBoundary
          className="cloud-space-reference-drop"
          active={props.active !== false}
          resourceMime={CLOUD_RESOURCE_DRAG_MIME}
          fileLabel=""
          resourceLabel="松开引用到当前草稿"
          hint="添加后返回同一草稿，不会自动发送"
          disabledReason={
            !props.canReference || frozen ? "请等待当前操作完成后再引用资料。" : undefined
          }
          onRejected={setError}
          onResources={(transfer) => {
            const identities = readCloudResourceDragPayload(transfer);
            if (!identities) {
              setError("资料身份无效，请重新选择。");
              return;
            }
            void run(async (guard) => {
              guard();
              await props.onReference(identities);
              guard();
            });
          }}
        >
          <ArrowUpRight className="size-5" />
          <span>放到此处，在当前对话中使用</span>
          <span>添加到原草稿后继续编辑</span>
        </FileDropBoundary>
      ) : null}
      <input
        ref={uploadRef}
        type="file"
        accept={CLOUD_FILE_ACCEPT}
        multiple
        className="hidden"
        aria-label="上传资料到个人空间"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void upload(files);
        }}
      />
      <nav className="cloud-space-mobile-nav" aria-label="资料视图">
        {(
          [
            { category: "recent", scope: "all", label: "最近" },
            { category: "all", scope: "all", label: "全部资料" },
            { category: "all", scope: "starred", label: "收藏" },
            { category: "sites", scope: "all", label: "站点" },
          ] as const
        ).map((tab) => (
          <button
            key={tab.label}
            type="button"
            aria-current={
              !location.folder && location.category === tab.category && location.scope === tab.scope
                ? "page"
                : undefined
            }
            onClick={() =>
              navigate({ ...CLOUD_SPACE_HOME, category: tab.category, scope: tab.scope })
            }
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="cloud-space-toolbar">
        <span className="cloud-space-mobile-list-label">名称</span>
        <div className="cloud-space-filters">
          {location.folder ? (
            <TooltipButton
              variant="ghost"
              size="icon-sm"
              title="返回全部资料"
              aria-label="返回全部资料"
              onClick={() => navigate(CLOUD_SPACE_HOME)}
            >
              <ArrowLeft className="size-4" />
            </TooltipButton>
          ) : null}
          {!siteView &&
            filterMenu("类型", location.type ?? "", typeOptions, (type) =>
              props.onNavigate({ ...location, type }),
            )}
          {!siteView &&
            filterMenu("来源", location.origin ?? "", originOptions, (origin) =>
              props.onNavigate({ ...location, origin: origin as CloudSpaceLocation["origin"] }),
            )}
          {filterMenu(
            "位置",
            location.folder,
            [["", "全部位置"], ...(page?.folders.map((item) => [item.id, item.name]) ?? [])],
            (folder) => props.onNavigate({ ...location, folder }),
          )}
          {location.type || location.origin ? (
            <TooltipButton
              variant="ghost"
              size="icon-sm"
              title="清除筛选"
              aria-label="清除筛选"
              onClick={() => props.onNavigate({ ...location, type: "", origin: "" })}
            >
              <X className="size-3.5" />
            </TooltipButton>
          ) : null}
        </div>
        <div className="cloud-space-view-tools">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="cloud-space-sort"
                  aria-label={`资料排序：${sortLabel}`}
                />
              }
            >
              <span>{sortLabel}</span>
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" variant="soft" className="cloud-space-menu">
              {sortOptions.map((option) => (
                <DropdownMenuItem key={option.id} onClick={() => setSort(option.id)}>
                  {sort === option.id ? <Check className="size-4" /> : <span className="size-4" />}
                  {option.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <span className="cloud-space-tool-divider" />
          <TooltipButton
            variant="ghost"
            size="icon-sm"
            title="列表视图"
            aria-label="列表视图"
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <List className="size-4" />
          </TooltipButton>
          <TooltipButton
            variant="ghost"
            size="icon-sm"
            title="网格视图"
            aria-label="网格视图"
            aria-pressed={view === "grid"}
            onClick={() => setView("grid")}
          >
            <LayoutGrid className="size-4" />
          </TooltipButton>
          <TooltipButton
            variant="ghost"
            size="icon-sm"
            title="刷新资料"
            aria-label="刷新资料"
            disabled={busy || working}
            onClick={refresh}
          >
            <RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />
          </TooltipButton>
        </div>
      </div>
      {location.scope === "trash" ? (
        <CloudChatFeedback
          compact
          message="回收站里的资料仍占用空间"
          description="恢复后可继续整理。彻底删除请打开原件预览；删除后，已有对话中的引用也会失效。"
        />
      ) : null}
      {error ? (
        <CloudChatFeedback
          tone="error"
          message={error}
          actions={
            <Button variant="outline" size="sm" disabled={busy || working} onClick={refresh}>
              刷新核对
            </Button>
          }
        />
      ) : null}
      {notice ? (
        <CloudChatFeedback compact message={notice} onDismiss={() => setNotice("")} />
      ) : null}
      {working ? (
        <CloudChatFeedback
          compact
          busy
          message="正在保存资料…"
          description="请保留当前页面，完成后列表会自动更新。"
        />
      ) : null}
      <div
        className="cloud-space-results-caption"
        data-quiet={!query && location.scope !== "trash" ? "" : undefined}
      >
        <span className="cloud-space-results-title">
          {query
            ? `“${query}”的搜索结果`
            : location.scope === "trash"
              ? "已移入回收站"
              : "你的资料"}
        </span>
        <span role="status" aria-live="polite" className="cloud-space-results-status">
          {busy
            ? query
              ? "正在搜索…"
              : cursor
                ? "正在加载更多…"
                : page
                  ? "正在更新…"
                  : "正在加载…"
            : page
              ? items.length < page.total
                ? `已显示 ${items.length} / ${page.total} 项`
                : `${page.total} 项`
              : ""}
        </span>
      </div>
      <div className="cloud-space-results" aria-busy={busy} data-view={view}>
        {(busy || replacingScope) && (replacingScope || items.length === 0) && !error ? (
          <SpaceSkeleton />
        ) : null}
        {page && items.length === 0 && !busy && !error ? (
          <div className="cloud-space-empty">
            <div>
              <span className="cloud-space-empty-icon">
                {query ? (
                  <Search />
                ) : location.scope === "trash" ? (
                  <Trash2 />
                ) : location.scope === "starred" ? (
                  <Star />
                ) : (
                  <FolderClosed />
                )}
              </span>
            </div>
            <h2>
              {query
                ? "没有找到匹配的资料"
                : location.scope === "trash"
                  ? "回收站是空的"
                  : location.scope === "starred"
                    ? "把常用资料放在手边"
                    : location.folder
                      ? "这个文件夹还是空的"
                      : location.category === "outputs" || location.category === "sites"
                        ? "把创作成果保存在这里"
                        : location.category !== "all" && location.category !== "uploads"
                          ? "这个分类还没有资料"
                          : "从一份资料开始"}
            </h2>
            <p>
              {query
                ? "试试其他名称，或清除搜索。"
                : location.scope === "starred"
                  ? "收藏后，常用资料会出现在这里。"
                  : location.scope === "trash"
                    ? "移入回收站的资料可以在这里恢复。"
                    : location.folder
                      ? "上传文件到此处，或在全部资料中选择文件后移动到这个文件夹。"
                      : location.category === "outputs" || location.category === "sites"
                        ? "在对话中提出创作目标，正式保存的成果会自动出现在资料空间。"
                        : location.category !== "all" && location.category !== "uploads"
                          ? "可以上传相关文件，或回到全部资料继续查找。"
                          : "上传文件，交给 ZeroAgent 理解、整理并继续创作。工作产出也会保存在这里。"}
            </p>
            {query ? (
              <Button variant="outline" onClick={() => setQuery("")}>
                清除搜索
              </Button>
            ) : location.scope === "all" &&
              !location.folder &&
              location.category !== "all" &&
              location.category !== "uploads" ? (
              <Button variant="outline" onClick={() => navigate(CLOUD_SPACE_HOME)}>
                查看全部资料
              </Button>
            ) : location.scope === "all" ? (
              <Button onClick={() => uploadRef.current?.click()} disabled={working || unconfirmed}>
                <Upload className="size-4" />
                上传资料
              </Button>
            ) : null}
          </div>
        ) : null}
        {items.length && !replacingScope ? (
          <>
            <div className="cloud-space-table-head">
              <label className="cloud-space-select-all">
                <input
                  type="checkbox"
                  aria-label="全选已加载资料"
                  checked={allLoadedSelected}
                  ref={(input) => {
                    if (input) input.indeterminate = targets.length > 0 && !allLoadedSelected;
                  }}
                  disabled={frozen}
                  onChange={(event) =>
                    setSelected(event.target.checked ? items.map((item) => item.id) : [])
                  }
                />
                <span>名称</span>
              </label>
              <span>修改日期</span>
              <span>大小</span>
              <span />
            </div>
            <ul className="cloud-space-item-list">
              {entries.map((item) =>
                typeof item === "string" ? (
                  <li
                    key={`section:${item}`}
                    className="cloud-space-grid-section"
                    role="presentation"
                  >
                    <h2>{item === "folders" ? "文件夹" : "文件"}</h2>
                  </li>
                ) : (
                  <li
                    key={`${item.kind}:${item.id}`}
                    className="cloud-space-item"
                    data-folder={item.kind === "folder" || undefined}
                    data-selected={selected.includes(item.id) || undefined}
                  >
                    <label className="cloud-space-check">
                      <input
                        type="checkbox"
                        aria-label={`选择 ${item.name}`}
                        checked={selected.includes(item.id)}
                        disabled={frozen}
                        onChange={(event) =>
                          setSelected((old) =>
                            event.target.checked
                              ? [...old, item.id]
                              : old.filter((id) => id !== item.id),
                          )
                        }
                      />
                    </label>
                    <div className="cloud-space-item-content">
                      <div className="cloud-space-cover-target">
                        <CloudSpaceCover
                          item={item}
                          showPreview={view === "grid" && props.active !== false}
                          files={props.files}
                          artifacts={props.artifacts}
                          captureGuard={props.captureGuard}
                        />
                        <button
                          type="button"
                          className="cloud-space-cover-open"
                          aria-label={`打开 ${item.name}`}
                          disabled={frozen}
                          onClick={() => open(item)}
                        />
                      </div>
                      <button
                        type="button"
                        className="cloud-space-item-main"
                        draggable={!frozen && !item.trashed && item.kind !== "folder"}
                        onDragStart={(event) => {
                          if (frozen || item.trashed || item.kind === "folder") {
                            event.preventDefault();
                            return;
                          }
                          const sources = selected.includes(item.id)
                            ? targets.filter(
                                (target) => target.kind !== "folder" && !target.trashed,
                              )
                            : [item];
                          if (
                            !writeCloudResourceDragPayload(
                              event.dataTransfer,
                              sources.flatMap((source) =>
                                source.kind === "folder"
                                  ? []
                                  : [
                                      {
                                        kind: source.kind,
                                        id: source.id,
                                        target_id: source.target_id,
                                        ...(source.site_version_id
                                          ? { site_version_id: source.site_version_id }
                                          : {}),
                                      },
                                    ],
                              ),
                            )
                          ) {
                            event.preventDefault();
                            setError("一次最多拖动8份资料，请减少选择后再试。");
                          } else setDraggingResources(true);
                        }}
                        onDragEnd={() => setDraggingResources(false)}
                        onClick={() => open(item)}
                        disabled={frozen}
                      >
                        <span className="cloud-space-card-type" aria-hidden="true">
                          <CloudSpaceFormatIcon item={item} />
                        </span>
                        <span className="cloud-space-item-name">
                          <strong title={item.name}>
                            {item.site_version_id ? item.name.replace(/\.zip$/i, "") : item.name}
                          </strong>
                          <span
                            className="cloud-space-item-meta"
                            data-pending={
                              (item.kind !== "folder" &&
                                !["ready", "vision_ready", "uploaded"].includes(item.state)) ||
                              undefined
                            }
                          >
                            {item.site_version_id ? (
                              <>
                                <Lock className="size-3" />
                                私人预览 · {dateLabel(item.updated_at)}
                              </>
                            ) : (
                              <>
                                {cloudSpaceFormat(item)}
                                {item.kind !== "folder" ? ` · ${cloudSpaceSize(item.size)}` : ""}
                              </>
                            )}
                            {!["ready", "vision_ready", "uploaded"].includes(item.state)
                              ? ` · ${statusLabel(item)}`
                              : ""}
                          </span>
                          <span className="cloud-space-item-mobile-meta">
                            {item.kind === "folder"
                              ? "文件夹"
                              : `${page?.folders.find((folder) => folder.id === item.folder_id)?.name ?? (item.kind === "artifact" ? "AI 产出" : "资料空间")} · ${dateLabel(item.updated_at)}`}
                          </span>
                        </span>
                        {item.starred ? <Star className="cloud-space-star size-3.5" /> : null}
                      </button>
                    </div>
                    <time
                      className="cloud-space-cell"
                      dateTime={item.updated_at}
                      title={new Date(item.updated_at).toLocaleString("zh-CN")}
                    >
                      {dateLabel(item.updated_at)}
                    </time>
                    <span className="cloud-space-cell cloud-space-size">
                      {item.kind === "folder" ? "—" : cloudSpaceSize(item.size)}
                    </span>
                    {itemMenu(item)}
                  </li>
                ),
              )}
            </ul>
          </>
        ) : null}
        {busy && cursor && !replacingScope && items.length > 0 ? <SpaceSkeleton append /> : null}
        <div ref={loadSentinel} className="cloud-space-load-sentinel" aria-hidden="true" />
      </div>
      {selected.length ? (
        <div className="cloud-space-selection">
          <strong>{selected.length} 项已选择</strong>
          <Button variant="ghost" size="sm" aria-label="取消选择" onClick={() => setSelected([])}>
            <X className="size-4" />
            取消
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={
              frozen ||
              !props.canReference ||
              targets.some((item) => item.kind === "folder" || item.trashed) ||
              selected.length > 8
            }
            onClick={() =>
              void run(async (guard) => {
                await props.onReference(targets);
                guard();
              })
            }
          >
            <Plus className="size-4" />
            在对话中使用
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={frozen || targets.some((item) => item.kind === "folder")}
            onClick={() => openEditor("move", targets)}
          >
            <FolderClosed className="size-4" />
            移动
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={frozen}
            onClick={() => void mutate(targets, { trashed: location.scope !== "trash" })}
          >
            {location.scope === "trash" ? (
              <ArchiveRestore className="size-4" />
            ) : (
              <Trash2 className="size-4" />
            )}
            {location.scope === "trash" ? "恢复" : "移入回收站"}
          </Button>
        </div>
      ) : null}
      <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
        <DialogContent
          className="cloud-space-editor cloud-space-filter-dialog"
          showCloseButton
          closeLabel="关闭资料筛选"
        >
          <DialogHeader>
            <DialogTitle>筛选资料</DialogTitle>
            <DialogDescription>按类型、来源和位置组合查找。</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="cloud-space-filter-fields">
              <div>
                <span>类型</span>
                {filterMenu("类型", location.type ?? "", typeOptions, (type) =>
                  props.onNavigate({ ...location, type }),
                )}
              </div>
              <div>
                <span>来源</span>
                {filterMenu("来源", location.origin ?? "", originOptions, (origin) =>
                  props.onNavigate({ ...location, origin: origin as CloudSpaceLocation["origin"] }),
                )}
              </div>
              <div>
                <span>位置</span>
                {filterMenu(
                  "位置",
                  location.folder,
                  [["", "全部位置"], ...(page?.folders.map((item) => [item.id, item.name]) ?? [])],
                  (folder) => props.onNavigate({ ...location, folder }),
                )}
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => props.onNavigate({ ...location, type: "", origin: "", folder: "" })}
            >
              重置
            </Button>
            <Button onClick={() => setFiltersOpen(false)}>完成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => {
          if (!working && !open) setEditor(null);
        }}
      >
        <DialogContent
          showCloseButton
          closeLabel="关闭资料编辑"
          closeDisabled={working}
          className="cloud-space-editor"
        >
          <DialogHeader>
            <DialogTitle>
              {editorType === "work"
                ? `创建${workKind}`
                : editorType === "folder"
                  ? "新建文件夹"
                  : editorType === "rename"
                    ? "重命名"
                    : "移动资料"}
            </DialogTitle>
            <DialogDescription>
              {editorType === "work"
                ? "描述你的目标，下一步在对话中继续。发送前可以编辑，成果保存后会出现在资料空间。"
                : editorType === "move"
                  ? "选择资料的存放位置。原对话引用不会改变。"
                  : "名称只影响资料空间的整理，原件和历史引用会保留。"}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!editor || unconfirmedRef.current) return;
              if (editor.type === "work") {
                props.onCreateWork?.(
                  workKind === "站点"
                    ? "请根据以下目标创建一个可交互的静态站点，构建并检查后保存到我的资料空间，供我预览。保持私有，未经我确认不要创建分享链接：\n\n" +
                        name.trim()
                    : `请根据以下目标创建一份${workKind}，提供可下载的文件，并保存到我的资料空间：\n\n${name.trim()}`,
                );
                setEditor(null);
                return;
              }
              if (editor.type === "folder")
                void run(async (guard, signal) => {
                  await client.update(
                    {
                      id: crypto.randomUUID(),
                      kind: "folder",
                      name: name.trim(),
                      folder_id: "",
                      starred: false,
                      trashed: false,
                      version: 0,
                    },
                    {},
                    signal,
                  );
                  guard();
                  setEditor(null);
                });
              else
                void mutate(
                  editor.items,
                  editor.type === "rename" ? { name: name.trim() } : { folder_id: folder },
                );
            }}
          >
            <DialogBody>
              {editorType === "work" ? (
                <Textarea
                  aria-label="创作目标"
                  placeholder="你想创作什么？可以说明主题、读者和内容要求。"
                  value={name}
                  maxLength={2048}
                  rows={5}
                  onChange={(event) => setName(event.target.value)}
                />
              ) : editorType === "move" ? (
                <div className="cloud-space-folder-options">
                  {[{ id: "", name: "全部资料" }, ...(page?.folders ?? [])].map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      aria-pressed={folder === item.id}
                      disabled={working || unconfirmed}
                      onClick={() => setFolder(item.id)}
                    >
                      <FolderClosed className="size-4" />
                      {item.name}
                      {folder === item.id ? <Check className="ml-auto size-4" /> : null}
                    </button>
                  ))}
                </div>
              ) : (
                <Input
                  aria-label="资料名称"
                  value={name}
                  maxLength={255}
                  autoFocus
                  disabled={working || unconfirmed}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
              {error ? (
                <CloudChatFeedback
                  tone="error"
                  compact
                  message={error}
                  actions={
                    unconfirmed ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditor(null);
                          refresh();
                        }}
                      >
                        刷新核对
                      </Button>
                    ) : undefined
                  }
                />
              ) : null}
            </DialogBody>
            <DialogFooter className="cloud-space-editor-actions">
              <Button
                variant="ghost"
                type="button"
                disabled={working}
                onClick={() => setEditor(null)}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={working || unconfirmed || (editorType !== "move" && !name.trim())}
              >
                {working ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {editorType === "work" ? "继续到对话" : "保存"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={capacityOpen} onOpenChange={setCapacityOpen}>
        <DialogContent showCloseButton closeLabel="关闭空间用量" className="cloud-space-editor">
          <DialogHeader>
            <DialogTitle>存储空间</DialogTitle>
            <DialogDescription>
              上传的原件、产出的每个版本以及回收站内容都会占用空间。
            </DialogDescription>
          </DialogHeader>
          {page ? (
            <>
              <DialogBody>
                <CloudSpaceCapacity usage={page.usage} />
                <dl className="cloud-space-usage-details">
                  <div>
                    <dt>
                      上传原件 · {page.usage.file_count} / {page.usage.file_limit_count} 个
                    </dt>
                    <dd>
                      {cloudSpaceSize(page.usage.file_bytes)} /{" "}
                      {cloudSpaceSize(page.usage.file_limit_bytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      工作产出 · {page.usage.artifact_version_count} /{" "}
                      {page.usage.artifact_limit_count} 个版本
                    </dt>
                    <dd>
                      {cloudSpaceSize(page.usage.artifact_bytes)} /{" "}
                      {cloudSpaceSize(page.usage.artifact_limit_bytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>回收站占用（已计入上方用量）</dt>
                    <dd>{cloudSpaceSize(page.usage.trash_bytes)}</dd>
                  </div>
                </dl>
                <p className="cloud-space-usage-note">
                  上传原件与工作产出各有独立限额；产出的每个版本分别计数。移入回收站不会释放空间。
                </p>
              </DialogBody>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => {
                    setCapacityOpen(false);
                    navigate({ ...CLOUD_SPACE_HOME, scope: "trash" });
                  }}
                >
                  查看回收站
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </FileDropBoundary>
  );
}
