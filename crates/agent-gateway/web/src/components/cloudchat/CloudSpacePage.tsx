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
import { useConfirmDialog } from "@liveagent/ui/components/ui/confirm-dialog";
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
import {
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { CloudChatArtifactsClient } from "@/lib/cloudChatArtifacts";
import {
  CLOUD_FILE_ACCEPT,
  type CloudChatFile,
  CloudChatFileError,
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
  CloudSpaceError,
  type CloudSpaceItem,
  type CloudSpaceLocation,
  CloudSpaceSaveUnconfirmedError,
  type CloudSpaceUsage,
  cloudSpaceSize,
  cloudSpaceTitle,
  type CloudSpacePage as SpacePage,
} from "@/lib/cloudSpace";
import {
  type CloudSpaceBrowseState,
  type CloudSpaceReaderOrigin,
  type CloudSpaceUploadCheck,
  cloudSpaceBrowseKey,
  readCloudSpaceBrowseState,
  readCloudSpaceUploadCheck,
  writeCloudSpaceBrowseState,
  writeCloudSpaceUploadCheck,
} from "@/lib/cloudSpaceBrowseState";
import { CloudChatFeedback } from "./CloudChatFeedback";
import { CloudSpaceCover, CloudSpaceFormatIcon, cloudSpaceFormat } from "./CloudSpaceCover";
import { WorkspaceHandoffMenuItem } from "./WorkspaceHandoffDialog";

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
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const ratio = Math.min(100, (usage.used_bytes / usage.limit_bytes) * 100);
  const Root = onClick ? "button" : "div";
  const used = cloudSpaceSize(usage.used_bytes);
  const total = cloudSpaceSize(usage.limit_bytes);
  return (
    <Root
      className="cloud-space-capacity"
      onClick={onClick}
      type={onClick ? "button" : undefined}
      aria-label={
        zh ? `存储空间：已用 ${used}，总共 ${total}` : `Storage · ${used} of ${total} used`
      }
    >
      <span>
        <HardDrive className="size-4" />
        <span>{zh ? "存储空间" : "Storage"}</span>
        <span className="ml-auto">{Math.round(ratio)}%</span>
      </span>
      <span className="cloud-space-meter">
        <span style={{ width: `${ratio}%` }} data-full={ratio >= 90 || undefined} />
      </span>
      <span className="cloud-space-capacity-label">
        {zh ? `已用 ${used} / ${total}` : `${used} / ${total} used`}
      </span>
    </Root>
  );
}
function dateLabel(value: string, locale: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(date);
}
type SpaceText = (zh: string, en: string) => string;

function statusLabel(item: CloudSpaceItem, text: SpaceText) {
  if (item.kind === "folder") return text("文件夹", "Folder");
  const versions = text(
    `${item.versions} 个版本`,
    `${item.versions} ${item.versions === 1 ? "version" : "versions"}`,
  );
  if (item.site_version_id) {
    if (item.site_version_id !== item.target_id)
      return item.state === "staging"
        ? text("站点 · 正在更新", "Site · Updating")
        : text("站点 · 更新未完成", "Site · Update incomplete");
    return `${text("站点", "Site")} · ${versions}`;
  }
  if (item.state === "ready" || item.state === "vision_ready")
    return item.kind === "artifact"
      ? `${text("产出", "Output")} · ${versions}`
      : text("上传", "Upload");
  return (
    (
      {
        uploading: text("正在上传", "Uploading"),
        uploaded: text("原件已保存", "Original saved"),
        processing: text("正在解析", "Processing"),
        staging: text("正在保存", "Saving"),
        failed: text("解析或保存失败", "Processing or saving failed"),
        unknown: text("结果待核对", "Result pending confirmation"),
        deleting: text("正在删除", "Deleting"),
      } as Record<string, string>
    )[item.state] ?? text("暂不可用", "Unavailable")
  );
}
type Editor = {
  type: "folder" | "rename" | "move" | "work";
  items: CloudSpaceItem[];
  completed?: number;
  origin?: Pick<CloudSpaceItem, "id" | "kind">;
};
type WorkKind = "document" | "spreadsheet" | "presentation" | "site";
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
  browseOwner: number | string;
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

function spaceScrollRoot(element: HTMLElement) {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (/^(auto|scroll)$/.test(style.overflowY || style.overflow)) return parent;
  }
  return null;
}

function spaceItemRow(results: HTMLElement | null, item: Pick<CloudSpaceItem, "kind" | "id">) {
  return results?.querySelector<HTMLElement>(`[data-space-item="${item.kind}:${item.id}"]`);
}

type SpacePageRead = { scopeKey: string; listRevision: string; cursor: string };
type SpaceTailFailure = SpacePageRead & { changed: boolean };

export function CloudSpacePage(props: Props) {
  const { locale } = useLocale();
  const text = useCallback<SpaceText>((zh, en) => (locale === "zh-CN" ? zh : en), [locale]);
  const { client, location } = props;
  const siteView = location.category === "sites";
  const locationKey = cloudSpaceBrowseKey(props.browseOwner, location);
  const [workKind, setWorkKind] = useState<WorkKind>("document");
  const workLabels: Record<WorkKind, string> = {
    document: text("文档", "document"),
    spreadsheet: text("表格", "spreadsheet"),
    presentation: text("演示文稿", "presentation"),
    site: text("站点", "site"),
  };
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sitesEnabled, setSitesEnabled] = useState(false);
  const [page, setPage] = useState<SpacePage | null>(null),
    [items, setItems] = useState<CloudSpaceItem[]>([]);
  const [revision, setRevision] = useState(0);
  const listRevision = `${props.revision ?? 0}:${revision}`;
  const restoreBrowse = () => ({
    key: locationKey,
    cursor: "",
    cursorRevision: listRevision,
    ...readCloudSpaceBrowseState(locationKey, siteView ? "grid" : "list"),
  });
  const [browse, setBrowse] = useState(restoreBrowse);
  // A new route must never request its results with the previous route's cursor or search.
  if (browse.key !== locationKey) setBrowse(restoreBrowse());
  const { query, sort, view, selected } = browse;
  const cursor = browse.cursorRevision === listRevision ? browse.cursor : "";
  const scopeKey = JSON.stringify([locationKey, query, sort]);
  const viewport = useRef<{
    scopeKey: string;
    listRevision: string;
    top: number;
    pending: boolean;
    readerOrigin?: CloudSpaceReaderOrigin;
    originReady: boolean;
  }>({ scopeKey: "", listRevision, top: 0, pending: true, originReady: false });
  const setQuery = (next: string) =>
    setBrowse((old) => ({
      ...old,
      query: next,
      cursor: "",
      selected: [],
      scrollTop: 0,
      readerOrigin: undefined,
    }));
  const setSort = (next: CloudSpaceBrowseState["sort"]) =>
    setBrowse((old) =>
      old.sort === next
        ? old
        : { ...old, sort: next, cursor: "", selected: [], scrollTop: 0, readerOrigin: undefined },
    );
  const setView = (next: CloudSpaceBrowseState["view"]) =>
    setBrowse((old) => ({ ...old, view: next }));
  const setSelected = (next: SetStateAction<string[]>) =>
    setBrowse((old) => ({
      ...old,
      selected: typeof next === "function" ? next(old.selected) : next,
    }));
  const setCursor = useCallback(
    (next: string) => setBrowse((old) => ({ ...old, cursor: next, cursorRevision: listRevision })),
    [listRevision],
  );
  const [busy, setBusy] = useState(true),
    [working, setWorking] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [operationError, setOperationError] = useState<{
    message: string;
    requiresRefresh: boolean;
  }>();
  const shownError = error || operationError?.message;
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [uploadCheck, setUploadCheck] = useState(() =>
    readCloudSpaceUploadCheck(props.browseOwner),
  );
  const [checkingUpload, setCheckingUpload] = useState(false);
  const [uploadCheckMessage, setUploadCheckMessage] = useState("");
  const [verifiedUpload, setVerifiedUpload] = useState<{
    file: CloudChatFile;
    folderName: string;
    remaining: number;
    placementUnconfirmed?: boolean;
  }>();
  const uploadCheckRequest = useRef<AbortController | null>(null);
  const uploadCheckFocus = useRef<HTMLButtonElement | null>(null);
  const verifiedUploadAction = useRef<HTMLButtonElement>(null);
  const { confirm: confirmStopUploadCheck, dialog: stopUploadCheckDialog } = useConfirmDialog();
  const unconfirmedRef = useRef(false),
    reconcileRequested = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: known errors belong to the current list scope.
  useEffect(() => {
    if (!unconfirmedRef.current) setOperationError(undefined);
  }, [scopeKey]);
  const [loadedScope, setLoadedScope] = useState("");
  const [loadedCursor, setLoadedCursor] = useState("");
  const [loadedRevision, setLoadedRevision] = useState("");
  const [tailFailure, setTailFailure] = useState<SpaceTailFailure>();
  const [tailReadAttempt, setTailReadAttempt] = useState(0);
  const failedPage =
    tailFailure?.scopeKey === scopeKey &&
    tailFailure.listRevision === listRevision &&
    tailFailure.cursor === cursor
      ? tailFailure
      : undefined;
  const loadSentinel = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const retryFocus = useRef<
    | (SpacePageRead & {
        button: HTMLButtonElement;
        target?: Pick<CloudSpaceItem, "id" | "kind"> | null;
      })
    | null
  >(null);
  const focusResultsLocation = useRef("");
  useLayoutEffect(() => {
    const destination = focusResultsLocation.current;
    focusResultsLocation.current = "";
    if (destination === locationKey) resultsRef.current?.focus({ preventScroll: true });
  }, [locationKey]);
  const [editor, setEditor] = useState<Editor | null>(null),
    [name, setName] = useState(""),
    [folder, setFolder] = useState("");
  const savedEditorFocus = useRef<{
    origin: NonNullable<Editor["origin"]>;
    scopeKey: string;
    priorRevision: string;
    closed: boolean;
  } | null>(null);
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
      uploadCheckRequest.current?.abort();
    };
  }, []);
  useLayoutEffect(() => {
    const previous = uploadCheckFocus.current;
    uploadCheckFocus.current = null;
    if (verifiedUpload && previous && document.activeElement === document.body)
      verifiedUploadAction.current?.focus({ preventScroll: true });
  }, [verifiedUpload]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry keeps the same query and cursor but restarts its request.
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
            setLoadedCursor(cursor);
            setLoadedRevision(listRevision);
            const focus = retryFocus.current;
            if (
              focus?.scopeKey === scopeKey &&
              focus.listRevision === listRevision &&
              focus.cursor === cursor
            )
              focus.target = data.items[0] ?? null;
            setTailFailure(undefined);
            if (reconcileRequested.current) {
              reconcileRequested.current = false;
              unconfirmedRef.current = false;
              setUnconfirmed(false);
              setOperationError(undefined);
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
              if (cursor) {
                setTailFailure({
                  scopeKey,
                  listRevision,
                  cursor,
                  changed: cause instanceof CloudSpaceError && cause.status === 409,
                });
              } else {
                setError(
                  cause instanceof TypeError
                    ? text(
                        "暂时无法读取资料，请检查连接后重试。",
                        "Couldn't load the library. Check your connection and retry.",
                      )
                    : cause instanceof Error
                      ? cause.message
                      : text("资料加载失败", "Couldn't load files"),
                );
              }
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
      query && !cursor ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    client,
    query,
    sort,
    cursor,
    listRevision,
    props.captureGuard,
    location,
    scopeKey,
    text,
    tailReadAttempt,
  ]);
  useLayoutEffect(() => {
    if (viewport.current.scopeKey !== scopeKey) {
      viewport.current = {
        scopeKey,
        listRevision,
        top: browse.scrollTop,
        pending: true,
        readerOrigin: browse.readerOrigin,
        originReady: Boolean(browse.readerOrigin),
      };
    }
    const position = viewport.current;
    if (position.listRevision !== listRevision) {
      position.listRevision = listRevision;
      position.pending = true;
    }
    const savePosition = () =>
      writeCloudSpaceBrowseState(locationKey, {
        query,
        sort,
        view,
        selected,
        scrollTop: position.top,
        readerOrigin: position.originReady ? position.readerOrigin : undefined,
      });
    if (props.active === false) {
      position.pending = true;
      position.originReady = Boolean(position.readerOrigin);
      savePosition();
      return;
    }
    savePosition();
    const sentinel = loadSentinel.current;
    if (!sentinel || replacingScope) return;
    const root = spaceScrollRoot(sentinel);
    const scroller = root ?? document.scrollingElement;
    if (position.pending) {
      const origin = position.originReady ? position.readerOrigin : undefined;
      const row = origin ? spaceItemRow(resultsRef.current, origin) : undefined;
      const maxTop = scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : 0;
      if (scroller) scroller.scrollTop = Math.min(maxTop, position.top);
      const failed = error || failedPage;
      const loaded = !busy && !failed && loadedRevision === listRevision && loadedCursor === cursor;
      if (row && origin && !busy && (loaded || failed)) {
        if (scroller) {
          const rect = row.getBoundingClientRect();
          const room = Math.max(0, scroller.clientHeight - Math.min(rect.height, 44));
          const offset = Math.max(0, Math.min(origin.offset, room));
          const top = scroller.scrollTop + rect.top - (root?.getBoundingClientRect().top ?? 0);
          position.top = Math.max(0, Math.min(maxTop, top - offset));
          scroller.scrollTop = position.top;
        }
        if (document.activeElement === document.body) {
          const menu =
            origin.opener === "menu"
              ? row.querySelector<HTMLButtonElement>(".cloud-space-row-more:not(:disabled)")
              : null;
          const opener =
            menu ??
            row.querySelector<HTMLButtonElement>(".cloud-space-item-main:not(:disabled)") ??
            resultsRef.current;
          opener?.focus({ preventScroll: true });
        }
        position.readerOrigin = undefined;
        position.originReady = false;
        savePosition();
      }
      if (!loaded) return;
      const next = page?.next_cursor;
      const existing = new Set(items.map((item) => item.id));
      const missingSelection = selected.some((id) => !existing.has(id));
      const missingOrigin = Boolean(origin && !row);
      if (
        next &&
        next !== cursor &&
        ((scroller && maxTop < position.top) || missingSelection || missingOrigin)
      ) {
        setCursor(next);
        return;
      }
      if (missingOrigin) {
        position.readerOrigin = undefined;
        position.originReady = false;
        if (document.activeElement === document.body)
          resultsRef.current?.focus({ preventScroll: true });
      }
      position.pending = false;
      position.top = Math.min(maxTop, position.top);
      if (missingSelection) {
        setBrowse((old) => ({ ...old, selected: old.selected.filter((id) => existing.has(id)) }));
      }
    }
    savePosition();
    let saveTimer: number | undefined;
    const captureScroll = () => {
      if (current.current.active === false || !scroller) return;
      position.top = scroller.scrollTop;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(savePosition, 120);
    };
    const scrollTarget = root ?? window;
    scrollTarget.addEventListener("scroll", captureScroll, { passive: true });
    window.addEventListener("pagehide", savePosition);
    return () => {
      scrollTarget.removeEventListener("scroll", captureScroll);
      window.removeEventListener("pagehide", savePosition);
      window.clearTimeout(saveTimer);
      savePosition();
    };
  }, [
    scopeKey,
    locationKey,
    query,
    sort,
    view,
    selected,
    browse.scrollTop,
    browse.readerOrigin,
    props.active,
    replacingScope,
    busy,
    error,
    failedPage,
    items,
    page?.next_cursor,
    cursor,
    loadedCursor,
    listRevision,
    loadedRevision,
    setCursor,
  ]);
  useLayoutEffect(() => {
    const focus = retryFocus.current;
    if (!focus) return;
    if (
      focus.scopeKey !== scopeKey ||
      focus.listRevision !== listRevision ||
      focus.cursor !== cursor
    ) {
      retryFocus.current = null;
      return;
    }
    if (failedPage || focus.target === undefined) return;
    retryFocus.current = null;
    if (
      props.active === false ||
      (document.activeElement !== document.body && document.activeElement !== focus.button)
    )
      return;
    const row = focus.target ? spaceItemRow(resultsRef.current, focus.target) : undefined;
    const control = row?.querySelector<HTMLElement>(".cloud-space-item-main:not(:disabled)");
    (control ?? resultsRef.current)?.focus({ preventScroll: true });
  }, [scopeKey, listRevision, cursor, failedPage, props.active]);
  const restoreSavedEditorFocus = useCallback(() => {
    const focus = savedEditorFocus.current;
    if (!focus) return;
    if (focus.scopeKey !== scopeKey || props.active === false || editor) {
      savedEditorFocus.current = null;
      return;
    }
    if (
      !focus.closed ||
      working ||
      busy ||
      replacingScope ||
      focus.priorRevision === listRevision ||
      loadedRevision !== listRevision ||
      loadedCursor !== cursor
    )
      return;
    const row = spaceItemRow(resultsRef.current, focus.origin);
    if (!row && viewport.current.pending) return;
    savedEditorFocus.current = null;
    if (document.activeElement !== document.body) return;
    const trigger = row?.querySelector<HTMLButtonElement>(".cloud-space-row-more:not(:disabled)");
    (trigger ?? resultsRef.current)?.focus({ preventScroll: true });
  }, [
    scopeKey,
    props.active,
    editor,
    working,
    busy,
    replacingScope,
    listRevision,
    loadedRevision,
    loadedCursor,
    cursor,
  ]);
  useLayoutEffect(restoreSavedEditorFocus, [restoreSavedEditorFocus]);
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
      failedPage ||
      props.active === false ||
      viewport.current.pending ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const root = spaceScrollRoot(sentinel);
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
  }, [
    page?.next_cursor,
    cursor,
    replacingScope,
    busy,
    working,
    unconfirmed,
    error,
    failedPage,
    props.active,
    setCursor,
  ]);
  function refresh() {
    if (unconfirmedRef.current || operationError?.requiresRefresh)
      reconcileRequested.current = true;
    if (!operationError?.requiresRefresh) setOperationError(undefined);
    setRevision((value) => value + 1);
    props.onChanged();
  }
  function retryTailRead(button: HTMLButtonElement) {
    if (!failedPage || busy || working || unconfirmed || operationError?.requiresRefresh) return;
    if (failedPage.changed) {
      if (document.activeElement === button) resultsRef.current?.focus({ preventScroll: true });
      refresh();
      return;
    }
    if (document.activeElement === button)
      retryFocus.current = { scopeKey, listRevision, cursor, button };
    setTailReadAttempt((value) => value + 1);
  }
  async function run(action: (guard: () => void, signal: AbortSignal) => Promise<void>) {
    if (mutationLock.current || unconfirmedRef.current || operationError?.requiresRefresh) return;
    mutationLock.current = true;
    const controller = new AbortController();
    operation.current = controller;
    const guard = props.captureGuard();
    setWorking(true);
    setError("");
    setOperationError(undefined);
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
          if (cause instanceof CloudFileUploadUnconfirmedError) return;
          if (cause instanceof CloudSpaceSaveUnconfirmedError) {
            unconfirmedRef.current = true;
            setUnconfirmed(true);
          }
          setOperationError({
            message:
              cause instanceof Error
                ? cause.message
                : text("操作失败，请刷新后重试。", "Refresh and retry the operation."),
            requiresRefresh: cause instanceof CloudSpaceError && cause.status === 409,
          });
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
    origin?: Editor["origin"],
  ) {
    return run(async (guard, signal) => {
      let completed = 0;
      try {
        for (const item of targets) {
          guard();
          const saved = await client.update(item, changes, signal);
          guard();
          completed++;
          setSelected((old) => old.filter((id) => id !== item.id));
          setEditor((current) => {
            if (current?.type !== "move" || !current.items.includes(item)) return current;
            return {
              ...current,
              completed: (current.completed ?? 0) + 1,
              items: current.items.filter((target) => target !== item),
            };
          });
          setItems((current) =>
            current.map((row) =>
              row.id === item.id && row.kind === item.kind && row.version === item.version
                ? {
                    ...row,
                    ...changes,
                    version: saved?.version ?? row.version,
                    updated_at:
                      typeof saved?.updated_at === "string" ? saved.updated_at : row.updated_at,
                  }
                : row,
            ),
          );
        }
      } catch (cause) {
        guard();
        if (completed > 0) {
          setNotice(
            text(
              `已完成 ${completed} 项，剩余 ${targets.length - completed} 项。`,
              `${completed} completed, ${targets.length - completed} remaining.`,
            ),
          );
          if (
            !(cause instanceof CloudSpaceSaveUnconfirmedError) &&
            !(cause instanceof CloudSpaceError && cause.status === 409)
          ) {
            refresh();
          }
        }
        throw cause;
      }
      if (origin)
        savedEditorFocus.current = { origin, scopeKey, priorRevision: listRevision, closed: false };
      setEditor(null);
      setNotice(
        changes.trashed === true
          ? text(
              "已移入回收站。恢复前仍占用存储空间，原对话引用保留。",
              "Moved to Trash. Storage use and conversation references are retained.",
            )
          : changes.trashed === false
            ? text("资料已恢复。", "Items restored.")
            : text("已保存。", "Saved."),
      );
    });
  }
  async function upload(files: File[], directories = 0) {
    if (props.active === false) return;
    if (uploadCheck) {
      setUploadCheckMessage(text("请先核对上次上传。", "Check the previous upload first."));
      return;
    }
    if (mutationLock.current || unconfirmedRef.current) {
      setError(
        unconfirmedRef.current
          ? text(
              "请先刷新核对上次操作结果，再上传资料。",
              "Refresh to confirm the previous operation before uploading.",
            )
          : text(
              "正在保存资料，请等待当前操作完成。",
              "Saving files. Wait for the current operation to finish.",
            ),
      );
      return;
    }
    const batch = prepareCloudFileBatch(files, 20, directories, locale);
    if (!batch.files.length) {
      if (batch.message) setError(batch.message);
      return;
    }
    setVerifiedUpload(undefined);
    await run(async (guard, signal) => {
      let count = 0;
      const folderName = location.folder
        ? (page?.folders.find((entry) => entry.id === location.folder)?.name ??
          text("原文件夹", "the original folder"))
        : "";
      for (const [index, file] of batch.files.entries()) {
        guard();
        const check: CloudSpaceUploadCheck = {
          id: crypto.randomUUID(),
          name: file.name,
          folderName,
          remaining: batch.files.length - index - 1,
        };
        writeCloudSpaceUploadCheck(props.browseOwner, check);
        let saved: CloudChatFile;
        try {
          saved = await props.files.upload(file, "", signal, check.id);
        } catch (cause) {
          guard();
          if (cause instanceof CloudFileUploadUnconfirmedError) {
            setUploadCheck(check);
            setUploadCheckMessage("");
          } else writeCloudSpaceUploadCheck(props.browseOwner, null);
          throw cause;
        }
        guard();
        count++;
        if (location.folder) {
          const placing = { ...check, placementAttempted: true };
          writeCloudSpaceUploadCheck(props.browseOwner, placing);
          try {
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
          } catch (cause) {
            guard();
            if (cause instanceof CloudSpaceSaveUnconfirmedError) {
              setUploadCheck(placing);
              setUploadCheckMessage("");
              throw new CloudFileUploadUnconfirmedError();
            }
            writeCloudSpaceUploadCheck(props.browseOwner, null);
            setVerifiedUpload({ file: saved, folderName, remaining: check.remaining });
            throw cause;
          }
          guard();
        }
        writeCloudSpaceUploadCheck(props.browseOwner, null);
      }
      guard();
      setNotice(
        `${text(`已上传 ${count} 个文件。`, `Uploaded ${count} ${count === 1 ? "file" : "files"}.`)} ${batch.message}`.trim(),
      );
    });
  }
  async function checkLibraryUpload(button: HTMLButtonElement) {
    const check = uploadCheck;
    if (!check || uploadCheckRequest.current || props.active === false) return;
    const controller = new AbortController();
    const guard = props.captureGuard();
    uploadCheckRequest.current = controller;
    setCheckingUpload(true);
    try {
      const file = await props.files.readUpload(check.id, controller.signal);
      guard();
      if (controller.signal.aborted || !mounted.current) return;
      if (file.name !== check.name || file.conversation_id) throw new Error("Upload scope changed");
      if (!file.uploaded_at || ["deleting", "deleted"].includes(file.state)) {
        setUploadCheckMessage(
          text(
            "原件还未确认保存。可以稍后重试。",
            "The original has not been confirmed saved. Try again later.",
          ),
        );
        return;
      }
      if (document.activeElement === button) uploadCheckFocus.current = button;
      writeCloudSpaceUploadCheck(props.browseOwner, null);
      setUploadCheck(null);
      setUploadCheckMessage("");
      setVerifiedUpload({
        file,
        folderName: check.folderName,
        remaining: check.remaining,
        placementUnconfirmed: check.placementAttempted,
      });
    } catch (cause) {
      if (controller.signal.aborted || !mounted.current) return;
      try {
        guard();
        setUploadCheckMessage(
          cause instanceof CloudChatFileError && cause.status === 404
            ? text(
                "还未找到本次上传的记录。可以稍后重试。",
                "This upload record is not available yet. Try again later.",
              )
            : text(
                "暂时无法核对上传。请检查连接后重试。",
                "Couldn't check the upload. Check your connection and retry.",
              ),
        );
        props.onError(cause);
      } catch {
        /* The upload belongs to a retired account. */
      }
    } finally {
      if (uploadCheckRequest.current === controller) uploadCheckRequest.current = null;
      if (mounted.current && !controller.signal.aborted) setCheckingUpload(false);
    }
  }
  async function stopCheckingUpload() {
    if (!uploadCheck || uploadCheckRequest.current) return;
    const guard = props.captureGuard();
    const confirmed = await confirmStopUploadCheck({
      title: text("结束上传核对？", "Stop checking this upload?"),
      description: text(
        "服务器可能仍在保存该文件。再次选择原件上传时，可能生成另一份文件。",
        "The server may still save this file. Uploading the original again may create a second copy.",
      ),
      confirmLabel: text("结束核对", "Stop checking"),
      cancelLabel: text("继续核对", "Keep checking"),
      preferCancel: true,
      touchActions: true,
    });
    if (!confirmed || !mounted.current || current.current.active === false) return;
    try {
      guard();
      writeCloudSpaceUploadCheck(props.browseOwner, null);
      setUploadCheck(null);
      setUploadCheckMessage("");
    } catch {
      /* The upload belongs to a retired account. */
    }
  }
  function openEditor(type: Editor["type"], targets: CloudSpaceItem[], origin?: Editor["origin"]) {
    setEditor({ type, items: targets, origin });
    setName(type === "rename" ? targets[0].name : "");
    setFolder(targets[0]?.folder_id ?? "");
  }
  function navigate(next: CloudSpaceLocation) {
    props.onNavigate(next);
  }
  function leaveFolder() {
    const next = { ...location, folder: "" };
    focusResultsLocation.current = cloudSpaceBrowseKey(props.browseOwner, next);
    navigate(next);
  }
  function applyFilters(next: CloudSpaceLocation) {
    const key = cloudSpaceBrowseKey(props.browseOwner, next);
    if (key !== locationKey) {
      const saved = readCloudSpaceBrowseState(key, view);
      writeCloudSpaceBrowseState(
        key,
        saved.query === query && saved.sort === sort
          ? { ...saved, view }
          : { query, sort, view, selected: [], scrollTop: 0 },
      );
    }
    props.onNavigate(next);
  }
  function open(
    item: CloudSpaceItem,
    action?: "share" | "settings",
    opener?: CloudSpaceReaderOrigin["opener"],
  ) {
    if (item.kind === "folder") {
      navigate({ ...CLOUD_SPACE_HOME, folder: item.id });
      return;
    }
    const row = spaceItemRow(resultsRef.current, item);
    if (row) {
      const root = spaceScrollRoot(row);
      const position = viewport.current;
      position.top = (root ?? document.scrollingElement)?.scrollTop ?? position.top;
      position.readerOrigin = {
        id: item.id,
        kind: item.kind,
        offset: row.getBoundingClientRect().top - (root?.getBoundingClientRect().top ?? 0),
        ...(opener ? { opener } : {}),
      };
      position.originReady = false;
    }
    props.onOpen(item, action);
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
    ["", text("全部类型", "All types")],
    ["document", text("文档", "Documents")],
    ["spreadsheet", text("表格", "Spreadsheets")],
    ["presentation", text("演示文稿", "Presentations")],
    ["pdf", "PDF"],
    ["image", text("图片", "Images")],
    ["media", text("音频与视频", "Audio and video")],
    ["code", text("代码与其他", "Code and other files")],
    ["archive", text("压缩包", "Archives")],
    ["folder", text("文件夹", "Folders")],
  ];
  const originOptions = [
    ["", text("全部来源", "All sources")],
    ["uploads", text("上传", "Uploads")],
    ["outputs", text("AI 产出", "AI outputs")],
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
    { id: "updated", label: text("最近修改", "Recently modified") },
    { id: "name", label: text("名称", "Name") },
    { id: "size", label: text("文件大小", "File size") },
  ] as const;
  const sortLabel = sortOptions.find((option) => option.id === sort)?.label;
  const allLoadedSelected = items.length > 0 && targets.length === items.length;
  const heading = location.folder
    ? (page?.folders.find((item) => item.id === location.folder)?.name ?? text("文件夹", "Folder"))
    : cloudSpaceTitle(location, locale);
  const searchInFolder = text("搜索当前文件夹", "Search this folder");
  const frozen =
    (busy && !cursor) ||
    replacingScope ||
    working ||
    unconfirmed ||
    operationError?.requiresRefresh;
  const itemMenu = (item: CloudSpaceItem) => (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <TooltipButton
            variant="ghost"
            size="icon-sm"
            title={text("更多操作", "More actions")}
            aria-label={text(`${item.name}的更多操作`, `More actions for ${item.name}`)}
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
          {selected.includes(item.id)
            ? text("取消选择", "Deselect")
            : text("选择资料", "Select item")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => open(item, undefined, "menu")}>
          <ArrowUpRight className="size-4" />
          {item.site_version_id
            ? text("打开站点", "Open site")
            : item.kind === "folder"
              ? text("打开文件夹", "Open folder")
              : text("打开预览", "Open preview")}
        </DropdownMenuItem>
        {props.onHandoff &&
          item.kind !== "folder" &&
          !item.trashed &&
          ["ready", "vision_ready"].includes(item.state) && (
            <WorkspaceHandoffMenuItem onClick={() => props.onHandoff?.(item)} />
          )}
        {item.site_version_id && !item.trashed ? (
          <>
            <DropdownMenuItem onClick={() => open(item, "share", "menu")}>
              <Share2 className="size-4" />
              {text("分享", "Share")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => open(item, "settings", "menu")}>
              <Settings2 className="size-4" />
              {text("站点设置", "Site settings")}
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
            {text("在对话中使用", "Use in conversation")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={() => void mutate([item], { starred: !item.starred })}>
          <Star className="size-4" />
          {item.starred
            ? text("取消收藏", "Remove from favorites")
            : text("收藏", "Add to favorites")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => openEditor("rename", [item], item)}>
          <SquarePen className="size-4" />
          {text("重命名", "Rename")}
        </DropdownMenuItem>
        {item.kind !== "folder" ? (
          <DropdownMenuItem onClick={() => openEditor("move", [item], item)}>
            <FolderClosed className="size-4" />
            {text("移动到文件夹", "Move to folder")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void mutate([item], { trashed: !item.trashed })}>
          {item.trashed ? <ArchiveRestore className="size-4" /> : <Trash2 className="size-4" />}
          {item.trashed ? text("恢复资料", "Restore item") : text("移入回收站", "Move to Trash")}
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
  const uploadBlocked = working || unconfirmed || Boolean(uploadCheck);
  const uploadNotStarted = (count: number) =>
    count > 0
      ? text(
          `另有 ${count} 个文件尚未上传。`,
          `${count} ${count === 1 ? "other file has" : "other files have"} not been uploaded.`,
        )
      : null;
  return (
    <FileDropBoundary
      className={`cloud-space-page ${siteView ? "cloud-space-sites" : ""}`}
      aria-label={text("个人资料空间", "Personal library")}
      active={props.active !== false}
      resetKey={locationKey}
      fileLabel={text(
        `松开上传到${location.folder ? `“${heading}”` : "资料空间"}`,
        `Drop to upload to ${location.folder ? `“${heading}”` : "the library"}`,
      )}
      hint={text(
        "单个文件不超过32 MiB；上传不会自动发送消息",
        "Up to 32 MiB per file. Uploading leaves the draft ready to edit.",
      )}
      disabledReason={
        uploadCheck
          ? text("请先核对上次上传。", "Check the previous upload first.")
          : unconfirmed
            ? text(
                "请先刷新核对上次操作结果，再上传资料。",
                "Refresh to confirm the previous operation before uploading.",
              )
            : working
              ? text(
                  "正在保存资料，请等待当前操作完成。",
                  "Saving files. Wait for the current operation to finish.",
                )
              : location.scope === "trash"
                ? text(
                    "请先返回资料空间或文件夹，再上传资料。",
                    "Return to the library or a folder to upload files.",
                  )
                : undefined
      }
      onFiles={(files, directories) => void upload(files, directories)}
      onRejected={uploadCheck ? setUploadCheckMessage : setError}
    >
      {stopUploadCheckDialog}
      <header className="cloud-space-heading" data-folder-context={!!location.folder || undefined}>
        <div className="cloud-space-heading-context">
          {location.folder ? (
            <TooltipButton
              className="cloud-space-folder-back"
              variant="ghost"
              size="icon-sm"
              title={text("返回全部位置", "Back to all locations")}
              aria-label={text("返回全部位置", "Back to all locations")}
              onClick={leaveFolder}
            >
              <ArrowLeft className="size-4" />
            </TooltipButton>
          ) : null}
          <h1>{heading}</h1>
        </div>
        <div className="cloud-space-heading-actions">
          <div className="cloud-space-search">
            <Search className="size-4" />
            <Input
              aria-label={
                location.folder ? searchInFolder : text("搜索全部资料", "Search all files")
              }
              placeholder={
                location.folder
                  ? searchInFolder
                  : siteView
                    ? text("搜索站点", "Search sites")
                    : text("搜索资料", "Search files")
              }
              value={query}
              maxLength={200}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query ? (
              <TooltipButton
                title={text("清除搜索", "Clear search")}
                aria-label={text("清除搜索", "Clear search")}
                variant="ghost"
                size="icon-sm"
                onClick={() => setQuery("")}
              >
                <X className="size-3.5" />
              </TooltipButton>
            ) : null}
            <TooltipButton
              className="cloud-space-mobile-filter"
              title={text("筛选资料", "Filter library")}
              aria-label={text("筛选资料", "Filter library")}
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
            disabled={uploadBlocked}
            onClick={() => uploadRef.current?.click()}
          >
            <Upload className="size-4" />
            <span>{text("上传", "Upload")}</span>
          </Button>
          {siteView && props.onCreateWork ? (
            <Button
              className="cloud-space-create"
              disabled={working || unconfirmed || !props.canReference}
              onClick={() => {
                setWorkKind("site");
                openEditor("work", []);
              }}
            >
              <Plus className="size-4" />
              {text("创建站点", "Create site")}
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button className="cloud-space-create" disabled={working || unconfirmed} />}
              >
                <Plus className="size-4" />
                {text("用 AI 创建", "Create with AI")}
                <ChevronDown className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" variant="soft" className="cloud-space-menu">
                {props.onCreateWork ? (
                  <>
                    {(Object.keys(workLabels) as WorkKind[])
                      .filter((kind) => kind !== "site" || sitesEnabled)
                      .map((kind) => (
                        <DropdownMenuItem
                          key={kind}
                          disabled={!props.canReference}
                          onClick={() => {
                            setWorkKind(kind);
                            openEditor("work", []);
                          }}
                        >
                          {kind === "site" ? (
                            <Globe className="size-4" />
                          ) : (
                            <FileText className="size-4" />
                          )}
                          {workLabels[kind]}
                          <span className="ml-auto text-xs text-muted-foreground">
                            {text("用 ZeroAgent 创作", "Create with ZeroAgent")}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuItem onClick={() => openEditor("folder", [])}>
                  <FolderClosed className="size-4" />
                  {text("新建文件夹", "New folder")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={uploadBlocked}
                  onClick={() => uploadRef.current?.click()}
                >
                  <Upload className="size-4" />
                  {text("上传文件", "Upload files")}
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
          resourceLabel={text("松开引用到当前草稿", "Drop to add to the draft")}
          hint={text(
            "添加后返回同一草稿，不会自动发送",
            "Add to the current draft and continue editing.",
          )}
          disabledReason={
            !props.canReference || frozen
              ? text(
                  "请等待当前操作完成后再引用资料。",
                  "Wait for the current operation before adding a reference.",
                )
              : undefined
          }
          onRejected={setError}
          onResources={(transfer) => {
            const identities = readCloudResourceDragPayload(transfer);
            if (!identities) {
              setError(
                text(
                  "资料身份无效，请重新选择。",
                  "This reference is invalid. Select the item again.",
                ),
              );
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
          <span>{text("放到此处，在当前对话中使用", "Drop to use in this conversation")}</span>
          <span>{text("添加到原草稿后继续编辑", "Continue editing the original draft")}</span>
        </FileDropBoundary>
      ) : null}
      <input
        ref={uploadRef}
        type="file"
        accept={CLOUD_FILE_ACCEPT}
        multiple
        className="hidden"
        aria-label={text("上传资料到个人空间", "Upload to the personal library")}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void upload(files);
        }}
      />
      <nav className="cloud-space-mobile-nav" aria-label={text("资料视图", "Library views")}>
        {(
          [
            { category: "recent", scope: "all", label: text("最近", "Recent") },
            { category: "all", scope: "all", label: text("全部资料", "All files") },
            { category: "all", scope: "starred", label: text("收藏", "Favorites") },
            { category: "sites", scope: "all", label: text("站点", "Sites") },
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
        <span className="cloud-space-mobile-list-label">{text("名称", "Name")}</span>
        <div className="cloud-space-filters">
          {!siteView &&
            filterMenu(text("类型", "Type"), location.type ?? "", typeOptions, (type) =>
              applyFilters({ ...location, type }),
            )}
          {!siteView &&
            filterMenu(text("来源", "Source"), location.origin ?? "", originOptions, (origin) =>
              applyFilters({ ...location, origin: origin as CloudSpaceLocation["origin"] }),
            )}
          {filterMenu(
            text("位置", "Location"),
            location.folder,
            [
              ["", text("全部位置", "All locations")],
              ...(page?.folders.map((item) => [item.id, item.name]) ?? []),
            ],
            (folder) => applyFilters({ ...location, folder }),
          )}
          {location.type || location.origin ? (
            <TooltipButton
              variant="ghost"
              size="icon-sm"
              title={text("清除筛选", "Clear filters")}
              aria-label={text("清除筛选", "Clear filters")}
              onClick={() => applyFilters({ ...location, type: "", origin: "" })}
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
                  aria-label={text(`资料排序：${sortLabel}`, `Sort files · ${sortLabel}`)}
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
            title={text("列表视图", "List view")}
            aria-label={text("列表视图", "List view")}
            aria-pressed={view === "list"}
            onClick={() => setView("list")}
          >
            <List className="size-4" />
          </TooltipButton>
          <TooltipButton
            variant="ghost"
            size="icon-sm"
            title={text("网格视图", "Grid view")}
            aria-label={text("网格视图", "Grid view")}
            aria-pressed={view === "grid"}
            onClick={() => setView("grid")}
          >
            <LayoutGrid className="size-4" />
          </TooltipButton>
          <TooltipButton
            variant="ghost"
            size="icon-sm"
            title={text("刷新资料", "Refresh library")}
            aria-label={text("刷新资料", "Refresh library")}
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
          message={text("回收站里的资料仍占用空间", "Files in Trash still use storage")}
          description={text(
            "恢复后可继续整理。彻底删除请打开原件预览；删除后，已有对话中的引用也会失效。",
            "Restore files to organize them again. Open a preview to delete it permanently. Existing conversation references will then be unavailable.",
          )}
        />
      ) : null}
      {shownError ? (
        <CloudChatFeedback
          tone="error"
          message={shownError}
          actions={
            <Button variant="outline" size="sm" disabled={busy || working} onClick={refresh}>
              {text("刷新核对", "Refresh to verify")}
            </Button>
          }
        />
      ) : null}
      {uploadCheck ? (
        <CloudChatFeedback
          className="cloud-space-upload-notice"
          compact
          tone={checkingUpload ? "info" : "warning"}
          busy={checkingUpload}
          message={
            uploadCheck.placementAttempted
              ? text("文件夹位置待核对", "Folder placement needs checking")
              : text("上传结果待核对", "Upload needs checking")
          }
          description={
            <>
              <p className="text-foreground" data-upload-notice-file="">
                {uploadCheck.name}
              </p>
              {uploadCheckMessage ? <p>{uploadCheckMessage}</p> : null}
              {uploadNotStarted(uploadCheck.remaining)}
            </>
          }
          actions={
            <>
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                aria-disabled={checkingUpload}
                onClick={(event) => void checkLibraryUpload(event.currentTarget)}
              >
                {checkingUpload ? text("正在核对…", "Checking…") : text("核对上传", "Check upload")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="min-h-11 md:min-h-8"
                disabled={checkingUpload}
                onClick={() => void stopCheckingUpload()}
              >
                {text("结束核对", "Stop checking")}
              </Button>
            </>
          }
        />
      ) : null}
      {verifiedUpload ? (
        <CloudChatFeedback
          className="cloud-space-upload-notice"
          compact
          tone="success"
          message={text("已确认保存", "Upload confirmed")}
          description={
            <>
              <p className="text-foreground" data-upload-notice-file="">
                {verifiedUpload.file.name}
              </p>
              {verifiedUpload.folderName ? (
                <p>
                  {verifiedUpload.placementUnconfirmed
                    ? text(
                        `原件已保存，请在资料空间核对是否已放入「${verifiedUpload.folderName}」。`,
                        `The original is saved. Check the library to see whether it is in “${verifiedUpload.folderName}”.`,
                      )
                    : text(
                        `原件已保存到资料空间，尚未放入「${verifiedUpload.folderName}」。`,
                        `The original is saved in the library. It still needs to be moved to “${verifiedUpload.folderName}”.`,
                      )}
                </p>
              ) : null}
              {uploadNotStarted(verifiedUpload.remaining)}
            </>
          }
          actions={
            <Button
              ref={verifiedUploadAction}
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-8"
              onClick={() => {
                const file = verifiedUpload.file;
                props.onOpen({
                  ...file,
                  kind: "file",
                  target_id: file.id,
                  folder_id: "",
                  starred: false,
                  trashed: false,
                  versions: 0,
                });
              }}
            >
              {text("查看已保存文件", "Open saved file")}
            </Button>
          }
          onDismiss={() => setVerifiedUpload(undefined)}
        />
      ) : null}
      {notice ? (
        <CloudChatFeedback compact message={notice} onDismiss={() => setNotice("")} />
      ) : null}
      {working ? (
        <CloudChatFeedback
          compact
          busy
          message={text("正在保存资料…", "Saving files…")}
          description={text(
            "请保留当前页面，完成后列表会自动更新。",
            "Keep this page open. The list refreshes when saving finishes.",
          )}
        />
      ) : null}
      <div
        className="cloud-space-results-caption"
        data-quiet={!query && location.scope !== "trash" ? "" : undefined}
      >
        <span className="cloud-space-results-title">
          {query
            ? text(`“${query}”的搜索结果`, `Results for “${query}”`)
            : location.scope === "trash"
              ? text("已移入回收站", "In Trash")
              : text("你的资料", "Your library")}
        </span>
        <span role="status" aria-live="polite" className="cloud-space-results-status">
          {busy
            ? cursor
              ? text("正在加载更多…", "Loading more…")
              : query
                ? text("正在搜索…", "Searching…")
                : page
                  ? text("正在更新…", "Refreshing…")
                  : text("正在加载…", "Loading…")
            : page
              ? items.length < page.total
                ? text(
                    `已显示 ${items.length} / ${page.total} 项`,
                    `Showing ${items.length} of ${page.total}`,
                  )
                : text(`${page.total} 项`, `${page.total} ${page.total === 1 ? "item" : "items"}`)
              : ""}
        </span>
      </div>
      <section
        ref={resultsRef}
        className="cloud-space-results"
        aria-label={text("资料结果", "Library results")}
        aria-busy={busy}
        data-view={view}
        tabIndex={-1}
      >
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
                ? text("没有找到匹配的资料", "No matching files")
                : location.scope === "trash"
                  ? text("回收站是空的", "Trash is empty")
                  : location.scope === "starred"
                    ? text("把常用资料放在手边", "Keep your favorites handy")
                    : location.folder
                      ? text("这个文件夹还是空的", "This folder is empty")
                      : location.category === "outputs" || location.category === "sites"
                        ? text("把创作成果保存在这里", "Keep your work here")
                        : location.category !== "all" && location.category !== "uploads"
                          ? text("这个分类还没有资料", "This category is empty")
                          : text("从一份资料开始", "Start with a file")}
            </h2>
            <p>
              {query
                ? text("试试其他名称，或清除搜索。", "Try another name or clear the search.")
                : location.scope === "starred"
                  ? text(
                      "收藏后，常用资料会出现在这里。",
                      "Items you add to favorites appear here.",
                    )
                  : location.scope === "trash"
                    ? text(
                        "移入回收站的资料可以在这里恢复。",
                        "Restore items you moved to Trash from here.",
                      )
                    : location.folder
                      ? text(
                          "上传文件到此处，或在全部资料中选择文件后移动到这个文件夹。",
                          "Upload here or move files from All files into this folder.",
                        )
                      : location.category === "outputs" || location.category === "sites"
                        ? text(
                            "在对话中提出创作目标，正式保存的成果会自动出现在资料空间。",
                            "Create something in a conversation. Saved outputs will appear in your library.",
                          )
                        : location.category !== "all" && location.category !== "uploads"
                          ? text(
                              "可以上传相关文件，或回到全部资料继续查找。",
                              "Upload a file or return to All files to continue searching.",
                            )
                          : text(
                              "上传文件，交给 ZeroAgent 理解、整理并继续创作。工作产出也会保存在这里。",
                              "Upload a file for ZeroAgent to analyze or use in your work. Saved outputs appear here too.",
                            )}
            </p>
            {query ? (
              <Button variant="outline" onClick={() => setQuery("")}>
                {text("清除搜索", "Clear search")}
              </Button>
            ) : location.scope === "all" &&
              !location.folder &&
              location.category !== "all" &&
              location.category !== "uploads" ? (
              <Button variant="outline" onClick={() => navigate(CLOUD_SPACE_HOME)}>
                {text("查看全部资料", "View all files")}
              </Button>
            ) : location.scope === "all" ? (
              <Button onClick={() => uploadRef.current?.click()} disabled={uploadBlocked}>
                <Upload className="size-4" />
                {text("上传资料", "Upload files")}
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
                  aria-label={text("全选已加载资料", "Select all loaded items")}
                  checked={allLoadedSelected}
                  ref={(input) => {
                    if (input) input.indeterminate = targets.length > 0 && !allLoadedSelected;
                  }}
                  disabled={frozen}
                  onChange={(event) =>
                    setSelected(event.target.checked ? items.map((item) => item.id) : [])
                  }
                />
                <span>{text("名称", "Name")}</span>
              </label>
              <span>{text("修改日期", "Modified")}</span>
              <span>{text("大小", "Size")}</span>
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
                    <h2>
                      {item === "folders" ? text("文件夹", "Folders") : text("文件", "Files")}
                    </h2>
                  </li>
                ) : (
                  <li
                    key={`${item.kind}:${item.id}`}
                    className="cloud-space-item"
                    data-space-item={`${item.kind}:${item.id}`}
                    data-folder={item.kind === "folder" || undefined}
                    data-selected={selected.includes(item.id) || undefined}
                  >
                    <label className="cloud-space-check">
                      <input
                        type="checkbox"
                        aria-label={text(`选择 ${item.name}`, `Select ${item.name}`)}
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
                      </div>
                      <button
                        type="button"
                        className="cloud-space-item-main"
                        aria-label={text(`打开 ${item.name}`, `Open ${item.name}`)}
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
                            setError(
                              text(
                                "一次最多拖动8份资料，请减少选择后再试。",
                                "Drag up to 8 items at a time. Deselect a few and try again.",
                              ),
                            );
                          } else setDraggingResources(true);
                        }}
                        onDragEnd={() => setDraggingResources(false)}
                        onClick={(event) => {
                          if (event.detail <= 1) open(item);
                        }}
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
                                {text("私人预览", "Private preview")} ·{" "}
                                {dateLabel(item.updated_at, locale)}
                              </>
                            ) : (
                              <>
                                {cloudSpaceFormat(item, locale)}
                                {item.kind !== "folder" ? ` · ${cloudSpaceSize(item.size)}` : ""}
                              </>
                            )}
                            {!["ready", "vision_ready", "uploaded"].includes(item.state)
                              ? ` · ${statusLabel(item, text)}`
                              : ""}
                          </span>
                          <span className="cloud-space-item-mobile-meta">
                            {item.kind === "folder"
                              ? text("文件夹", "Folder")
                              : `${page?.folders.find((folder) => folder.id === item.folder_id)?.name ?? (item.kind === "artifact" ? text("AI 产出", "AI outputs") : text("资料空间", "Library"))} · ${dateLabel(item.updated_at, locale)}`}
                          </span>
                        </span>
                        {item.starred ? <Star className="cloud-space-star size-3.5" /> : null}
                      </button>
                    </div>
                    <time
                      className="cloud-space-cell"
                      dateTime={item.updated_at}
                      title={new Date(item.updated_at).toLocaleString(locale)}
                    >
                      {dateLabel(item.updated_at, locale)}
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
        {busy && cursor && !failedPage && !replacingScope && items.length > 0 ? (
          <SpaceSkeleton append />
        ) : null}
        {failedPage ? (
          <CloudChatFeedback
            className="mt-3"
            compact
            busy={busy}
            tone={busy ? "info" : "warning"}
            role={busy ? "status" : "alert"}
            message={
              busy
                ? text("正在加载更多资料…", "Loading more files…")
                : failedPage.changed
                  ? text(
                      "资料已更新，请重新读取列表。",
                      "The library changed. Reload the list to continue.",
                    )
                  : text("暂时无法加载更多资料。", "Couldn't load more files.")
            }
            description={text(
              "已加载的资料仍可使用。",
              "You can still use the files already loaded.",
            )}
            actions={
              <Button
                variant="outline"
                size="sm"
                className="min-h-11 md:min-h-8"
                aria-disabled={Boolean(
                  busy || working || unconfirmed || operationError?.requiresRefresh,
                )}
                onClick={(event) => retryTailRead(event.currentTarget)}
              >
                {failedPage.changed
                  ? text("重新读取列表", "Reload library list")
                  : text("重试加载更多", "Retry loading more")}
              </Button>
            }
          />
        ) : null}
        <div ref={loadSentinel} className="cloud-space-load-sentinel" aria-hidden="true" />
      </section>
      {!replacingScope && targets.length ? (
        <div className="cloud-space-selection">
          <strong>{text(`${targets.length} 项已选择`, `${targets.length} selected`)}</strong>
          <Button
            variant="ghost"
            size="sm"
            aria-label={text("取消选择", "Deselect")}
            onClick={() => setSelected([])}
          >
            <X className="size-4" />
            {text("取消", "Cancel")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={
              frozen ||
              !props.canReference ||
              targets.some((item) => item.kind === "folder" || item.trashed) ||
              targets.length > 8
            }
            onClick={() =>
              void run(async (guard) => {
                await props.onReference(targets);
                guard();
              })
            }
          >
            <Plus className="size-4" />
            {text("在对话中使用", "Use in conversation")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={frozen || targets.some((item) => item.kind === "folder")}
            onClick={() => openEditor("move", targets)}
          >
            <FolderClosed className="size-4" />
            {text("移动", "Move")}
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
            {location.scope === "trash"
              ? text("恢复", "Restore")
              : text("移入回收站", "Move to Trash")}
          </Button>
        </div>
      ) : null}
      <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}>
        <DialogContent
          className="cloud-space-editor cloud-space-filter-dialog"
          showCloseButton
          closeLabel={text("关闭资料筛选", "Close filters")}
        >
          <DialogHeader>
            <DialogTitle>{text("筛选资料", "Filter library")}</DialogTitle>
            <DialogDescription>
              {text("按类型、来源和位置组合查找。", "Combine type, source and location filters.")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="cloud-space-filter-fields">
              <div>
                <span>{text("类型", "Type")}</span>
                {filterMenu(text("类型", "Type"), location.type ?? "", typeOptions, (type) =>
                  applyFilters({ ...location, type }),
                )}
              </div>
              <div>
                <span>{text("来源", "Source")}</span>
                {filterMenu(
                  text("来源", "Source"),
                  location.origin ?? "",
                  originOptions,
                  (origin) =>
                    applyFilters({ ...location, origin: origin as CloudSpaceLocation["origin"] }),
                )}
              </div>
              <div>
                <span>{text("位置", "Location")}</span>
                {filterMenu(
                  text("位置", "Location"),
                  location.folder,
                  [
                    ["", text("全部位置", "All locations")],
                    ...(page?.folders.map((item) => [item.id, item.name]) ?? []),
                  ],
                  (folder) => applyFilters({ ...location, folder }),
                )}
              </div>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => applyFilters({ ...location, type: "", origin: "", folder: "" })}
            >
              {text("重置", "Reset")}
            </Button>
            <Button onClick={() => setFiltersOpen(false)}>{text("完成", "Done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(editor)}
        onOpenChange={(open) => {
          if (!working && !open) setEditor(null);
        }}
        onOpenChangeComplete={(open) => {
          if (open || !savedEditorFocus.current) return;
          savedEditorFocus.current.closed = true;
          restoreSavedEditorFocus();
        }}
      >
        <DialogContent
          showCloseButton
          closeLabel={text("关闭资料编辑", "Close file editor")}
          closeDisabled={working}
          className="cloud-space-editor"
        >
          <DialogHeader>
            <DialogTitle>
              {editorType === "work"
                ? text(`创建${workLabels[workKind]}`, `Create a ${workLabels[workKind]}`)
                : editorType === "folder"
                  ? text("新建文件夹", "New folder")
                  : editorType === "rename"
                    ? text("重命名", "Rename")
                    : text("移动资料", "Move items")}
            </DialogTitle>
            <DialogDescription>
              {editorType === "work"
                ? text(
                    "描述你的目标，下一步在对话中继续。发送前可以编辑，成果保存后会出现在资料空间。",
                    "Describe what you want to make. Edit the draft in conversation before sending. Saved outputs appear in your library.",
                  )
                : editorType === "move"
                  ? text(
                      "选择资料的存放位置。原对话引用不会改变。",
                      "Choose where to keep the items. Existing conversation references stay linked.",
                    )
                  : text(
                      "名称只影响资料空间的整理，原件和历史引用会保留。",
                      "The name organizes your library. Originals and existing references stay linked.",
                    )}
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!editor || unconfirmedRef.current || operationError?.requiresRefresh) return;
              if (editor.type === "work") {
                props.onCreateWork?.(
                  workKind === "site"
                    ? text(
                        "请根据以下目标创建一个可交互的静态站点，构建并检查后保存到我的资料空间，供我预览。保持私有，未经我确认不要创建分享链接：\n\n",
                        "Build and verify an interactive static site using the brief below. Save it to my Library for private preview. Ask before creating a share link.\n\n",
                      ) + name.trim()
                    : text(
                        `请根据以下目标创建一份${workLabels[workKind]}，提供可下载的文件，并保存到我的资料空间：\n\n${name.trim()}`,
                        `Create a downloadable ${workLabels[workKind]} using the brief below and save it to my Library.\n\n${name.trim()}`,
                      ),
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
                  editor.origin,
                );
            }}
          >
            <DialogBody>
              {editorType === "work" ? (
                <Textarea
                  aria-label={text("创作目标", "Creative brief")}
                  placeholder={text(
                    "你想创作什么？可以说明主题、读者和内容要求。",
                    "What would you like to make? Include the topic, audience and requirements.",
                  )}
                  value={name}
                  maxLength={2048}
                  rows={5}
                  onChange={(event) => setName(event.target.value)}
                />
              ) : editorType === "move" ? (
                <div className="cloud-space-folder-options">
                  {[{ id: "", name: text("全部资料", "All files") }, ...(page?.folders ?? [])].map(
                    (item) => (
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
                    ),
                  )}
                </div>
              ) : (
                <Input
                  aria-label={text("资料名称", "Name")}
                  value={name}
                  maxLength={255}
                  autoFocus
                  disabled={working || unconfirmed}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
              {editor?.type === "move" && editor.completed ? (
                <CloudChatFeedback
                  compact
                  message={text(
                    `已完成 ${editor.completed} 项，剩余 ${editor.items.length} 项。`,
                    `${editor.completed} completed, ${editor.items.length} remaining.`,
                  )}
                />
              ) : null}
              {shownError ? (
                <CloudChatFeedback
                  tone="error"
                  compact
                  message={shownError}
                  actions={
                    unconfirmed || operationError?.requiresRefresh ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setEditor(null);
                          refresh();
                        }}
                      >
                        {text("刷新核对", "Refresh to verify")}
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
                {text("取消", "Cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  working ||
                  unconfirmed ||
                  operationError?.requiresRefresh ||
                  (editorType !== "move" && !name.trim())
                }
              >
                {working ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {editorType === "work"
                  ? text("继续到对话", "Continue in conversation")
                  : text("保存", "Save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={capacityOpen} onOpenChange={setCapacityOpen}>
        <DialogContent
          showCloseButton
          closeLabel={text("关闭空间用量", "Close storage details")}
          className="cloud-space-editor"
        >
          <DialogHeader>
            <DialogTitle>{text("存储空间", "Storage")}</DialogTitle>
            <DialogDescription>
              {text(
                "上传的原件、产出的每个版本以及回收站内容都会占用空间。",
                "Original uploads, each output version and items in Trash all use storage.",
              )}
            </DialogDescription>
          </DialogHeader>
          {page ? (
            <>
              <DialogBody>
                <CloudSpaceCapacity usage={page.usage} />
                <dl className="cloud-space-usage-details">
                  <div>
                    <dt>
                      {text("上传原件", "Original uploads")} · {page.usage.file_count} /{" "}
                      {page.usage.file_limit_count}
                    </dt>
                    <dd>
                      {cloudSpaceSize(page.usage.file_bytes)} /{" "}
                      {cloudSpaceSize(page.usage.file_limit_bytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>
                      {text("工作产出", "Outputs")} · {page.usage.artifact_version_count} /{" "}
                      {page.usage.artifact_limit_count} {text("个版本", "versions")}
                    </dt>
                    <dd>
                      {cloudSpaceSize(page.usage.artifact_bytes)} /{" "}
                      {cloudSpaceSize(page.usage.artifact_limit_bytes)}
                    </dd>
                  </div>
                  <div>
                    <dt>{text("回收站占用（已计入上方用量）", "Trash (included above)")}</dt>
                    <dd>{cloudSpaceSize(page.usage.trash_bytes)}</dd>
                  </div>
                </dl>
                <p className="cloud-space-usage-note">
                  {text(
                    "上传原件与工作产出各有独立限额；产出的每个版本分别计数。移入回收站不会释放空间。",
                    "Uploads and outputs have separate limits. Each output version counts individually. Files in Trash continue to use storage.",
                  )}
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
                  {text("查看回收站", "View Trash")}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </FileDropBoundary>
  );
}
