import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Download,
  ExternalLink,
  Globe,
  Info,
  MoreHorizontal,
  Plus,
  Search,
  SquareMousePointer,
  Trash2,
  X,
} from "@liveagent/ui/components/IconSet";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "@liveagent/ui/components/ui/popover";
import { useLocale } from "@liveagent/ui/i18n/index";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { Channel } from "@tauri-apps/api/core";
import {
  type CSSProperties,
  type FormEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import Camera from "~icons/lucide/camera";
import Minus from "~icons/lucide/minus";
import Pencil from "~icons/lucide/pencil";
import Printer from "~icons/lucide/printer";
import RotateCw from "~icons/lucide/rotate-cw";
import SlidersHorizontal from "~icons/lucide/sliders-horizontal";
import Square from "~icons/lucide/square";
import { isTauriHost } from "../../lib/host";
import { invoke } from "../../shims/tauriCore";
import { openUrl } from "../../shims/tauriOpener";
import { BrowserDeviceResizeHandles, BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import { BrowserExtensionMenu } from "./BrowserExtensionMenu";
import { BrowserNewTab, type BrowserNewTabTools, type BrowserVisit } from "./BrowserNewTab";
import {
  BrowserSiteControls,
  encodeSiteControlChanges,
  parseSiteControls,
  type SiteControlValue,
  type SiteControlValues,
} from "./BrowserSiteControls";
import {
  BrowserSshLoopbackMenu,
  type BrowserSshTarget,
  browserLoopbackAddress,
  displaySshLoopbackAddress,
} from "./BrowserSshLoopbackMenu";
import { formatBrowserAddress, resolveBrowserAddress, safeBrowserUrl } from "@liveagent/ui/components/project-tools/workspaceBrowserAddress";
import {
  clampDeviceDimension,
  DEFAULT_DEVICE_VIEWPORT,
  fitDeviceViewport,
} from "./browserDeviceViewport";
import type { BrowserHistorySnapshot } from "@liveagent/ui/components/project-tools/workspaceBrowserHistory";
import "./workbench-browser.css";
import "./browser-chrome.css";
import "./browser-annotation.css";

export type WorkbenchBrowserAnnotation = {
  image: Blob;
  x: number;
  y: number;
  text: string;
  url: string;
  target?: string;
  width?: number;
  height?: number;
  siteLabel?: string;
  siteMetadata?: string;
  selectedText?: string;
  siteControlChanges?: string;
};

type AnnotationMarker = Pick<
  WorkbenchBrowserAnnotation,
  "x" | "y" | "target" | "width" | "height" | "siteLabel" | "siteMetadata" | "selectedText"
> & { siteControls?: string; localStylePreview?: boolean };
type CaptureMarker = AnnotationMarker & {
  siteSuggestedComment?: string;
  sitePreviewToken?: string;
  siteCustomRender?: boolean;
};
type WireAnnotation = Omit<WorkbenchBrowserAnnotation, "image"> & { png: string };
type QueuedAnnotation = WorkbenchBrowserAnnotation & {
  id: string;
  siteControls?: string;
  localStylePreview?: boolean;
  controlValues: SiteControlValues;
};
const MAX_ANNOTATIONS = 8;

type BrowserPaneProps = {
  id: string;
  detachedLease?: string;
  history?: BrowserHistorySnapshot;
  url: string;
  active: boolean;
  scope?: string;
  reloadToken?: number;
  projectPathKey?: string;
  sshTargets?: readonly BrowserSshTarget[];
  newTabTools?: BrowserNewTabTools;
  visits?: readonly BrowserVisit[];
  openPrivateBrowserPort?: (id: string, url: string) => Promise<void>;
  onNavigate(url: string, title?: string, faviconDataUrl?: string): void;
  onHistory?(history: BrowserHistorySnapshot): void;
  onOpenTab(url: string, foreground: boolean): void;
  onAnnotate?(annotations: readonly WorkbenchBrowserAnnotation[]): void | Promise<void>;
  onDetachedAnnotate?(annotations: readonly WorkbenchBrowserAnnotation[]): void | Promise<void>;
};

type BrowserState = {
  url: string;
  title: string;
  faviconDataUrl?: string | null;
  loading: boolean;
  loadFailed: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  hasDownloads: boolean;
  findIndex: number;
  findCount: number;
  sshLoopback?: boolean;
  gatewayDisplay?: string | null;
  ephemeralAddress?: boolean;
};

type BrowserEvent =
  | { kind: "state"; state: BrowserState }
  | { kind: "windowState"; detached: boolean }
  | { kind: "windowUnavailable" }
  | { kind: "siteAnnotations"; origin: string; enabled: boolean }
  | { kind: "siteAnnotationPreview"; token: string; revision: number; png: string | null }
  | { kind: "siteAnnotationPreviewClosed"; token: string }
  | { kind: "submitAnnotations"; requestId: string; annotations: WireAnnotation[] }
  | { kind: "history"; history: BrowserHistorySnapshot; durableTraversal: boolean }
  | { kind: "openTab"; url: string; foreground: boolean; detached?: boolean }
  | { kind: "screenshot"; png: string }
  | { kind: "copied" }
  | { kind: "viewportUnavailable" }
  | ({ kind: "annotationTarget" } & CaptureMarker)
  | ({ kind: "annotationRegion" } & CaptureMarker &
      Required<Pick<AnnotationMarker, "x" | "y" | "width" | "height">>)
  | { kind: "annotationStopped" }
  | { kind: "annotationUnavailable" }
  | { kind: "captureFailed" };

type Bounds = { x: number; y: number; width: number; height: number };
type BrowserAction =
  | { action: "navigate"; url: string }
  | {
      action: "layout";
      bounds: Bounds | null;
      version: number;
      viewport: { width: number; height: number; scale: number } | null;
      sitePreviewToken: string | null;
    }
  | { action: "zoom"; factor: number }
  | { action: "theme"; scheme: "light" | "dark" }
  | { action: "find"; text: string }
  | { action: "findNext"; backwards: boolean }
  | { action: "screenshot"; toClipboard: boolean }
  | { action: "selectRegion"; enabled: boolean }
  | { action: "siteAnnotations"; origin: string; enabled?: boolean }
  | {
      action: "previewSiteAnnotation";
      token: string;
      revision: number;
      values: { callback: string; value: SiteControlValue }[];
      original: boolean;
    }
  | { action: "closeSiteAnnotation"; token: string }
  | { action: "settleDetachedAnnotations"; requestId: string; error?: string }
  | { action: "detach"; locale: "en" | "zh"; scheme: "light" | "dark" }
  | {
      action:
        | "back"
        | "forward"
        | "stop"
        | "reload"
        | "stopFind"
        | "print"
        | "downloads"
        | "close"
        | "openExternal"
        | "returnToWorkspace";
    };

const initialState: BrowserState = {
  url: "",
  title: "",
  loading: false,
  loadFailed: false,
  canGoBack: false,
  canGoForward: false,
  hasDownloads: false,
  findIndex: -1,
  findCount: 0,
};

const labels = {
  en: {
    openedInWindow: "This tab is open in a window",
    focusWindow: "Show window",
    detachWindow: "Open in a separate window",
    returnToWorkspace: "Return to workspace",
    windowUnavailable: "The separate browser window could not start.",
    originalConversationUnavailable: "The original conversation is unavailable.",
    browser: "Browser",
    navigation: "Browser navigation",
    ask: "Ask ZeroAgent",
    back: "Back",
    forward: "Forward",
    reload: "Reload",
    stop: "Stop loading",
    address: "Search or enter a URL",
    external: "Open in default browser",
    secure: "HTTPS address",
    insecure: "HTTP address",
    siteInfo: "View site information",
    sitePermissions: "Site permissions are blocked in the workspace browser.",
    siteAnnotations: "Allow custom annotation features",
    siteAnnotationDescription:
      "Let this site provide annotation targets and temporarily preview control changes.",
    siteAnnotationUnavailable: "Custom annotations require HTTPS or a loopback site.",
    siteContext: "Context from this website",
    siteControls: "Proposed website control values",
    siteControlNote: "Change the selected website controls.",
    styleNote: "Apply the proposed styles to the selected element.",
    annotationComment: "Comment",
    annotationStyle: "Style",
    showSiteOriginal: "Show original",
    sitePreviewLoading: "Updating preview…",
    sitePreviewUnavailable: "Live website preview is unavailable.",
    menu: "Browser options",
    find: "Find in page",
    previous: "Previous match",
    next: "Next match",
    zoomOut: "Zoom out",
    zoomIn: "Zoom in",
    deviceToolbar: "Device toolbar",
    showDeviceToolbar: "Show device toolbar",
    hideDeviceToolbar: "Hide device toolbar",
    deviceToolbarDefault: "Always show in new tabs",
    viewportUnavailable: "Device emulation is unavailable for this page.",
    resetZoom: "Reset zoom",
    print: "Print",
    downloads: "Downloads",
    screenshot: "Screenshot to clipboard",
    copied: "Screenshot copied",
    captureFailed: "Could not capture the page.",
    annotate: "Annotate page",
    selectElement: "Click or drag to annotate. Hold Space to browse.",
    annotating: "Annotating",
    continueAnnotating: "Select another area",
    clearAnnotations: "Clear annotations",
    captureSelection: "Capturing selection…",
    annotatePoint: "Mark a point instead",
    annotationUnavailable:
      "Element selection is unavailable. You can mark a point on a screenshot.",
    point: "Click the page to mark a place",
    comment: "What should ZeroAgent look at?",
    attach: "Add to chat",
    attaching: "Adding…",
    saveAnnotation: "Save annotation",
    annotations: "Annotations",
    editAnnotation: "Edit annotation",
    deleteAnnotation: "Remove annotation",
    close: "Close",
    blank: "Start browsing",
    hint: "Enter a URL to open a page",
    invalid: "Enter an HTTP or HTTPS address, or a search term.",
    failed: "This page could not be loaded.",
    slow: "This page is taking longer than expected.",
    unavailable: "The embedded browser could not start.",
    unsupported: "The embedded browser is available in the ZeroAgent Windows app.",
    retry: "Try again",
    actionFailed: "The browser could not complete that action.",
    loading: "Loading page",
  },
  zh: {
    openedInWindow: "此网页已在独立窗口打开",
    focusWindow: "显示窗口",
    detachWindow: "在独立窗口打开",
    returnToWorkspace: "返回工作区",
    windowUnavailable: "无法打开独立浏览器窗口。",
    originalConversationUnavailable: "原会话已不可用。",
    browser: "浏览器",
    navigation: "浏览器导航",
    ask: "询问 ZeroAgent",
    back: "后退",
    forward: "前进",
    reload: "重新加载",
    stop: "停止加载",
    address: "搜索或输入网址",
    external: "在默认浏览器中打开",
    secure: "HTTPS 地址",
    insecure: "HTTP 地址",
    siteInfo: "查看站点信息",
    sitePermissions: "工作区浏览器阻止网页请求访问设备权限。",
    siteAnnotations: "允许网站自定义标注",
    siteAnnotationDescription: "标注时允许此网站提供选区并临时预览控件改动。",
    siteAnnotationUnavailable: "网站自定义标注要求 HTTPS 或回环地址。",
    siteContext: "来自此网站的上下文",
    siteControls: "建议修改的网站控件",
    siteControlNote: "修改选中的网站控件。",
    styleNote: "将建议样式应用到选中的元素。",
    annotationComment: "评论",
    annotationStyle: "样式",
    showSiteOriginal: "查看原始效果",
    sitePreviewLoading: "正在更新预览…",
    sitePreviewUnavailable: "此网站的实时预览暂不可用。",
    menu: "浏览器选项",
    find: "在页面中查找",
    previous: "上一个结果",
    next: "下一个结果",
    zoomOut: "缩小",
    zoomIn: "放大",
    deviceToolbar: "设备工具栏",
    showDeviceToolbar: "显示设备工具栏",
    hideDeviceToolbar: "隐藏设备工具栏",
    deviceToolbarDefault: "新标签页中始终显示",
    viewportUnavailable: "此页面无法使用设备模拟。",
    resetZoom: "重置缩放",
    print: "打印",
    downloads: "下载",
    screenshot: "截图到剪贴板",
    copied: "已复制截图",
    captureFailed: "无法截取当前页面。",
    annotate: "标注网页",
    selectElement: "点击或拖动标注，按住空格可浏览网页。",
    annotating: "正在批注",
    continueAnnotating: "继续选择区域",
    clearAnnotations: "清除批注",
    captureSelection: "正在截取选区…",
    annotatePoint: "在截图上标记位置",
    annotationUnavailable: "无法选择网页元素。你可以在截图上标记位置。",
    point: "点击网页标记位置",
    comment: "希望 ZeroAgent 查看什么？",
    attach: "添加到对话",
    attaching: "正在添加…",
    saveAnnotation: "保存批注",
    annotations: "批注",
    editAnnotation: "编辑批注",
    deleteAnnotation: "移除批注",
    close: "关闭",
    blank: "开始浏览",
    hint: "输入网址以打开网页",
    invalid: "请输入 HTTP 或 HTTPS 网址，或输入搜索词。",
    failed: "无法加载此页面。",
    slow: "此页面加载时间较长。",
    unavailable: "内置浏览器无法启动。",
    unsupported: "内置浏览器可在 ZeroAgent Windows 桌面版中使用。",
    retry: "重试",
    actionFailed: "浏览器无法完成此操作。",
    loading: "正在加载页面",
  },
};

export function canOpenWorkbenchBrowser(): boolean {
  return isTauriHost() && /Windows/i.test(window.navigator.userAgent);
}

function browserCommand(id: string, request: BrowserAction) {
  return invoke<void>("workbench_browser", { id, request });
}

async function connectDetachedBrowser(
  id: string,
  events: Channel<BrowserEvent>,
  cancelled: () => boolean,
) {
  for (let attempt = 0; !cancelled(); attempt++) {
    try {
      return await invoke<void>("workbench_browser_connect", { id, events });
    } catch (error) {
      if (String(error) !== "The browser window is still opening" || attempt >= 10) throw error;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
  }
}

function contentBounds(node: HTMLElement): Bounds | null {
  if (document.visibilityState === "hidden" || !node.isConnected) return null;
  const box = node.getBoundingClientRect();
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const right = Math.min(window.innerWidth, box.right);
  const bottom = Math.min(window.innerHeight, box.bottom);
  if (right <= left || bottom <= top) return null;

  // A native child sits above the host DOM. Yield its rectangle whenever app
  // menus or dialogs cover it, without unmounting or navigating the page.
  const backdropSelector = '[data-slot="dialog-overlay"], [data-slot="sheet-backdrop"]';
  const ownPortal = node.closest('[data-slot="dialog-portal"], [data-slot="sheet-portal"]');
  const scale = window.devicePixelRatio;
  for (const overlay of document.querySelectorAll<HTMLElement>(nativeCoverSelector)) {
    if (
      overlay.contains(node) ||
      (overlay.matches(backdropSelector) && ownPortal?.contains(overlay)) ||
      overlay.closest("[hidden]")
    )
      continue;
    const rect = overlay.getBoundingClientRect();
    if (
      Math.round(Math.min(right, rect.right) * scale) >
        Math.round(Math.max(left, rect.left) * scale) &&
      Math.round(Math.min(bottom, rect.bottom) * scale) >
        Math.round(Math.max(top, rect.top) * scale) &&
      getComputedStyle(overlay).visibility !== "hidden"
    )
      return null;
  }
  const x = Math.round(left * scale);
  const y = Math.round(top * scale);
  return { x, y, width: Math.round(right * scale) - x, height: Math.round(bottom * scale) - y };
}

const nativeCoverSelector =
  '[role="menu"], [role="listbox"], [role="dialog"], [data-slot="dialog-overlay"], [data-slot="sheet-backdrop"]';

function decodeScreenshot(png: string): Blob {
  const binary = atob(png);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: "image/png" });
}

export async function submitDetachedBrowserAnnotations(
  lease: string,
  annotations: readonly WorkbenchBrowserAnnotation[],
) {
  const batch = await Promise.all(
    annotations.map(async ({ image, ...annotation }) => {
      const bytes = new Uint8Array(await image.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return { ...annotation, png: btoa(binary) };
    }),
  );
  await invoke<void>("workbench_browser_submit_annotations", { id: lease, annotations: batch });
}

function deviceToolbarPreference(scope: string | undefined, value?: boolean) {
  if (!scope) return false;
  try {
    const key = `zeroagent.workbench-browser.device-toolbar:${scope}`;
    if (value === undefined) return window.localStorage.getItem(key) === "true";
    window.localStorage.setItem(key, String(value));
  } catch {
    // The active tab still retains its layout when storage is disabled.
  }
  return value ?? false;
}

export function WorkbenchBrowserPane(props: BrowserPaneProps) {
  const { active, id, detachedLease, scope, url, reloadToken, onAnnotate } = props;
  const { locale } = useLocale();
  const l = labels[locale.startsWith("zh") ? "zh" : "en"];
  const supported = canOpenWorkbenchBrowser();
  const latest = useRef(props);
  latest.current = props;
  const sshTarget = useRef<{ sessionId: string; url: string } | null>(null);
  const detachedAnnotationTarget = useRef<BrowserPaneProps["onDetachedAnnotate"]>(undefined);
  const [keepAlive, setKeepAlive] = useState(active);
  const [attempt, setAttempt] = useState(0);
  const [nativeId, setNativeId] = useState<string | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const [workspaceDetached, setWorkspaceDetached] = useState(false);
  const [historyState, setHistoryState] = useState<{
    history: BrowserHistorySnapshot;
    durableTraversal: boolean;
  } | null>(null);
  const [state, setState] = useState(initialState);
  const [draft, setDraft] = useState(url);
  const [addressFocused, setAddressFocused] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [siteOpen, setSiteOpen] = useState(false);
  const [siteAnnotation, setSiteAnnotation] = useState<{ origin: string; enabled: boolean } | null>(
    null,
  );
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState("");
  const [zoom, setZoom] = useState(1);
  const [deviceEnabled, setDeviceEnabled] = useState(() => deviceToolbarPreference(scope));
  const [deviceDefault, setDeviceDefault] = useState(() => deviceToolbarPreference(scope));
  const [deviceViewport, setDeviceViewport] = useState(DEFAULT_DEVICE_VIEWPORT);
  const [deviceStage, setDeviceStage] = useState({ width: 0, height: 0 });
  const [slow, setSlow] = useState(false);
  const [feedback, setFeedback] = useState<keyof typeof l | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [annotation, setAnnotation] = useState<{
    id?: string;
    image: Blob;
    attachmentImage?: Blob;
    preview: string;
    url: string;
    liveToken?: string;
    customRender?: boolean;
  } | null>(null);
  const [marker, setMarker] = useState<AnnotationMarker | null>(null);
  const [siteControlValues, setSiteControlValues] = useState<SiteControlValues>({});
  const [showSiteOriginal, setShowSiteOriginal] = useState(false);
  const [sitePreviewStatus, setSitePreviewStatus] = useState<"idle" | "loading" | "failed">("idle");
  const liveToken = annotation?.liveToken;
  const sitePreviewSequence = useRef(0);
  const lastSitePreview = useRef<string | undefined>(undefined);
  const sitePreviewRequest = useRef<{ token: string; revision: number; original: boolean } | null>(
    null,
  );
  const sitePreviewDeadline = useRef<number | undefined>(undefined);
  const siteControls = parseSiteControls(marker?.siteControls);
  const siteControlChanges = encodeSiteControlChanges(siteControls, siteControlValues);
  const [comment, setComment] = useState("");
  const [editorMode, setEditorMode] = useState<"comment" | "style">("comment");
  const [annotations, setAnnotations] = useState<QueuedAnnotation[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [annotationError, setAnnotationError] = useState("");
  const [addingAnnotation, setAddingAnnotation] = useState(false);
  const addingAnnotationRef = useRef(false);
  const page = useRef<HTMLDivElement>(null);
  const deviceFrame = useRef<HTMLDivElement>(null);
  const deviceViewportInitialized = useRef(false);
  const browserBar = useRef<HTMLDivElement>(null);
  const browserLeading = useRef<HTMLDivElement>(null);
  const browserTrailing = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const annotationInput = useRef<HTMLTextAreaElement>(null);
  const layoutVersion = useRef(0);
  const lastReportedPage = useRef("");
  const lastLayout = useRef("");
  const previousReloadToken = useRef(reloadToken);
  const captureTimeout = useRef<number | undefined>(undefined);
  const capturePage = useRef<{ url: string; toClipboard: boolean; marker?: CaptureMarker } | null>(
    null,
  );
  const currentPage = useRef("");
  const captureViewport = useRef<(toClipboard: boolean, marker?: CaptureMarker) => void>(() => {});
  captureViewport.current = capture;
  const shownUrl =
    state.gatewayDisplay ??
    (state.ephemeralAddress
      ? sshTarget.current
        ? displaySshLoopbackAddress(state.url, sshTarget.current.url)
        : (safeBrowserUrl(state.url) ?? "")
      : safeBrowserUrl(state.url) || (!state.sshLoopback && safeBrowserUrl(url)) || "");
  const deviceMode =
    deviceEnabled && Boolean(shownUrl) && !startFailed && !state.loadFailed && !workspaceDetached;
  const showDevice = deviceMode && !annotation;
  const fitted = deviceMode ? fitDeviceViewport(deviceStage, deviceViewport) : null;
  const fittedScale = fitted?.scale ?? 0;
  const hasPage = Boolean(shownUrl);
  const { width: viewportWidth, height: viewportHeight } = deviceViewport;

  useEffect(() => {
    if (active) setKeepAlive(true);
  }, [active]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Changes to identity or retry create a fresh native lease.
  useEffect(() => {
    if (!supported || !keepAlive) return;
    const lease = detachedLease ?? createUuid();
    const events = new Channel<BrowserEvent>();
    let cancelled = false;
    setNativeId(null);
    setStartFailed(false);
    setState(initialState);
    if (!detachedLease) sshTarget.current = null;
    setFeedback(null);
    setInspecting(false);
    lastLayout.current = "";
    lastReportedPage.current = "";
    currentPage.current = "";
    const timeout = window.setTimeout(() => setStartFailed(true), 20_000);
    events.onmessage = (event) => {
      if (cancelled) return;
      if (event.kind === "state") {
        if (
          event.state.loading ||
          (currentPage.current && currentPage.current !== event.state.url)
        ) {
          setAnnotation((current) =>
            current?.liveToken ? { ...current, liveToken: undefined } : current,
          );
        }
        setState(event.state);
        currentPage.current = event.state.url;
        if (event.state.loading) capturePage.current = null;
        const favicon = event.state.faviconDataUrl ?? undefined;
        const fingerprint = `${event.state.url}\n${event.state.title}\n${favicon ?? ""}`;
        if (
          event.state.url &&
          !event.state.ephemeralAddress &&
          fingerprint !== lastReportedPage.current
        ) {
          lastReportedPage.current = fingerprint;
          const title = event.state.title || undefined;
          if (favicon) latest.current.onNavigate(event.state.url, title, favicon);
          else latest.current.onNavigate(event.state.url, title);
        }
      } else if (event.kind === "windowState") {
        lastLayout.current = "";
        setWorkspaceDetached(event.detached);
        if (!event.detached) detachedAnnotationTarget.current = undefined;
      } else if (event.kind === "windowUnavailable") {
        detachedAnnotationTarget.current = undefined;
        setFeedback("windowUnavailable");
      } else if (event.kind === "submitAnnotations") {
        const commit = async () => {
          try {
            const attach = detachedAnnotationTarget.current;
            if (!attach) throw new Error(l.originalConversationUnavailable);
            await attach(
              event.annotations.map(({ png, ...item }) => ({
                ...item,
                image: decodeScreenshot(png),
              })),
            );
            await browserCommand(lease, {
              action: "settleDetachedAnnotations",
              requestId: event.requestId,
            });
          } catch (error) {
            await browserCommand(lease, {
              action: "settleDetachedAnnotations",
              requestId: event.requestId,
              error: error instanceof Error ? error.message : l.originalConversationUnavailable,
            }).catch(() => undefined);
          }
        };
        void commit();
      } else if (event.kind === "history") {
        setHistoryState(event);
        latest.current.onHistory?.(event.history);
      } else if (event.kind === "siteAnnotations") {
        setSiteAnnotation(event);
      } else if (event.kind === "siteAnnotationPreviewClosed") {
        setAnnotation((current) =>
          current?.liveToken === event.token ? { ...current, liveToken: undefined } : current,
        );
      } else if (event.kind === "siteAnnotationPreview") {
        const requested = sitePreviewRequest.current;
        if (requested?.token !== event.token || requested.revision !== event.revision) return;
        window.clearTimeout(sitePreviewDeadline.current);
        if (!event.png) {
          setSitePreviewStatus("failed");
          return;
        }
        try {
          const image = decodeScreenshot(event.png);
          const preview = URL.createObjectURL(image);
          setAnnotation((current) => {
            if (current?.liveToken !== event.token) {
              URL.revokeObjectURL(preview);
              return current;
            }
            return {
              ...current,
              image,
              attachmentImage: requested.original ? current.attachmentImage : image,
              preview,
            };
          });
          setSitePreviewStatus("idle");
        } catch {
          setSitePreviewStatus("failed");
        }
      } else if (event.kind === "openTab") {
        if (latest.current.active || event.detached) {
          latest.current.onOpenTab(event.url, event.foreground && latest.current.active);
        }
      } else if (event.kind === "viewportUnavailable") {
        setDeviceEnabled(false);
        setFeedback("viewportUnavailable");
      } else if (event.kind === "annotationTarget" || event.kind === "annotationRegion") {
        setInspecting(false);
        if (latest.current.active && latest.current.onAnnotate) {
          const { kind: _kind, ...marker } = event;
          captureViewport.current(false, marker);
        } else if (event.sitePreviewToken) {
          void browserCommand(lease, {
            action: "closeSiteAnnotation",
            token: event.sitePreviewToken,
          }).catch(() => undefined);
        }
      } else if (event.kind === "annotationStopped" || event.kind === "annotationUnavailable") {
        setInspecting(false);
        if (event.kind === "annotationUnavailable") setFeedback("annotationUnavailable");
      } else {
        const capturedPage = capturePage.current;
        capturePage.current = null;
        window.clearTimeout(captureTimeout.current);
        setCapturing(false);
        const releaseCapturedSite = () => {
          const token = capturedPage?.marker?.sitePreviewToken;
          if (token)
            void browserCommand(lease, { action: "closeSiteAnnotation", token }).catch(
              () => undefined,
            );
        };
        if (event.kind === "screenshot") {
          if (!latest.current.active || !capturedPage || capturedPage.url !== currentPage.current) {
            releaseCapturedSite();
            setFeedback("captureFailed");
            return;
          }
          try {
            const image = decodeScreenshot(event.png);
            const chosen = capturedPage.marker;
            setAnnotation({
              image,
              attachmentImage: image,
              preview: URL.createObjectURL(image),
              url: capturedPage.url,
              liveToken: chosen?.sitePreviewToken,
              customRender: chosen?.siteCustomRender,
            });
            setSiteControlValues({});
            setEditorMode("comment");
            setShowSiteOriginal(false);
            setSitePreviewStatus("idle");
            if (chosen) {
              const {
                siteSuggestedComment,
                sitePreviewToken: _token,
                siteCustomRender: _customRender,
                ...marker
              } = chosen;
              setMarker(marker);
              setComment(siteSuggestedComment ?? "");
            } else {
              setMarker(null);
              setComment("");
            }
            if (capturedPage.marker)
              window.requestAnimationFrame(() => annotationInput.current?.focus());
          } catch {
            releaseCapturedSite();
            setFeedback("captureFailed");
          }
        } else {
          releaseCapturedSite();
          setFeedback(event.kind === "copied" ? "copied" : "captureFailed");
        }
      }
    };
    const opening = detachedLease
      ? connectDetachedBrowser(lease, events, () => cancelled)
      : invoke<void>("workbench_browser_open", {
          id: lease,
          url: latest.current.url,
          history: latest.current.history,
          projectPathKey: latest.current.projectPathKey,
          events,
        });
    void opening
      .then(() => {
        if (cancelled) {
          if (!detachedLease)
            return browserCommand(lease, { action: "close" }).catch(() => undefined);
          return;
        }
        setStartFailed(false);
        setNativeId(lease);
      })
      .catch(() => {
        if (!cancelled) setStartFailed(true);
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      window.clearTimeout(captureTimeout.current);
      capturePage.current = null;
      if (!detachedLease) void browserCommand(lease, { action: "close" }).catch(() => undefined);
    };
  }, [attempt, detachedLease, id, keepAlive, scope, supported]);

  useEffect(() => {
    if (!nativeId || detachedLease || !state.sshLoopback) return;
    const selected = sshTarget.current;
    if (
      !props.projectPathKey ||
      (selected && !props.sshTargets?.some((target) => target.id === selected.sessionId))
    ) {
      sshTarget.current = null;
      void invoke("workbench_browser_loopback", {
        id: nativeId,
        request: { action: "close" },
      }).catch(() => undefined);
    }
  }, [detachedLease, nativeId, props.projectPathKey, props.sshTargets, state.sshLoopback]);

  useEffect(() => {
    if (!nativeId || workspaceDetached) return;
    const root = document.documentElement;
    let last: "light" | "dark" | null = null;
    const sync = () => {
      const scheme = root.classList.contains("dark") ? "dark" : "light";
      if (scheme === last) return;
      last = scheme;
      void browserCommand(nativeId, { action: "theme", scheme }).catch(() => undefined);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [nativeId, workspaceDetached]);

  useEffect(() => {
    if (!active || !showDevice || !page.current) return;
    const stage = page.current;
    const measure = () => {
      const { width, height } = stage.getBoundingClientRect();
      if (!deviceViewportInitialized.current && width > 0 && height > 0) {
        deviceViewportInitialized.current = true;
        setDeviceViewport({
          preset: "responsive",
          width: clampDeviceDimension("width", width - 40),
          height: clampDeviceDimension("height", height - 20),
        });
      }
      setDeviceStage((old) =>
        old.width === width && old.height === height ? old : { width, height },
      );
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(stage);
    return () => resize.disconnect();
  }, [active, showDevice]);

  useEffect(() => {
    if (!nativeId || workspaceDetached) return;
    let frame = 0;
    let retry = 0;
    let failures = 0;
    let disposed = false;
    const updateLayout = () => {
      const viewportNode = showDevice ? deviceFrame.current : page.current;
      const bounds =
        active &&
        hasPage &&
        !startFailed &&
        !state.loadFailed &&
        !annotation &&
        !menuOpen &&
        !siteOpen &&
        viewportNode
          ? contentBounds(viewportNode)
          : null;
      const viewport =
        deviceMode && fittedScale > 0
          ? { width: viewportWidth, height: viewportHeight, scale: fittedScale }
          : null;
      const sitePreviewToken = active && hasPage ? (liveToken ?? null) : null;
      const key = JSON.stringify([bounds, viewport, sitePreviewToken]);
      if (key === lastLayout.current) return;
      lastLayout.current = key;
      const version = ++layoutVersion.current;
      void browserCommand(nativeId, {
        action: "layout",
        bounds,
        viewport,
        sitePreviewToken,
        version,
      }).then(
        () => {
          if (layoutVersion.current === version) failures = 0;
        },
        () => {
          if (layoutVersion.current !== version) return;
          lastLayout.current = "";
          if (disposed || !bounds) return;
          if (failures++ === 0) retry = window.setTimeout(updateLayout, 100);
          else setStartFailed(true);
        },
      );
    };
    updateLayout();
    if (!active) return;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        updateLayout();
      });
    };
    const resize = new ResizeObserver(schedule);
    if (page.current) resize.observe(page.current);
    const mutations = new MutationObserver((records) => {
      if (
        records.some(
          ({ type, target }) =>
            type === "childList" ||
            (target instanceof Element &&
              (target.matches(nativeCoverSelector) || target.querySelector(nativeCoverSelector))),
        )
      )
        schedule();
    });
    mutations.observe(document.body, {
      attributes: true,
      attributeFilter: ["class", "data-state", "hidden", "style"],
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("visibilitychange", schedule);
    document.addEventListener("transitionend", schedule, true);
    return () => {
      disposed = true;
      window.clearTimeout(retry);
      window.cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("visibilitychange", schedule);
      document.removeEventListener("transitionend", schedule, true);
    };
  }, [
    active,
    annotation,
    deviceMode,
    fittedScale,
    hasPage,
    liveToken,
    menuOpen,
    nativeId,
    showDevice,
    siteOpen,
    startFailed,
    state.loadFailed,
    viewportHeight,
    viewportWidth,
    workspaceDetached,
  ]);

  useEffect(() => {
    if (!state.loading) {
      setSlow(false);
      return;
    }
    const timeout = window.setTimeout(() => setSlow(true), 25_000);
    return () => window.clearTimeout(timeout);
  }, [state.loading]);

  useEffect(() => {
    if (nativeId && reloadToken !== previousReloadToken.current) {
      void browserCommand(nativeId, { action: "reload" }).catch(() => setFeedback("actionFailed"));
    }
    previousReloadToken.current = reloadToken;
  }, [nativeId, reloadToken]);

  useEffect(() => {
    if (!nativeId || !findOpen) return;
    const timeout = window.setTimeout(() => {
      void browserCommand(nativeId, { action: "find", text: findText }).catch(() =>
        setFeedback("actionFailed"),
      );
    }, 140);
    return () => window.clearTimeout(timeout);
  }, [findOpen, findText, nativeId]);

  useEffect(() => {
    const preview = annotation?.preview;
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [annotation?.preview]);

  useEffect(() => {
    if (!nativeId || !liveToken || !active) return;
    return () => {
      sitePreviewRequest.current = null;
      lastSitePreview.current = undefined;
      window.clearTimeout(sitePreviewDeadline.current);
      void browserCommand(nativeId, { action: "closeSiteAnnotation", token: liveToken }).catch(
        () => undefined,
      );
    };
  }, [active, liveToken, nativeId]);

  useEffect(() => {
    if (!active && liveToken) {
      setAnnotation((current) =>
        current?.liveToken === liveToken ? { ...current, liveToken: undefined } : current,
      );
    }
  }, [active, liveToken]);

  useEffect(() => {
    if (!active || !nativeId || !liveToken) return;
    if (lastSitePreview.current !== liveToken && !siteControlChanges && !showSiteOriginal) {
      sitePreviewRequest.current = null;
      setSitePreviewStatus("idle");
      return;
    }
    const revision = ++sitePreviewSequence.current;
    sitePreviewRequest.current = { token: liveToken, revision, original: showSiteOriginal };
    setSitePreviewStatus("loading");
    const timeout = window.setTimeout(() => {
      lastSitePreview.current = liveToken;
      const changes: { callback: string; value: SiteControlValue }[] = siteControlChanges
        ? JSON.parse(siteControlChanges)
        : [];
      sitePreviewDeadline.current = window.setTimeout(() => setSitePreviewStatus("failed"), 5000);
      void browserCommand(nativeId, {
        action: "previewSiteAnnotation",
        token: liveToken,
        revision,
        values: changes.map(({ callback, value }) => ({ callback, value })),
        original: showSiteOriginal,
      }).catch(() => {
        if (sitePreviewRequest.current?.revision !== revision) return;
        window.clearTimeout(sitePreviewDeadline.current);
        setSitePreviewStatus("failed");
      });
    }, 60);
    return () => {
      window.clearTimeout(timeout);
      window.clearTimeout(sitePreviewDeadline.current);
    };
  }, [active, liveToken, nativeId, showSiteOriginal, siteControlChanges]);

  function run(action: BrowserAction) {
    if (!nativeId) return Promise.resolve();
    setFeedback(null);
    return browserCommand(nativeId, action).catch(() => {
      setFeedback("actionFailed");
    });
  }

  function closeFind() {
    setFindOpen(false);
    setFindText("");
    void run({ action: "stopFind" });
  }

  const openFind = useCallback(() => {
    setFindOpen(true);
    window.requestAnimationFrame(() => findInput.current?.focus());
  }, []);

  useEffect(() => {
    if (!active || !nativeId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && annotation && !menuOpen) {
        event.preventDefault();
        setAnnotation(null);
      } else if (event.key === "Escape" && inspecting) {
        event.preventDefault();
        setInspecting(false);
        void browserCommand(nativeId, { action: "selectRegion", enabled: false }).catch(() =>
          setFeedback("annotationUnavailable"),
        );
      } else if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "l") {
        event.preventDefault();
        address.current?.focus();
      } else if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === "f" && shownUrl) {
        event.preventDefault();
        openFind();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, annotation, inspecting, menuOpen, nativeId, openFind, shownUrl]);

  useEffect(() => {
    if (active || !nativeId || !inspecting) return;
    setInspecting(false);
    void browserCommand(nativeId, { action: "selectRegion", enabled: false }).catch(
      () => undefined,
    );
  }, [active, inspecting, nativeId]);

  useEffect(() => {
    if (!active || workspaceDetached) return;
    const bar = browserBar.current;
    const leading = browserLeading.current;
    const trailing = browserTrailing.current;
    if (!bar || !leading || !trailing) return;
    const measure = () => {
      bar.style.setProperty("--za-browser-leading", `${leading.offsetWidth}px`);
      bar.style.setProperty("--za-browser-trailing", `${trailing.offsetWidth}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(leading);
    observer.observe(trailing);
    return () => observer.disconnect();
  }, [active, workspaceDetached]);

  function navigateTo(input: string) {
    const next = resolveBrowserAddress(input);
    if (!next) {
      setFeedback("invalid");
      return;
    }
    address.current?.blur();
    if (nativeId && props.openPrivateBrowserPort && browserLoopbackAddress(next)) {
      void props.openPrivateBrowserPort(nativeId, next).catch(() => setFeedback("actionFailed"));
      return;
    }
    const target = sshTarget.current;
    if (state.sshLoopback && target && browserLoopbackAddress(next)) {
      void openSshLoopback(target.sessionId, next).catch(() => setFeedback("actionFailed"));
      return;
    }
    void run({ action: "navigate", url: next });
  }

  function navigate(event: FormEvent) {
    event.preventDefault();
    navigateTo(draft);
  }

  async function openSshLoopback(sessionId: string, url: string) {
    if (!nativeId || !latest.current.projectPathKey) throw new Error(l.actionFailed);
    const previous = sshTarget.current;
    sshTarget.current = { sessionId, url };
    try {
      await invoke("workbench_browser_loopback", {
        id: nativeId,
        request: { action: "open", sessionId, url },
      });
    } catch (error) {
      sshTarget.current = previous;
      throw error;
    }
  }

  function capture(toClipboard: boolean, marker?: CaptureMarker) {
    if (capturePage.current || capturing || !nativeId || !state.url || state.loading) return;
    setMenuOpen(false);
    setCapturing(true);
    setFeedback(null);
    capturePage.current = { url: state.url, toClipboard, marker };
    const releaseSite = () => {
      if (marker?.sitePreviewToken)
        void browserCommand(nativeId, {
          action: "closeSiteAnnotation",
          token: marker.sitePreviewToken,
        }).catch(() => undefined);
    };
    captureTimeout.current = window.setTimeout(() => {
      capturePage.current = null;
      setCapturing(false);
      setFeedback("captureFailed");
      releaseSite();
    }, 8_000);
    // Let the menu dismiss before taking the native viewport capture.
    window.requestAnimationFrame(() =>
      window.requestAnimationFrame(() => {
        void browserCommand(nativeId, { action: "screenshot", toClipboard }).catch(() => {
          window.clearTimeout(captureTimeout.current);
          capturePage.current = null;
          setCapturing(false);
          setFeedback("captureFailed");
          releaseSite();
        });
      }),
    );
  }

  function setSelectionMode(enabled: boolean) {
    if (!nativeId || !state.url || state.loading) return;
    setFeedback(null);
    setInspecting(enabled);
    void browserCommand(nativeId, { action: "selectRegion", enabled }).catch(() => {
      setInspecting(false);
      setFeedback("annotationUnavailable");
    });
  }

  function toggleInspect() {
    setSelectionMode(!inspecting);
  }

  function annotatePoint() {
    if (!nativeId) return;
    setInspecting(false);
    void browserCommand(nativeId, { action: "selectRegion", enabled: false })
      .then(() => capture(false))
      .catch(() => setFeedback("captureFailed"));
  }

  function changeZoom(next: number) {
    const factor = Math.max(0.25, Math.min(3, Math.round(next * 100) / 100));
    setZoom(factor);
    void run({ action: "zoom", factor });
  }

  function choosePoint(event: PointerEvent<HTMLImageElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return;
    setMarker({
      x: (event.clientX - box.left) / box.width,
      y: (event.clientY - box.top) / box.height,
    });
    window.requestAnimationFrame(() => annotationInput.current?.focus());
  }

  function saveAnnotation(event: FormEvent) {
    event.preventDefault();
    if (
      !annotation ||
      !marker ||
      addingAnnotation ||
      (!comment.trim() && !siteControlChanges) ||
      (liveToken && sitePreviewStatus === "loading")
    )
      return;
    const item = {
      id: annotation.id ?? createUuid(),
      image: annotation.attachmentImage ?? annotation.image,
      url: annotation.url,
      ...marker,
      controlValues: siteControlValues,
      ...(siteControlChanges ? { siteControlChanges } : {}),
      text: comment.trim() || (marker.localStylePreview ? l.styleNote : l.siteControlNote),
    };
    const next = annotation.id
      ? annotations.map((candidate) => (candidate.id === annotation.id ? item : candidate))
      : [...annotations, item];
    setAnnotations(next);
    setAnnotation(null);
    if (!annotation.id && next.length < MAX_ANNOTATIONS) setSelectionMode(true);
    else setReviewOpen(true);
  }

  function editAnnotation(item: QueuedAnnotation) {
    if (inspecting) setSelectionMode(false);
    setAnnotation({
      id: item.id,
      image: item.image,
      preview: URL.createObjectURL(item.image),
      url: item.url,
    });
    setMarker({
      x: item.x,
      y: item.y,
      target: item.target,
      width: item.width,
      height: item.height,
      siteLabel: item.siteLabel,
      siteMetadata: item.siteMetadata,
      selectedText: item.selectedText,
      siteControls: item.siteControls,
      localStylePreview: item.localStylePreview,
    });
    setSiteControlValues(item.controlValues);
    setEditorMode("comment");
    setShowSiteOriginal(false);
    setSitePreviewStatus("idle");
    setComment(item.text);
    window.requestAnimationFrame(() => annotationInput.current?.focus());
  }

  async function addAnnotations() {
    if (annotations.length === 0 || addingAnnotationRef.current || !onAnnotate) return;
    addingAnnotationRef.current = true;
    setAddingAnnotation(true);
    setAnnotationError("");
    try {
      if (inspecting) setSelectionMode(false);
      await onAnnotate(
        annotations.map(
          ({
            id: _id,
            siteControls: _siteControls,
            localStylePreview: _localStyle,
            controlValues: _controlValues,
            ...item
          }) => item,
        ),
      );
      setAnnotations([]);
      setReviewOpen(false);
    } catch (error) {
      setAnnotationError(error instanceof Error && error.message ? error.message : l.actionFailed);
    } finally {
      addingAnnotationRef.current = false;
      setAddingAnnotation(false);
    }
  }

  const status = feedback ?? (slow ? "slow" : null);
  const capturingAnnotation = capturing && capturePage.current?.toClipboard === false;
  const anchorX = marker ? marker.x + (marker.width ?? 0) / 2 : 0.5;
  const anchorY = marker ? marker.y + (marker.height ?? 0) / 2 : 0.5;
  const securityLabel = shownUrl.startsWith("https:") ? l.secure : l.insecure;
  const committedUrl = state.url ? new URL(state.url) : null;
  const annotationOrigin =
    committedUrl &&
    (committedUrl.protocol === "https:" ||
      ["localhost", "127.0.0.1", "[::1]"].includes(committedUrl.hostname))
      ? committedUrl.origin
      : null;
  function updateSiteAnnotations(enabled?: boolean) {
    if (!annotationOrigin || state.loading) return;
    void run({ action: "siteAnnotations", origin: annotationOrigin, enabled });
  }
  const history = historyState?.history;
  const canGoBack =
    (!historyState?.durableTraversal && state.canGoBack) ||
    (history?.index == null ? !!history?.entries.length : history.index > 0);
  const canGoForward =
    (!historyState?.durableTraversal && state.canGoForward) ||
    (history?.index != null && history.index + 1 < history.entries.length);
  const detach = () => {
    if (!workspaceDetached) detachedAnnotationTarget.current = latest.current.onDetachedAnnotate;
    return run({
      action: "detach",
      locale: locale.startsWith("zh") ? "zh" : "en",
      scheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    });
  };
  if (workspaceDetached) {
    return (
      <section className="za-workspace-browser" aria-label={l.browser} hidden={!active}>
        <div className="za-workspace-browser-empty">
          <Globe />
          <strong>{l.openedInWindow}</strong>
          <button type="button" onClick={() => void detach()}>
            {l.focusWindow}
          </button>
          <button type="button" onClick={() => void run({ action: "returnToWorkspace" })}>
            {l.returnToWorkspace}
          </button>
          {feedback && <span role="status">{l[feedback]}</span>}
        </div>
      </section>
    );
  }
  return (
    <section className="za-workspace-browser" aria-label={l.browser} hidden={!active}>
      <div ref={browserBar} className="za-workspace-browser-bar">
        <div ref={browserLeading} className="za-workspace-browser-leading">
          <nav
            className="za-workspace-browser-history za-browser-capsule"
            aria-label={l.navigation}
          >
            <button
              type="button"
              title={l.back}
              aria-label={l.back}
              disabled={!canGoBack}
              onClick={() => void run({ action: "back" })}
            >
              <ArrowLeft />
            </button>
            <button
              type="button"
              title={l.forward}
              aria-label={l.forward}
              disabled={!canGoForward}
              onClick={() => void run({ action: "forward" })}
            >
              <ArrowRight />
            </button>
            <span className="za-browser-nav-divider" aria-hidden="true" />
            <button
              type="button"
              title={state.loading ? l.stop : l.reload}
              aria-label={state.loading ? l.stop : l.reload}
              aria-busy={state.loading}
              disabled={!nativeId || (!shownUrl && !state.loading)}
              onClick={() => void run({ action: state.loading ? "stop" : "reload" })}
            >
              {state.loading ? <Square /> : <RotateCw />}
            </button>
          </nav>
          {shownUrl && onAnnotate && (
            <button
              type="button"
              className="za-workspace-browser-annotate za-browser-ask"
              title={l.ask}
              aria-label={l.ask}
              aria-pressed={inspecting || Boolean(annotation)}
              disabled={
                !state.url ||
                state.loading ||
                capturing ||
                !!annotation ||
                addingAnnotation ||
                annotations.length >= MAX_ANNOTATIONS
              }
              onClick={toggleInspect}
            >
              <SquareMousePointer />
              <span>{l.ask}</span>
            </button>
          )}
        </div>
        <form
          className="za-workspace-browser-address"
          data-address-editing={addressFocused || undefined}
          onSubmit={navigate}
        >
          {shownUrl && (
            <Popover
              open={siteOpen}
              onOpenChange={(open) => {
                setSiteOpen(open);
                if (open) updateSiteAnnotations();
              }}
            >
              <PopoverTrigger
                className="za-workspace-browser-site"
                type="button"
                title={l.siteInfo}
                aria-label={l.siteInfo}
                tabIndex={addressFocused ? -1 : undefined}
              >
                <Info />
              </PopoverTrigger>
              <PopoverContent align="start" className="w-64 space-y-2 p-3">
                <PopoverTitle className="break-all">{new URL(shownUrl).host}</PopoverTitle>
                <PopoverDescription>{securityLabel}</PopoverDescription>
                <p className="text-xs text-muted-foreground">{l.sitePermissions}</p>
                {onAnnotate && (
                  <label className="flex items-start gap-2 border-t border-border pt-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      checked={
                        !!annotationOrigin &&
                        siteAnnotation?.origin === annotationOrigin &&
                        siteAnnotation.enabled
                      }
                      disabled={
                        !annotationOrigin ||
                        state.loading ||
                        siteAnnotation?.origin !== annotationOrigin
                      }
                      onChange={(event) => updateSiteAnnotations(event.currentTarget.checked)}
                    />
                    <span>
                      {l.siteAnnotations}
                      <small className="mt-1 block text-xs text-muted-foreground">
                        {annotationOrigin
                          ? l.siteAnnotationDescription
                          : l.siteAnnotationUnavailable}
                      </small>
                    </span>
                  </label>
                )}
              </PopoverContent>
            </Popover>
          )}
          <input
            ref={address}
            aria-label={l.address}
            type="text"
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            disabled={!nativeId}
            placeholder={l.address}
            value={addressFocused ? draft : formatBrowserAddress(shownUrl)}
            onFocus={(event) => {
              setDraft(shownUrl);
              setAddressFocused(true);
              const input = event.currentTarget;
              window.requestAnimationFrame(() => input.select());
            }}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={() => setAddressFocused(false)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                event.currentTarget.blur();
              }
            }}
          />
          {shownUrl && !state.ephemeralAddress && (
            <button
              className="za-workspace-browser-external"
              type="button"
              title={l.external}
              aria-label={l.external}
              onClick={() => {
                if (detachedLease) void run({ action: "openExternal" });
                else void openUrl(shownUrl).catch(() => setFeedback("actionFailed"));
              }}
            >
              <ExternalLink />
            </button>
          )}
        </form>
        <div ref={browserTrailing} className="za-workspace-browser-trailing">
          <div className="za-browser-capsule za-browser-utilities">
            {nativeId && (
              <BrowserExtensionMenu
                key={`extensions:${nativeId}`}
                id={nativeId}
                active={active}
                pageUrl={state.url}
                onVisitStore={() =>
                  void run({ action: "navigate", url: "https://chromewebstore.google.com/" })
                }
              />
            )}
            <button
              type="button"
              title={l.downloads}
              aria-label={l.downloads}
              disabled={!nativeId}
              onClick={() => void run({ action: "downloads" })}
            >
              <Download />
              {state.hasDownloads && (
                <span className="za-browser-download-indicator" aria-hidden="true" />
              )}
            </button>
          </div>
          {nativeId && (
            <BrowserSshLoopbackMenu
              key={`ssh:${nativeId}`}
              active={Boolean(state.sshLoopback)}
              targets={props.sshTargets ?? []}
              onOpen={openSshLoopback}
              onClose={async () => {
                await invoke("workbench_browser_loopback", {
                  id: nativeId,
                  request: { action: "close" },
                });
                sshTarget.current = null;
              }}
            />
          )}
          <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) => {
              setMenuOpen(open);
              if (open) setDeviceDefault(deviceToolbarPreference(scope));
            }}
          >
            <DropdownMenuTrigger
              render={
                <button
                  className="za-browser-capsule za-browser-options"
                  type="button"
                  title={l.menu}
                  aria-label={l.menu}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-52">
              <DropdownMenuItem disabled={!state.url} onClick={openFind}>
                <Search className="mr-2 size-4" />
                {l.find}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!state.url || capturing} onClick={() => capture(true)}>
                <Camera className="mr-2 size-4" />
                {l.screenshot}
              </DropdownMenuItem>
              {onAnnotate && (
                <DropdownMenuItem
                  disabled={!state.url || state.loading || capturing}
                  onClick={toggleInspect}
                >
                  <Pencil className="mr-2 size-4" />
                  {l.annotate}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>{l.deviceToolbar}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem
                    disabled={!state.url}
                    onClick={() => setDeviceEnabled(!deviceEnabled)}
                  >
                    {deviceEnabled ? l.hideDeviceToolbar : l.showDeviceToolbar}
                  </DropdownMenuItem>
                  <DropdownMenuCheckboxItem
                    checked={deviceDefault}
                    onCheckedChange={(next) => {
                      setDeviceDefault(next);
                      deviceToolbarPreference(scope, next);
                    }}
                  >
                    {l.deviceToolbarDefault}
                  </DropdownMenuCheckboxItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem
                disabled={!state.url || zoom <= 0.25}
                closeOnClick={false}
                onClick={() => changeZoom(zoom - 0.1)}
              >
                <Minus className="mr-2 size-4" />
                {l.zoomOut}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!state.url || zoom === 1}
                closeOnClick={false}
                onClick={() => changeZoom(1)}
              >
                {l.resetZoom}
                <span className="ml-auto pl-2 tabular-nums">{Math.round(zoom * 100)}%</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!state.url || zoom >= 3}
                closeOnClick={false}
                onClick={() => changeZoom(zoom + 0.1)}
              >
                <Plus className="mr-2 size-4" />
                {l.zoomIn}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!state.url} onClick={() => void run({ action: "print" })}>
                <Printer className="mr-2 size-4" />
                {l.print}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!nativeId}
                onClick={() => void run({ action: "downloads" })}
              >
                <Download className="mr-2 size-4" />
                {l.downloads}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!nativeId || !!annotation || capturing}
                onClick={() =>
                  void (detachedLease ? run({ action: "returnToWorkspace" }) : detach())
                }
              >
                <ExternalLink className="mr-2 size-4" />
                {detachedLease ? l.returnToWorkspace : l.detachWindow}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {state.loading && (
          <div
            className="za-workspace-browser-progress"
            role="progressbar"
            aria-label={l.loading}
          />
        )}
      </div>
      {findOpen && (
        <form
          className="za-workspace-browser-find"
          onSubmit={(event) => {
            event.preventDefault();
            void run({ action: "findNext", backwards: false });
          }}
        >
          <Search />
          <input
            ref={findInput}
            value={findText}
            placeholder={l.find}
            aria-label={l.find}
            onChange={(event) => setFindText(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeFind();
              }
              if (event.key === "Enter" && event.shiftKey) {
                event.preventDefault();
                void run({ action: "findNext", backwards: true });
              }
            }}
          />
          <span aria-live="polite">
            {findText ? `${Math.max(0, state.findIndex + 1)}/${state.findCount}` : ""}
          </span>
          <button
            type="button"
            title={l.previous}
            aria-label={l.previous}
            disabled={state.findCount < 1}
            onClick={() => void run({ action: "findNext", backwards: true })}
          >
            <ChevronUp />
          </button>
          <button type="submit" title={l.next} aria-label={l.next} disabled={state.findCount < 1}>
            <ChevronDown />
          </button>
          <button type="button" title={l.close} aria-label={l.close} onClick={closeFind}>
            <X />
          </button>
        </form>
      )}
      {status && (
        <div className="za-workspace-browser-status" role="status">
          <span>{l[status]}</span>
          {status === "slow" && (
            <button type="button" onClick={() => void run({ action: "reload" })}>
              {l.retry}
            </button>
          )}
          {status === "annotationUnavailable" && onAnnotate && (
            <button type="button" onClick={annotatePoint}>
              {l.annotatePoint}
            </button>
          )}
          {feedback && (
            <button
              type="button"
              aria-label={l.close}
              title={l.close}
              onClick={() => setFeedback(null)}
            >
              <X />
            </button>
          )}
        </div>
      )}
      {showDevice && (
        <BrowserDeviceToolbar
          viewport={deviceViewport}
          zoom={zoom}
          onChange={setDeviceViewport}
          onZoom={changeZoom}
          onClose={() => setDeviceEnabled(false)}
        />
      )}
      <div
        className="za-workspace-browser-page"
        ref={page}
        data-device-stage={showDevice || undefined}
        aria-busy={state.loading || undefined}
      >
        {showDevice && fitted && (
          <div
            className="za-workspace-browser-device-frame"
            style={{ width: fitted.width, height: fitted.height }}
          >
            <div className="za-workspace-browser-device-content" ref={deviceFrame} />
            {deviceViewport.preset === "responsive" && fitted.scale > 0 && (
              <BrowserDeviceResizeHandles
                viewport={deviceViewport}
                scale={fitted.scale}
                stage={deviceStage}
                onChange={setDeviceViewport}
              />
            )}
          </div>
        )}
        {annotation ? (
          <div className="za-workspace-browser-annotation">
            <div className="za-workspace-browser-annotation-stage">
              <div className="za-workspace-browser-annotation-image">
                <img
                  src={annotation.preview}
                  alt={l.annotate}
                  onPointerDown={
                    marker?.width || marker?.target || annotation.id ? undefined : choosePoint
                  }
                />
                {marker?.width && marker.height
                  ? !annotation.customRender && (
                      <span
                        aria-hidden="true"
                        className="za-workspace-browser-region"
                        style={{
                          left: `${marker.x * 100}%`,
                          top: `${marker.y * 100}%`,
                          width: `${marker.width * 100}%`,
                          height: `${marker.height * 100}%`,
                        }}
                      />
                    )
                  : marker && (
                      <span
                        aria-hidden="true"
                        className="za-workspace-browser-pin"
                        style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
                      >
                        {annotation.id
                          ? annotations.findIndex((item) => item.id === annotation.id) + 1
                          : annotations.length + 1}
                      </span>
                    )}
                <div
                  className="za-browser-annotation-card"
                  data-compact={
                    marker &&
                    !marker.siteMetadata &&
                    !marker.selectedText &&
                    (!siteControls.length ||
                      (marker.localStylePreview && editorMode === "comment")) &&
                    !siteControlChanges
                      ? true
                      : undefined
                  }
                  data-empty={!marker || undefined}
                  data-above={anchorY >= 0.55 || undefined}
                  data-before={anchorX > 0.55 || undefined}
                  style={
                    {
                      "--anchor-x": `${anchorX * 100}%`,
                      "--anchor-y": `${anchorY * 100}%`,
                    } as CSSProperties
                  }
                >
                  {editorMode === "comment" && (marker?.selectedText || marker?.siteMetadata) && (
                    <aside
                      className="max-h-24 overflow-auto border-t border-border px-3 py-2 text-xs text-muted-foreground"
                      aria-label={l.siteContext}
                    >
                      {marker.selectedText && (
                        <blockquote className="whitespace-pre-wrap">
                          {marker.selectedText}
                        </blockquote>
                      )}
                      {marker.siteMetadata && (
                        <code className="block break-all">{marker.siteMetadata}</code>
                      )}
                    </aside>
                  )}
                  {siteControls.length > 0 &&
                    (!marker?.localStylePreview || editorMode === "style") && (
                      <BrowserSiteControls
                        controls={siteControls}
                        values={siteControlValues}
                        title={marker?.localStylePreview ? l.annotationStyle : l.siteControls}
                        onChange={(callback, value) => {
                          setShowSiteOriginal(false);
                          setSiteControlValues((old) => ({ ...old, [callback]: value }));
                        }}
                      />
                    )}
                  {liveToken && (siteControlChanges || sitePreviewStatus !== "idle") && (
                    <div className="flex items-center justify-end gap-2 px-3 pb-1 text-xs text-muted-foreground">
                      {sitePreviewStatus !== "idle" && (
                        <span role="status">
                          {sitePreviewStatus === "loading"
                            ? l.sitePreviewLoading
                            : l.sitePreviewUnavailable}
                        </span>
                      )}
                      {siteControlChanges && (
                        <button
                          type="button"
                          aria-pressed={showSiteOriginal}
                          onPointerDown={(event) => {
                            if (event.button !== 0) return;
                            event.currentTarget.setPointerCapture(event.pointerId);
                            setShowSiteOriginal(true);
                          }}
                          onPointerUp={() => setShowSiteOriginal(false)}
                          onLostPointerCapture={() => setShowSiteOriginal(false)}
                          onKeyDown={(event) => {
                            if (event.key !== " " && event.key !== "Enter") return;
                            event.preventDefault();
                            setShowSiteOriginal(true);
                          }}
                          onKeyUp={(event) => {
                            if (event.key !== " " && event.key !== "Enter") return;
                            event.preventDefault();
                            setShowSiteOriginal(false);
                          }}
                          onBlur={() => setShowSiteOriginal(false)}
                          onClick={(event) => {
                            if (event.detail === 0) setShowSiteOriginal((shown) => !shown);
                          }}
                        >
                          {l.showSiteOriginal}
                        </button>
                      )}
                    </div>
                  )}
                  <form onSubmit={saveAnnotation} className="za-workspace-browser-annotation-form">
                    {marker?.localStylePreview && siteControls.length > 0 && (
                      <button
                        type="button"
                        className="za-browser-annotation-style-toggle"
                        title={editorMode === "style" ? l.annotationComment : l.annotationStyle}
                        aria-label={
                          editorMode === "style" ? l.annotationComment : l.annotationStyle
                        }
                        aria-pressed={editorMode === "style"}
                        onClick={() => {
                          setEditorMode(editorMode === "style" ? "comment" : "style");
                          if (editorMode === "style")
                            window.requestAnimationFrame(() => annotationInput.current?.focus());
                        }}
                      >
                        <SlidersHorizontal />
                      </button>
                    )}
                    {marker ? (
                      <>
                        {(marker.siteLabel || marker.target) && (
                          <code title={marker.siteLabel || marker.target}>
                            {marker.siteLabel || marker.target}
                          </code>
                        )}
                        <textarea
                          hidden={editorMode === "style"}
                          ref={annotationInput}
                          value={comment}
                          onChange={(event) => setComment(event.currentTarget.value)}
                          onKeyDown={(event) => {
                            if (
                              event.key === "Enter" &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault();
                              event.currentTarget.form?.requestSubmit();
                            }
                          }}
                          placeholder={l.comment}
                          aria-label={l.comment}
                          rows={2}
                          maxLength={1500}
                        />
                      </>
                    ) : (
                      <span>{l.point}</span>
                    )}
                    <button
                      type="submit"
                      title={l.saveAnnotation}
                      aria-label={l.saveAnnotation}
                      disabled={
                        !marker ||
                        (!comment.trim() && !siteControlChanges) ||
                        addingAnnotation ||
                        (!!liveToken && sitePreviewStatus === "loading")
                      }
                    >
                      <Check />
                    </button>
                    <button
                      type="button"
                      title={l.close}
                      aria-label={l.close}
                      onClick={() => setAnnotation(null)}
                    >
                      <X />
                    </button>
                  </form>
                </div>
              </div>
            </div>
          </div>
        ) : supported && !startFailed && !state.loadFailed && !state.loading && !shownUrl ? (
          <BrowserNewTab
            active={active}
            tools={props.newTabTools}
            visits={props.visits ?? []}
            onNavigate={navigateTo}
            onOpenTab={props.onOpenTab}
            onOpenAddress={() => address.current?.focus()}
            onOpenOptions={() => setMenuOpen(true)}
            onVisitStore={() => navigateTo("https://chromewebstore.google.com/")}
          />
        ) : (state.loading || (shownUrl && !nativeId)) && !startFailed ? (
          <div className="za-workspace-browser-empty" role="status">
            <span>{l.loading}</span>
          </div>
        ) : (
          (!supported || startFailed || state.loadFailed) && (
            <div className="za-workspace-browser-empty">
              <Globe />
              <strong>{l.blank}</strong>
              <span>{!supported ? l.unsupported : startFailed ? l.unavailable : l.failed}</span>
              {(startFailed || state.loadFailed) && (
                <button
                  type="button"
                  onClick={() =>
                    startFailed ? setAttempt((value) => value + 1) : void run({ action: "reload" })
                  }
                >
                  {l.retry}
                </button>
              )}
            </div>
          )
        )}
      </div>
      {(inspecting || capturingAnnotation || annotation || annotations.length > 0) && (
        <div className="za-browser-annotation-tray">
          <section className="za-browser-annotation-toolbar" aria-label={l.annotating}>
            {capturingAnnotation && !inspecting && (
              <div className="za-browser-annotation-capturing" role="status">
                {l.captureSelection}
              </div>
            )}
            {inspecting && (
              <div
                className="za-workspace-browser-status za-browser-annotation-selection"
                role="status"
              >
                <span title={l.selectElement}>{l.annotating}</span>
                <button
                  type="button"
                  title={l.annotatePoint}
                  aria-label={l.annotatePoint}
                  onClick={annotatePoint}
                >
                  <Camera />
                </button>
                <button type="button" aria-label={l.close} title={l.close} onClick={toggleInspect}>
                  <X />
                </button>
              </div>
            )}
            {annotation && (
              <div className="za-workspace-browser-status">
                <span>{l.annotating}</span>
                <button
                  type="button"
                  aria-label={l.close}
                  title={l.close}
                  onClick={() => setAnnotation(null)}
                >
                  <X />
                </button>
              </div>
            )}
            {annotations.length > 0 && (
              <div className="za-browser-annotation-queue">
                <div className="za-workspace-browser-status">
                  {!inspecting && !annotation && !capturing && (
                    <button
                      type="button"
                      title={l.continueAnnotating}
                      aria-label={l.continueAnnotating}
                      onClick={() => setSelectionMode(true)}
                    >
                      <SquareMousePointer />
                    </button>
                  )}
                  <button
                    type="button"
                    aria-expanded={reviewOpen}
                    onClick={() => setReviewOpen(!reviewOpen)}
                  >
                    {reviewOpen ? <ChevronUp /> : <ChevronDown />}
                    {l.annotations} ({annotations.length})
                  </button>
                  <button
                    type="button"
                    title={l.clearAnnotations}
                    aria-label={l.clearAnnotations}
                    disabled={addingAnnotation || Boolean(annotation) || capturing}
                    onClick={() => {
                      setAnnotations([]);
                      setReviewOpen(false);
                      setAnnotationError("");
                    }}
                  >
                    <Trash2 />
                  </button>
                  <button
                    type="button"
                    className="za-workspace-browser-annotation-commit"
                    disabled={addingAnnotation || Boolean(annotation) || capturing}
                    onClick={() => void addAnnotations()}
                  >
                    {addingAnnotation ? l.attaching : l.attach}
                  </button>
                </div>
              </div>
            )}
          </section>
          {annotations.length > 0 && (annotationError || reviewOpen) && (
            <div className="za-workspace-browser-annotations za-browser-annotation-review">
              {annotationError && (
                <p role="alert" className="za-workspace-browser-status">
                  {annotationError}
                </p>
              )}
              {reviewOpen && (
                <ol aria-label={l.annotations}>
                  {annotations.map((item, index) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        disabled={addingAnnotation || Boolean(annotation) || capturing}
                        className="za-workspace-browser-annotation-row"
                        onClick={() => editAnnotation(item)}
                        aria-label={`${l.editAnnotation} ${index + 1}`}
                      >
                        <span className="za-workspace-browser-annotation-number">{index + 1}</span>
                        <span title={item.text}>{item.text}</span>
                        <Pencil />
                      </button>
                      <button
                        type="button"
                        aria-label={`${l.deleteAnnotation} ${index + 1}`}
                        disabled={addingAnnotation || Boolean(annotation) || capturing}
                        onClick={() =>
                          setAnnotations((current) =>
                            current.filter((entry) => entry.id !== item.id),
                          )
                        }
                      >
                        <X />
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
