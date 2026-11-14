import type { ReactNode } from "react";
import {
  type CSSProperties,
  type MouseEvent,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { mountWorkbenchLayout } from "../../application/workbenchLayoutPortal";
import {
  ArrowLeft,
  Blend,
  Package as Box,
  Cable,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Loader2,
  MoreHorizontal,
  FilePenLine as Pencil,
  Plus,
  Search,
  Settings,
  SquarePen,
  Upload,
  X,
} from "../../components/IconSet";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { Input } from "../../components/ui/input";
import { LabelTooltip } from "../../components/ui/label-tooltip";
import { ScrollArea } from "../../components/ui/scroll-area";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarHeaderRow,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../../components/ui/sidebar";
import {
  SidebarResizeContext,
  SidebarResizeHandle,
  useSidebarWidthLayout,
} from "../../components/ui/sidebar-resize";
import { StatusNotice } from "../../components/ui/status-notice";
import { Switch } from "../../components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { TooltipButton as Button } from "../../components/ui/tooltip-button";
import { useLocale } from "../../i18n";
import {
  builtinSkillPresentation,
  extensionDescription,
  extensionDisplayName,
  extensionOverview,
  extensionSearchText,
  extensionSkillDescription,
  extensionSkillDisplayName,
  extensionStarterPrompts,
  extensionTryError,
  usesExtensionPackagePresentation,
} from "../../lib/extensions/presentation";
import { ExtensionDirectoryItem } from "./ExtensionDirectoryItem";
import { ExtensionImportDialog } from "./ExtensionImportDialog";
import { ExtensionMark } from "./ExtensionMark";
import {
  extensionSessionStorage,
  readExtensionDraft,
  writeExtensionDraft,
} from "./extensionDrafts";
import {
  type ExtensionCatalog,
  type ExtensionKind,
  type ExtensionMutation,
  type ExtensionPackage,
  type ExtensionPreparedDraft,
  type ExtensionRevision,
  ExtensionRevisionUnavailable,
  type ExtensionSkill,
  type ExtensionsAdapter,
  type ExtensionTryResult,
  type ExtensionWorkspaceLocation,
  type ExtensionWorkspaceRoute,
  extensionOwned,
  extensionSkillEnabled,
} from "./extensionTypes";
import {
  SkillReaderFileMenu,
  SkillReaderFileTree,
  SkillReaderMarkdown,
  SkillSourceCard,
  skillReaderFileLinks,
} from "./SkillReaderFiles";
import "./extensions.css";

type Route = ExtensionWorkspaceRoute;
type RemovalFailure =
  | { kind: "failed"; message: string }
  | { kind: "unconfirmed"; previousCatalog: ExtensionCatalog };
type DirectoryBrowse = {
  query: string;
  source: "public" | "personal";
  installation: "all" | "installed" | "uninstalled";
  scrollTop: number;
};
type DirectoryInstallFocus = {
  button: HTMLButtonElement;
  browse: DirectoryBrowse;
  route: string;
  id: string;
  neighbor: string | undefined;
};
const maxDirectoryQueryLength = 512;
const maxDirectoryScrollTop = 100_000;

function findDirectoryRow(viewport: HTMLDivElement | null, id: string) {
  return Array.from(
    viewport?.querySelectorAll<HTMLButtonElement>("[data-extension-open]") ?? [],
  ).find((item) => item.dataset.extensionOpen === id);
}

function extensionManagementEnabled(pkg: ExtensionPackage) {
  return pkg.installed && pkg.enabled;
}

function directoryBrowseKey(scope: string) {
  return `zeroagent:extensions-browse:${encodeURIComponent(scope)}`;
}

function normalizeDirectoryBrowse(entry?: Partial<DirectoryBrowse>): DirectoryBrowse {
  return {
    query: typeof entry?.query === "string" ? entry.query.slice(0, maxDirectoryQueryLength) : "",
    source: entry?.source === "personal" ? "personal" : "public",
    installation:
      entry?.installation === "installed" || entry?.installation === "uninstalled"
        ? entry.installation
        : "all",
    scrollTop: Number.isFinite(entry?.scrollTop)
      ? Math.max(0, Math.min(maxDirectoryScrollTop, Math.round(entry?.scrollTop ?? 0)))
      : 0,
  };
}

function readDirectoryBrowse(scope: string): Record<ExtensionKind, DirectoryBrowse> {
  let stored: Partial<Record<ExtensionKind, DirectoryBrowse>> | undefined;
  try {
    const raw = extensionSessionStorage()?.getItem(directoryBrowseKey(scope));
    if (raw && raw.length <= 8192) stored = JSON.parse(raw);
  } catch {
    /* The directory remains usable if tab storage is blocked or damaged. */
  }
  return {
    plugin: normalizeDirectoryBrowse(stored?.plugin),
    skill: normalizeDirectoryBrowse(stored?.skill),
  };
}
type SkillSelection = {
  pkg: ExtensionPackage;
  skill: ExtensionSkill;
  revision?: number;
  returnToChat?: boolean;
};
type SkillReaderTarget = { id: string; skillName?: string; revision?: number };
type ReaderManagementReturn = {
  packageId: string;
  location: ExtensionWorkspaceLocation;
  selection: SkillSelection | null;
};
type DeviceSkillAction = (
  pkg: ExtensionPackage,
  skill: ExtensionSkill,
  revision: number,
  signal: AbortSignal,
) => Promise<void>;
type AppSelection = { name: string; description: string; packageId: string; local?: boolean };
function restoredRoute(scope: string): Route {
  try {
    const value = JSON.parse(
      extensionSessionStorage()?.getItem(`zeroagent:extensions-view:${scope}`) ?? "null",
    );
    if (value?.page === "plugins" || value?.page === "skills") return { page: value.page };
    if (
      (value?.page === "plugin" || value?.page === "manage" || value?.page === "editor") &&
      (typeof value.id === "string" || (value.page === "editor" && value.id === undefined))
    )
      return value;
  } catch {
    /* A stale navigation entry does not block opening the directory. */
  }
  return { page: "plugins" };
}
function ExtensionsNavigationFrame({
  shared,
  title,
  preview,
  sidebarLayout,
  children,
  target,
}: {
  shared?: boolean;
  title: string;
  preview?: boolean;
  sidebarLayout: ReturnType<typeof useSidebarWidthLayout>;
  children: ReactNode;
  target?: HTMLElement | null;
}) {
  if (shared) {
    const navigation = (
      <div className="za-extensions-shared-sidebar relative shrink-0">
        <Sidebar
          label={title}
          previewOpen={preview}
          className="bg-background"
          data-sidebar-preview-region=""
        >
          {children}
        </Sidebar>
      </div>
    );
    return target === undefined
      ? navigation
      : target && mountWorkbenchLayout(navigation, target, "account-sidebar");
  }
  return (
    <SidebarResizeContext.Provider value={sidebarLayout}>
      <div className="za-extensions-sidebar-container">
        {children}
        <SidebarResizeHandle />
      </div>
    </SidebarResizeContext.Provider>
  );
}

function ExtensionsSidebarOpener() {
  const { open, isMobile } = useSidebar();
  if (open || isMobile) return null;
  return (
    <div className="px-3 pt-2">
      <SidebarTrigger />
    </div>
  );
}

function ExtensionsMobileSidebarTrigger() {
  const { isMobile } = useSidebar();
  if (!isMobile) return null;
  return <SidebarTrigger className="size-11 shrink-0" showShortcut={false} />;
}

type ExtensionsWorkspaceProps = {
  adapter: ExtensionsAdapter;
  catalog: ExtensionCatalog | null;
  loading: boolean;
  error: string;
  onCatalog: (catalog: ExtensionCatalog) => void;
  onRefresh: () => void;
  onBack: () => void;
  onTry: (pkg: ExtensionPackage, skill: ExtensionSkill, text?: string) => ExtensionTryResult;
  onReturnToDraft?: () => void;
  onTryOnDevice?: DeviceSkillAction;
  onConfigureImages?: () => void;
  onOpenDeviceSettings?: (section: "skills" | "mcp") => void;
  openPackage?: { id: string; key: number; draft?: boolean; skillName?: string };
  location?: ExtensionWorkspaceLocation;
  onNavigate?: (location: ExtensionWorkspaceLocation) => void;
  sharedSidebar?: boolean;
  /** undefined keeps the browser layout; null leaves sidebar navigation to the host. */
  sidebarTarget?: HTMLElement | null;
  sidebarOnly?: boolean;
  previewOpen?: boolean;
  onPinSidebar?: () => void;
};

export function ExtensionsWorkspace(props: ExtensionsWorkspaceProps) {
  return <ScopedExtensionsWorkspace key={props.adapter.scope} {...props} />;
}

function ScopedExtensionsWorkspace(props: ExtensionsWorkspaceProps) {
  const { adapter, catalog } = props;
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "en-US" ? en : zh);
  const installedLabel = copy("已安装", "Installed");
  const uninstalledLabel = copy("未安装", "Not installed");
  const manageLabel = copy("管理", "Manage");
  const installLabel = copy("安装", "Install");
  const uninstallLabel = copy("卸载", "Uninstall");
  const skillsLabel = copy("技能", "Skills");
  const backLabel = copy("返回对话", "Back to chat");
  const customizeLabel = copy("自定义", "Customize");
  const installedSearchLabel = copy("搜索已安装的插件", "Search installed plugins");
  const deviceScope = locale === "en-US" ? "This computer" : "此电脑";
  const deviceEntries = [
    { id: "skills", name: locale === "en-US" ? "Skills" : "技能", icon: Box },
    { id: "mcp", name: locale === "en-US" ? "Connections" : "连接", icon: Cable },
  ] as const;
  const host = useRef<HTMLDivElement>(null);
  const sidebarLayout = useSidebarWidthLayout(host, props.sharedSidebar, 720);
  const [localRoute, setRoute] = useState<Route>(() => restoredRoute(adapter.scope));
  const route = props.location?.route ?? localRoute;
  const directoryKind = route.page === "skills" ? "skill" : "plugin";
  const isDirectoryPage = route.page === "plugins" || route.page === "skills";
  const [directoryBrowse, setDirectoryBrowse] = useState(() => readDirectoryBrowse(adapter.scope));
  const { query, source, installation } = directoryBrowse[directoryKind];
  const directoryScroll = useRef({
    plugin: directoryBrowse.plugin.scrollTop,
    skill: directoryBrowse.skill.scrollTop,
  });
  const contentViewport = useRef<HTMLDivElement>(null);
  const hasCatalog = Boolean(catalog);
  const visibleDirectoryKind =
    isDirectoryPage && hasCatalog && !props.loading && !props.sidebarOnly ? directoryKind : null;
  const latestDirectory = useRef<{
    directoryBrowse: typeof directoryBrowse;
    visibleDirectoryKind: ExtensionKind | null;
  }>({ directoryBrowse, visibleDirectoryKind });
  latestDirectory.current = { directoryBrowse, visibleDirectoryKind };
  const savedDirectory = useRef<string | undefined>(undefined);
  useEffect(() => {
    const persist = () => {
      const latest = latestDirectory.current;
      if (latest.visibleDirectoryKind && contentViewport.current) {
        directoryScroll.current[latest.visibleDirectoryKind] = contentViewport.current.scrollTop;
      }
      const value = JSON.stringify({
        plugin: normalizeDirectoryBrowse({
          ...latest.directoryBrowse.plugin,
          scrollTop: directoryScroll.current.plugin,
        }),
        skill: normalizeDirectoryBrowse({
          ...latest.directoryBrowse.skill,
          scrollTop: directoryScroll.current.skill,
        }),
      });
      if (savedDirectory.current === value) return;
      try {
        extensionSessionStorage()?.setItem(directoryBrowseKey(adapter.scope), value);
        savedDirectory.current = value;
      } catch {
        /* The current view remains available in memory. */
      }
    };
    window.addEventListener("pagehide", persist);
    return () => {
      window.removeEventListener("pagehide", persist);
      persist();
    };
  }, [adapter.scope]);
  const heading = useRef<HTMLHeadingElement>(null);
  const installationFilter = useRef<HTMLButtonElement>(null);
  const previousFocusRoute = useRef<string | undefined>(undefined);
  const directoryFocusReturn = useRef<{ kind: ExtensionKind; id: string } | null>(null);
  const directoryInstallFocus = useRef<DirectoryInstallFocus | null>(null);
  const searchRecoveryFocus = useRef<HTMLButtonElement | null>(null);
  const [installingDirectoryItem, setInstallingDirectoryItem] = useState<string | null>(null);
  const scrollRoute =
    route.page === "plugin" || route.page === "manage" ? `${route.page}:${route.id}` : route.page;
  const currentDirectoryBrowse = directoryBrowse[directoryKind];
  useLayoutEffect(() => {
    const opener = searchRecoveryFocus.current;
    if (!opener) return;
    searchRecoveryFocus.current = null;
    if (!isDirectoryPage || props.sidebarOnly || !currentDirectoryBrowse.query.trim()) return;
    const { activeElement, body } = opener.ownerDocument;
    if (activeElement === opener || activeElement === body) {
      contentViewport.current?.querySelector<HTMLButtonElement>("[data-extension-open]")?.focus();
    }
  }, [currentDirectoryBrowse, isDirectoryPage, props.sidebarOnly]);
  useLayoutEffect(() => {
    const operation = directoryInstallFocus.current;
    if (!operation) return;
    if (
      props.sidebarOnly ||
      operation.route !== scrollRoute ||
      operation.browse !== currentDirectoryBrowse
    ) {
      directoryInstallFocus.current = null;
      return;
    }
    if (installingDirectoryItem) return;
    directoryInstallFocus.current = null;
    if (!catalog?.packages.some((item) => item.id === operation.id && item.installed)) return;
    const document = operation.button.ownerDocument;
    const viewport = contentViewport.current;
    if (
      !viewport ||
      viewport.closest("[hidden], [inert]") ||
      (document.activeElement !== document.body && document.activeElement !== operation.button)
    )
      return;
    const row = findDirectoryRow(viewport, operation.id);
    const neighbor = operation.neighbor
      ? findDirectoryRow(viewport, operation.neighbor)
      : undefined;
    (row ?? neighbor ?? installationFilter.current)?.focus();
  }, [catalog, currentDirectoryBrowse, installingDirectoryItem, props.sidebarOnly, scrollRoute]);
  const updateDirectoryBrowse = useCallback(
    (kind: ExtensionKind, changes: Partial<DirectoryBrowse>) => {
      setDirectoryBrowse((previous) => ({
        ...previous,
        [kind]: { ...previous[kind], ...changes },
      }));
    },
    [],
  );
  const resetDirectoryBrowse = useCallback(
    (kind: ExtensionKind, changes?: Partial<DirectoryBrowse>) => {
      updateDirectoryBrowse(kind, { ...changes, query: "" });
      directoryScroll.current[kind] = 0;
      if (isDirectoryPage && directoryKind === kind && contentViewport.current) {
        contentViewport.current.scrollTop = 0;
      }
    },
    [directoryKind, isDirectoryPage, updateDirectoryBrowse],
  );
  useLayoutEffect(() => {
    const viewport = contentViewport.current;
    if (!viewport || props.loading || props.sidebarOnly || (isDirectoryPage && !hasCatalog)) return;
    viewport.scrollTop =
      scrollRoute === "plugins"
        ? directoryScroll.current.plugin
        : scrollRoute === "skills"
          ? directoryScroll.current.skill
          : 0;
  }, [hasCatalog, isDirectoryPage, props.loading, props.sidebarOnly, scrollRoute]);
  const [installedSearchOpen, setInstalledSearchOpen] = useState(false);
  const [installedQuery, setInstalledQuery] = useState("");
  const installedSearchInput = useRef<HTMLInputElement>(null);
  const installedSearchButton = useRef<HTMLButtonElement>(null);
  const sourceOptions = [
    ["public", copy("公开", "Public")],
    ["personal", copy("个人", "Personal")],
  ] as const;
  const [localSelection, setLocalSelection] = useState<SkillSelection | null>(null);
  const reader = props.location?.reader;
  const readerPackage = reader && catalog?.packages.find((item) => item.id === reader.id);
  const archivedSkill =
    reader?.revision && reader.skillName
      ? {
          name: reader.skillName,
          description:
            readerPackage?.legacy_skills?.find(
              (skill) => skill.name === reader.skillName && skill.version === reader.revision,
            )?.description ?? "",
          entry: "",
        }
      : undefined;
  const readerSkill =
    readerPackage &&
    (reader?.skillName
      ? (readerPackage.skills.find((item) => item.name === reader.skillName) ?? archivedSkill)
      : readerPackage.kind === "skill"
        ? readerPackage.skills[0]
        : undefined);
  const selected: SkillSelection | null = props.location
    ? readerPackage && readerSkill
      ? {
          pkg: readerPackage,
          skill: readerSkill,
          revision: reader?.revision,
          returnToChat: reader?.returnToChat,
        }
      : null
    : localSelection;
  const readerTarget: SkillReaderTarget | undefined = reader?.revision
    ? reader
    : selected
      ? { id: selected.pkg.id, skillName: selected.skill.name, revision: selected.revision }
      : undefined;
  const hasReader = Boolean(reader || selected);
  const readerReturnsToChat = Boolean(selected?.returnToChat ?? reader?.returnToChat);
  const [readerManagementReturn, setReaderManagementReturn] =
    useState<ReaderManagementReturn | null>(null);
  const readerReinstallFocus = useRef<HTMLButtonElement | null>(null);
  const returnToOriginalSkillButton = useRef<HTMLButtonElement>(null);
  const originalReader =
    !props.sidebarOnly && route.page === "manage" && route.id === readerManagementReturn?.packageId
      ? readerManagementReturn
      : null;
  useEffect(() => {
    if (readerManagementReturn && !originalReader) setReaderManagementReturn(null);
  }, [readerManagementReturn, originalReader]);
  const previousReader = useRef<{ route: string; scope: string; returnsToChat: boolean } | null>(
    null,
  );
  const readerOpener = useRef<{
    element: HTMLButtonElement;
    route: string;
    scope: string;
    scrollTop: number;
  } | null>(null);
  useLayoutEffect(() => {
    const previous = previousReader.current;
    previousReader.current = hasReader
      ? { route: scrollRoute, scope: adapter.scope, returnsToChat: readerReturnsToChat }
      : null;
    if (hasReader || !previous) return;
    const opener = readerOpener.current;
    readerOpener.current = null;
    if (
      previous.route !== scrollRoute ||
      previous.scope !== adapter.scope ||
      previous.returnsToChat ||
      props.sidebarOnly
    ) {
      return;
    }
    // Restore after the dialog releases focus and the background is no longer inert.
    const frame = requestAnimationFrame(() => {
      const viewport = contentViewport.current;
      if (
        opener?.scope === adapter.scope &&
        opener.route === scrollRoute &&
        viewport?.contains(opener.element)
      ) {
        viewport.scrollTop = opener.scrollTop;
        opener.element.focus({ preventScroll: true });
      } else {
        heading.current?.focus({ preventScroll: true });
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [adapter.scope, hasReader, props.sidebarOnly, readerReturnsToChat, scrollRoute]);
  useLayoutEffect(() => {
    if (props.loading || props.sidebarOnly || hasReader || !heading.current) return;
    const previous = previousFocusRoute.current;
    if (previous === scrollRoute) return;
    previousFocusRoute.current = scrollRoute;
    if (isDirectoryPage) {
      const target = directoryFocusReturn.current;
      directoryFocusReturn.current = null;
      if (!previous?.startsWith("plugin:") && !previous?.startsWith("manage:")) return;
      const row =
        target?.kind === directoryKind &&
        (previous === `plugin:${target.id}` || previous === `manage:${target.id}`)
          ? findDirectoryRow(contentViewport.current, target.id)
          : undefined;
      (row ?? heading.current).focus({ preventScroll: true });
    } else {
      heading.current.focus({ preventScroll: true });
    }
  }, [directoryKind, hasReader, isDirectoryPage, props.loading, props.sidebarOnly, scrollRoute]);
  const setSelected = (selection: SkillSelection | null) => {
    if (!props.onNavigate) {
      setLocalSelection(selection);
      return;
    }
    props.onNavigate({
      route,
      reader: selection
        ? {
            id: selection.pkg.id,
            skillName:
              selection.pkg.kind === "plugin" || selection.revision
                ? selection.skill.name
                : undefined,
            revision: selection.revision,
            returnToChat: selection.returnToChat,
          }
        : undefined,
    });
  };
  const openReader = (selection: SkillSelection, element: HTMLButtonElement) => {
    readerOpener.current = {
      element,
      route: scrollRoute,
      scope: adapter.scope,
      scrollTop: contentViewport.current?.scrollTop ?? 0,
    };
    setSelected(selection);
  };
  const [selectedApp, setSelectedApp] = useState<AppSelection | null>(null);
  const pluginEditorApp = {
    name: locale === "en-US" ? "Plugin editor" : "插件编辑器",
    description:
      locale === "en-US"
        ? "Write plugin instructions, skills and supporting files, then save them to your personal directory."
        : "编写插件说明、技能和附属文件，并保存到个人目录。",
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tryFailure, setTryFailure] = useState<Exclude<ExtensionTryResult, "accepted"> | null>(
    null,
  );
  // Reset feedback when the location changes, including a browser history traversal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the route and workspace visibility scope the notice.
  useEffect(() => {
    setTryFailure(null);
  }, [scrollRoute, props.sidebarOnly]);
  function tryInChat(item: ExtensionPackage, skill: ExtensionSkill, text?: string) {
    const result = props.onTry(item, skill, text);
    setTryFailure(result === "accepted" ? null : result);
  }
  function returnToDraft() {
    setTryFailure(null);
    (props.onReturnToDraft ?? props.onBack)();
  }
  const [notice, setNotice] = useState("");
  const [expandedSkills, setExpandedSkills] = useState(false);
  const [importKind, setImportKind] = useState<ExtensionKind | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState("");
  const [remove, setRemove] = useState<ExtensionPackage | null>(null);
  const [removalFailure, setRemovalFailure] = useState<RemovalFailure | null>(null);
  const mutationLock = useRef(false);
  const searchId = useId();
  const installationValueId = useId();
  const appsHeadingId = useId();
  const removalStatusId = useId();
  const trialStatusId = useId();
  const upload = useRef<HTMLInputElement>(null);
  const editorDirty = useRef(false);
  const writeBlocked = busy || !!adapter.writeUnconfirmed || props.loading;
  const removalName = remove ? extensionDisplayName(remove, locale) : "";
  const removalEntry = remove && catalog?.packages.find((item) => item.id === remove.id);
  const removalNeedsCheck =
    removalFailure?.kind === "unconfirmed" &&
    (adapter.writeUnconfirmed ||
      !catalog ||
      catalog === removalFailure.previousCatalog ||
      props.loading ||
      !!props.error);
  const removalConfirmed =
    !!remove && !!catalog && !writeBlocked && !props.error && !removalEntry?.installed;
  const removalActionDisabled = removalNeedsCheck
    ? busy || props.loading
    : !removalConfirmed && (writeBlocked || !removalEntry?.installed);
  const removalTone = removalConfirmed
    ? "success"
    : removalFailure?.kind === "failed"
      ? "error"
      : "warning";
  let removalMessage = removalFailure?.kind === "failed" ? removalFailure.message : "";
  if (removalNeedsCheck) {
    if (props.loading) {
      removalMessage = copy("正在从目录核对安装状态…", "Checking installation status…");
    } else {
      removalMessage = props.error
        ? copy("暂时无法核对卸载结果，请重试。", "Couldn't check the uninstall result. Try again.")
        : copy(
            "卸载结果尚未确认。请核对目录后再继续。",
            "The uninstall result is unconfirmed. Check the directory before continuing.",
          );
    }
  } else if (removalConfirmed) {
    removalMessage = copy(
      "已卸载。已有聊天和成果仍然保留。",
      "Uninstalled. Existing chats and results are kept.",
    );
  } else if (removalFailure?.kind === "unconfirmed") {
    removalMessage = copy(
      "核对后发现此内容仍已安装。你可以再次确认卸载。",
      "The directory shows this item is still installed. You can confirm uninstall again.",
    );
  }
  const [pendingRoute, setPendingRoute] = useState<{
    route: Route;
    reader?: SkillSelection;
  } | null>(null);
  const handledOpen = useRef<number | null>(null);
  useEffect(() => {
    const target = props.openPackage;
    if (!target || handledOpen.current === target.key) return;
    const targetPackage = catalog?.packages.find((item) => item.id === target.id);
    if (!target.draft && !targetPackage) return;
    const skill =
      targetPackage?.kind === "skill"
        ? targetPackage.skills[0]
        : targetPackage?.skills.find((item) => item.name === target.skillName);
    const reader =
      !target.draft && targetPackage && skill
        ? { pkg: targetPackage, skill, returnToChat: true }
        : undefined;
    handledOpen.current = target.key;
    const next: Route = target.draft
      ? { page: "editor", draftId: target.id }
      : reader?.pkg.kind === "skill"
        ? { page: "skills" }
        : { page: "plugin", id: target.id };
    if (editorDirty.current) setPendingRoute({ route: next, reader });
    else {
      setRoute(next);
      if (targetPackage) resetDirectoryBrowse(targetPackage.kind);
      setError("");
      setNotice("");
      setLocalSelection(reader ?? null);
      setSelectedApp(null);
      setExpandedSkills(false);
    }
  }, [props.openPackage, catalog, resetDirectoryBrowse]);
  useEffect(() => {
    if (props.location) return;
    try {
      extensionSessionStorage()?.setItem(
        `zeroagent:extensions-view:${adapter.scope}`,
        JSON.stringify(route),
      );
    } catch {
      /* Navigation remains available without session storage. */
    }
  }, [adapter.scope, props.location, route]);
  const packages = catalog?.packages ?? [];
  const selectedPackage = selected
    ? (packages.find((item) => item.id === selected.pkg.id) ?? selected.pkg)
    : null;
  const pkg = "id" in route ? packages.find((item) => item.id === route.id) : undefined;
  const packageLabel = pkg ? extensionDisplayName(pkg, locale) : "";
  const packageExamples = pkg ? extensionStarterPrompts(pkg, locale) : [];
  const trialSkill = pkg?.skills[0];
  const canTryPackage = Boolean(pkg && trialSkill && extensionSkillEnabled(pkg, trialSkill));
  const trialStatus =
    route.page === "plugin" &&
    pkg?.kind === "plugin" &&
    pkg.installed &&
    trialSkill &&
    !canTryPackage &&
    !props.error
      ? !pkg.enabled
        ? copy(
            "此插件已停用。请在管理中启用插件后再试用。",
            "This plugin is disabled. Enable it in Manage to try it in chat.",
          )
        : copy(
            `主技能「${extensionSkillDisplayName(pkg, trialSkill, locale)}」已停用。请在管理中启用该技能后再试用。`,
            `The primary skill “${extensionSkillDisplayName(pkg, trialSkill, locale)}” is disabled. Enable it in Manage to try it in chat.`,
          )
      : "";
  useLayoutEffect(() => {
    const opener = readerReinstallFocus.current;
    if (!opener) return;
    if (!originalReader) {
      readerReinstallFocus.current = null;
      return;
    }
    if (!pkg?.installed || busy) return;
    readerReinstallFocus.current = null;
    const { activeElement, body } = opener.ownerDocument;
    if (activeElement === body || activeElement === opener) {
      returnToOriginalSkillButton.current?.focus({ preventScroll: true });
    }
  }, [busy, originalReader, pkg?.installed]);
  const navigate = (next: Route, force = false, readerReturn?: ReaderManagementReturn) => {
    if (!force && route.page === "editor" && editorDirty.current) {
      setPendingRoute({ route: next });
      return;
    }
    if (isDirectoryPage && !props.loading && contentViewport.current) {
      directoryScroll.current[directoryKind] = contentViewport.current.scrollTop;
    }
    if (props.onNavigate) props.onNavigate({ route: next });
    else setRoute(next);
    setReaderManagementReturn(readerReturn ?? null);
    setError("");
    setNotice("");
    setTryFailure(null);
    setExpandedSkills(false);
  };
  const closeReader = () => {
    if (!selected && !readerReturnsToChat && route.page === "plugin" && !pkg) {
      navigate({ page: "plugins" });
      return;
    }
    setSelected(null);
    if (readerReturnsToChat) props.onBack();
  };
  const backToOriginalSkill = originalReader ? (
    <Button
      ref={returnToOriginalSkillButton}
      className="rounded-full"
      onClick={() => {
        setReaderManagementReturn(null);
        if (props.onNavigate) props.onNavigate(originalReader.location);
        else {
          setRoute(originalReader.location.route);
          setLocalSelection(originalReader.selection);
        }
      }}
    >
      <ArrowLeft className="size-4" />
      {copy("返回原技能", "Back to original skill")}
    </Button>
  ) : null;
  async function mutate(
    input: ExtensionMutation,
    success = copy("已保存", "Saved"),
    onFailure?: (message: string) => void,
  ) {
    if (!catalog || mutationLock.current || writeBlocked) return false;
    mutationLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    if (input.action === "uninstall") setRemovalFailure(null);
    try {
      props.onCatalog(await adapter.mutate(catalog.version, input));
      setNotice(success);
      return true;
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : copy("保存失败，请重试。", "Could not save. Try again.");
      if (input.action === "uninstall") {
        setRemovalFailure(
          adapter.writeUnconfirmed
            ? { kind: "unconfirmed", previousCatalog: catalog }
            : { kind: "failed", message },
        );
      } else setError(message);
      onFailure?.(message);
      return false;
    } finally {
      setBusy(false);
      mutationLock.current = false;
    }
  }
  function openUninstall(item: ExtensionPackage) {
    setRemovalFailure(null);
    setRemove(item);
  }
  async function download(item: ExtensionPackage) {
    setError("");
    try {
      const blob = await adapter.download(item.id),
        url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${item.name}.zip`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : copy("下载失败，请重试。", "Could not download. Try again."),
      );
    }
  }
  function selectImportFiles(files: File[]) {
    if (busy) return;
    setImportFile(null);
    setImportError("");
    if (files.length !== 1 || !/\.zip$/i.test(files[0]?.name ?? "")) {
      setImportError("请选择一个 ZIP 格式的插件或技能包。");
      return;
    }
    if (files[0].size > 350_000) {
      setImportError("ZIP 文件不能超过 350 KB，请精简包内文本后重试。");
      return;
    }
    setImportFile(files[0]);
  }
  async function confirmImport() {
    if (!importFile || !importKind || !catalog || mutationLock.current || writeBlocked) return;
    const kind = importKind;
    mutationLock.current = true;
    setBusy(true);
    setImportError("");
    try {
      const next = await adapter.importArchive(catalog.version, importFile, kind);
      props.onCatalog(next);
      resetDirectoryBrowse(kind, { source: "personal", installation: "all" });
      navigate({ page: kind === "plugin" ? "plugins" : "skills" });
      setImportKind(null);
      setNotice("已安装");
    } catch (cause) {
      setImportError(cause instanceof Error ? cause.message : "导入未完成，请重试。");
      if (adapter.writeUnconfirmed) setError("导入结果尚未确认，请刷新目录核对后再继续。");
    } finally {
      setBusy(false);
      mutationLock.current = false;
    }
  }
  const directoryLabel =
    directoryKind === "plugin" ? copy("插件", "Plugins") : copy("技能", "Skills");
  const searchLabel =
    directoryKind === "plugin"
      ? copy("搜索插件", "Search plugins")
      : copy("搜索技能", "Search skills");
  const pluginDirectoryActive =
    route.page === "plugins" || (pkg?.kind === "plugin" && !pkg.installed);
  const skillDirectoryActive = route.page === "skills" || pkg?.kind === "skill";
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const matchingSearch = packages.filter(
    (item) =>
      item.kind === directoryKind &&
      (!normalizedQuery || extensionSearchText(item).includes(normalizedQuery)),
  );
  const matchesInstallation = (item: ExtensionPackage) =>
    installation === "all" || item.installed === (installation === "installed");
  const filtered = matchingSearch.filter(
    (item) => item.visibility === source && matchesInstallation(item),
  );
  const recoverySource = matchingSearch.some((item) => item.visibility === source)
    ? source
    : source === "public"
      ? "personal"
      : "public";
  const searchRecovery =
    normalizedQuery && !filtered.length && matchingSearch.length > 0
      ? {
          source: recoverySource,
          installation: matchingSearch.some(
            (item) => item.visibility === recoverySource && matchesInstallation(item),
          )
            ? installation
            : ("all" as const),
        }
      : null;
  const recoverySourceLabel =
    recoverySource === "public" ? copy("公开", "Public") : copy("个人", "Personal");
  const searchEmptyMessage = !searchRecovery
    ? copy("没有找到匹配结果", "No matching results")
    : searchRecovery.source === source
      ? copy("其他安装状态下有匹配项。", "Matches are available under another installation status.")
      : copy(
          `「${recoverySourceLabel}」目录中有匹配项。`,
          `Matches are in ${recoverySourceLabel}.`,
        );
  async function installFromDirectory(
    item: ExtensionPackage,
    event: MouseEvent<HTMLButtonElement>,
  ) {
    if (writeBlocked || mutationLock.current) return;
    const button = event.currentTarget;
    const index = filtered.indexOf(item);
    const focus: DirectoryInstallFocus | null =
      button.ownerDocument.activeElement === button
        ? {
            button,
            browse: currentDirectoryBrowse,
            route: scrollRoute,
            id: item.id,
            neighbor: (filtered[index + 1] ?? filtered[index - 1])?.id,
          }
        : null;
    directoryInstallFocus.current = focus;
    setInstallingDirectoryItem(item.id);
    const name = extensionDisplayName(item, locale);
    const saved = await mutate(
      { action: "install", id: item.id },
      copy(`已安装 ${name}`, `${name} installed`),
    );
    if (!saved && directoryInstallFocus.current === focus) directoryInstallFocus.current = null;
    setInstallingDirectoryItem(null);
  }
  const installedPlugins = packages.filter(
    (item) =>
      item.installed &&
      item.kind === "plugin" &&
      extensionSearchText(item).includes(installedQuery.trim().toLocaleLowerCase()),
  );
  const directorySections = (
    directoryKind === "skill" && installation === "all"
      ? [
          {
            id: "installed",
            label: installedLabel,
            items: filtered.filter((item) => item.installed),
          },
          {
            id: "uninstalled",
            label: uninstalledLabel,
            items: filtered.filter((item) => !item.installed),
          },
        ].filter(({ items }) => items.length > 0)
      : [
          {
            id: installation,
            label:
              installation === "installed"
                ? installedLabel
                : installation === "uninstalled"
                  ? uninstalledLabel
                  : source === "public"
                    ? copy("公开目录", "Public directory")
                    : copy("你创建的", "Created by you"),
            items: filtered,
          },
        ]
  ).filter(({ items }) => !normalizedQuery || items.length > 0);
  const pluginEditorAvailable =
    pkg?.kind === "plugin" &&
    pkg.id === "plugin-creator" &&
    pkg.builtin &&
    pkg.visibility === "public";
  const closeInstalledSearch = () => {
    setInstalledSearchOpen(false);
    setInstalledQuery("");
    installedSearchButton.current?.focus();
  };
  const actionMenu = (item: ExtensionPackage, skill?: ExtensionSkill, sidebar = false) => {
    const label = extensionDisplayName(item, locale);
    const actionLabel = skill ? extensionSkillDisplayName(item, skill, locale) : label;
    const enabled = extensionManagementEnabled(item);
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            sidebar ? (
              <SidebarMenuAction
                type="button"
                showOnHover
                aria-label={copy(
                  `已安装插件 ${label}的操作`,
                  `Actions for installed plugin ${label}`,
                )}
              />
            ) : (
              <Button
                variant="ghost"
                size="icon"
                aria-label={copy(`${actionLabel}的操作`, `Actions for ${actionLabel}`)}
                title={copy("更多", "More")}
              />
            )
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={!extensionSkillEnabled(item, skill ?? item.skills[0])}
            onClick={() => tryInChat(item, skill ?? item.skills[0])}
          >
            <SquarePen className="size-4" />
            {copy("在对话中使用", "Use in chat")}
          </DropdownMenuItem>
          {extensionOwned(item) && (
            <DropdownMenuItem onClick={() => void download(item)}>
              <Download className="size-4" />
              {item.kind === "plugin"
                ? copy("下载插件包", "Download plugin package")
                : copy("下载技能包", "Download skill package")}
            </DropdownMenuItem>
          )}
          {extensionOwned(item) && (
            <DropdownMenuItem
              onClick={() => navigate({ page: "editor", id: item.id, kind: item.kind })}
            >
              <Pencil className="size-4" />
              {item.kind === "plugin"
                ? copy("编辑插件", "Edit plugin")
                : copy("编辑技能", "Edit skill")}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={() => {
              if (!sidebar && isDirectoryPage) {
                directoryFocusReturn.current = { kind: item.kind, id: item.id };
              }
              navigate({ page: "manage", id: item.id });
            }}
          >
            <Settings className="size-4" />
            {manageLabel}
          </DropdownMenuItem>
          {item.installed && (
            <DropdownMenuItem
              disabled={writeBlocked}
              onClick={() => void mutate({ action: "enable", id: item.id, enabled: !enabled })}
            >
              {enabled ? copy("停用", "Disable") : copy("启用", "Enable")}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {item.installed ? (
            <DropdownMenuItem
              className="text-destructive"
              disabled={writeBlocked}
              onClick={() => openUninstall(item)}
            >
              {uninstallLabel}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={writeBlocked}
              onClick={() => void mutate({ action: "install", id: item.id })}
            >
              {installLabel}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };
  const tryNotice = tryFailure ? (
    <StatusNotice
      className={pkg ? "my-4" : "mx-auto my-2 w-[calc(100%-2rem)] max-w-[900px] shrink-0"}
      data-extension-try-failure=""
      tone="warning"
      message={extensionTryError(tryFailure, locale)}
      onDismiss={() => setTryFailure(null)}
      actions={
        tryFailure === "draft-reference-conflict" ? (
          <button type="button" className="app-status-action" onClick={returnToDraft}>
            {copy("返回草稿", "Back to draft")}
          </button>
        ) : undefined
      }
    />
  ) : null;
  return (
    <div
      ref={host}
      className="za-extensions-workspace"
      data-testid="extensions-workspace"
      style={
        props.sharedSidebar
          ? undefined
          : ({ "--sidebar-width": `${sidebarLayout.width}px` } as CSSProperties)
      }
    >
      {(route.page !== "editor" || props.sidebarOnly) && (
        <ExtensionsNavigationFrame
          sidebarLayout={sidebarLayout}
          shared={props.sharedSidebar}
          target={props.sidebarTarget}
          title={customizeLabel}
          preview={props.previewOpen}
        >
          <ScrollArea className="h-full">
            <aside>
              <SidebarHeader className="px-3 pb-2 pt-2.5">
                <SidebarHeaderRow
                  actions={
                    <>
                      <Button
                        ref={installedSearchButton}
                        variant="ghost"
                        size="icon-sm"
                        title={installedSearchLabel}
                        aria-label={installedSearchLabel}
                        aria-expanded={installedSearchOpen}
                        onClick={() => {
                          if (installedSearchOpen) closeInstalledSearch();
                          else {
                            setInstalledSearchOpen(true);
                            requestAnimationFrame(() => installedSearchInput.current?.focus());
                          }
                        }}
                      >
                        <Search className="size-4" />
                      </Button>
                      {props.sharedSidebar && (
                        <SidebarTrigger
                          showShortcut={!props.previewOpen}
                          aria-label={
                            props.previewOpen ? copy("固定边栏", "Pin sidebar") : undefined
                          }
                          onClick={(event) => {
                            if (props.previewOpen) {
                              event.preventDefault();
                              props.onPinSidebar?.();
                            }
                          }}
                        />
                      )}
                    </>
                  }
                >
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    title={backLabel}
                    aria-label={backLabel}
                    onClick={props.onBack}
                  >
                    <ArrowLeft className="size-4" />
                  </Button>
                  <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold leading-6">
                    {customizeLabel}
                  </h2>
                </SidebarHeaderRow>
                {installedSearchOpen && (
                  <Input
                    ref={installedSearchInput}
                    className="mt-2 h-8"
                    type="search"
                    aria-label={copy("筛选已安装的插件", "Filter installed plugins")}
                    placeholder={installedSearchLabel}
                    value={installedQuery}
                    onChange={(event) => setInstalledQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
                      event.preventDefault();
                      event.stopPropagation();
                      closeInstalledSearch();
                    }}
                  />
                )}
              </SidebarHeader>
              <SidebarContent className="overflow-visible pb-3">
                <SidebarGroup className="px-3">
                  <nav aria-label={customizeLabel}>
                    <SidebarMenu className="gap-1">
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          type="button"
                          className="za-extension-nav sidebar-list-row min-h-9 rounded-lg"
                          isActive={pluginDirectoryActive}
                          aria-current={pluginDirectoryActive ? "page" : undefined}
                          onClick={() => navigate({ page: "plugins" })}
                        >
                          <span className="flex size-5 shrink-0 items-center justify-center">
                            <Blend className="size-4" />
                          </span>
                          <span>{copy("插件", "Plugins")}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          type="button"
                          className="za-extension-nav sidebar-list-row min-h-9 rounded-lg"
                          isActive={skillDirectoryActive}
                          aria-current={skillDirectoryActive ? "page" : undefined}
                          onClick={() => navigate({ page: "skills" })}
                        >
                          <span className="flex size-5 shrink-0 items-center justify-center">
                            <Box className="size-4" />
                          </span>
                          <span>{copy("技能", "Skills")}</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    </SidebarMenu>
                  </nav>
                </SidebarGroup>
                <SidebarGroup className="mt-4 px-3">
                  <SidebarGroupLabel className="h-7">
                    {installedLabel}
                    {adapter.scope.startsWith("cloud:") && (
                      <span className="ml-auto">{copy("账户", "Account")}</span>
                    )}
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu className="gap-1">
                      {installedPlugins.map((item) => (
                        <SidebarMenuItem key={item.id}>
                          <SidebarMenuButton
                            type="button"
                            className="za-extension-nav sidebar-list-row min-h-9 rounded-lg pr-8"
                            isActive={pkg?.id === item.id}
                            aria-current={pkg?.id === item.id ? "page" : undefined}
                            onClick={() => navigate({ page: "plugin", id: item.id })}
                          >
                            <ExtensionMark id={item.id} small />
                            <span className="truncate">{extensionDisplayName(item, locale)}</span>
                          </SidebarMenuButton>
                          {actionMenu(item, undefined, true)}
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                    {installedQuery.trim() && installedPlugins.length === 0 && (
                      <p className="px-2.5 py-2 text-xs text-muted-foreground" role="status">
                        {copy("没有匹配的已安装插件", "No installed plugins match")}
                      </p>
                    )}
                  </SidebarGroupContent>
                </SidebarGroup>
                {props.onOpenDeviceSettings && (
                  <SidebarGroup className="mt-4 px-3">
                    <SidebarGroupLabel className="h-7">{deviceScope}</SidebarGroupLabel>
                    <SidebarMenu className="gap-1">
                      {deviceEntries.map(({ id, name, icon: Icon }) => (
                        <SidebarMenuItem key={id}>
                          <SidebarMenuButton
                            type="button"
                            className="za-extension-nav sidebar-list-row min-h-9 rounded-lg"
                            onClick={() => props.onOpenDeviceSettings?.(id)}
                          >
                            <span className="flex size-5 shrink-0 items-center justify-center">
                              <Icon className="size-4" />
                            </span>
                            <span>{name}</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      ))}
                    </SidebarMenu>
                  </SidebarGroup>
                )}
              </SidebarContent>
            </aside>
          </ScrollArea>
        </ExtensionsNavigationFrame>
      )}
      <div className="za-extensions-main" hidden={props.sidebarOnly} inert={props.sidebarOnly}>
        {props.sharedSidebar &&
        props.sidebarTarget === undefined &&
        !props.sidebarOnly &&
        route.page !== "editor" ? (
          <ExtensionsSidebarOpener />
        ) : null}
        <div className="za-extensions-mobile-nav">
          {props.onOpenDeviceSettings && (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
                {deviceScope}
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                {deviceEntries.map(({ id, name, icon: Icon }) => (
                  <DropdownMenuItem key={id} onClick={() => props.onOpenDeviceSettings?.(id)}>
                    <Icon className="size-4" />
                    {name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <Button
            variant="ghost"
            size="icon"
            title={backLabel}
            aria-label={backLabel}
            onClick={props.onBack}
          >
            <ArrowLeft className="size-4" />
          </Button>
          {props.sharedSidebar && props.sidebarTarget === undefined && route.page !== "editor" ? (
            <ExtensionsMobileSidebarTrigger />
          ) : null}
          <Button
            variant={route.page === "plugins" ? "secondary" : "ghost"}
            onClick={() => navigate({ page: "plugins" })}
          >
            {copy("插件", "Plugins")}
          </Button>
          <Button
            variant={route.page === "skills" ? "secondary" : "ghost"}
            onClick={() => navigate({ page: "skills" })}
          >
            {copy("技能", "Skills")}
          </Button>
        </div>
        {pkg && (route.page === "plugin" || route.page === "manage") && (
          <nav
            className="za-extension-breadcrumb"
            aria-label={copy("当前位置", "Current location")}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate({ page: pkg.kind === "skill" ? "skills" : "plugins" })}
            >
              {pkg.kind === "skill" ? copy("技能", "Skills") : copy("插件", "Plugins")}
            </Button>
            <ChevronRight className="size-3.5" aria-hidden="true" />
            {route.page === "manage" ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  className="za-extension-breadcrumb-package"
                  aria-label={copy(
                    `查看 ${packageLabel} 的详情`,
                    `View details for ${packageLabel}`,
                  )}
                  title={packageLabel}
                  onClick={() => navigate({ page: "plugin", id: pkg.id })}
                >
                  <span className="min-w-0 truncate">{packageLabel}</span>
                </Button>
                <ChevronRight className="size-3.5" aria-hidden="true" />
                <span className="shrink-0" aria-current="page">
                  {manageLabel}
                </span>
              </>
            ) : (
              <span aria-current="page">{packageLabel}</span>
            )}
          </nav>
        )}
        {!pkg ? tryNotice : null}
        {route.page === "editor" && route.id && (!pkg || !extensionOwned(pkg)) ? (
          <Empty text="只能编辑你创建的插件或技能" />
        ) : route.page === "editor" ? (
          <SkillEditor
            key={`${adapter.scope}:${route.draftId ?? route.id ?? "new"}`}
            adapter={adapter}
            id={route.id}
            draftId={route.draftId}
            kind={pkg?.kind ?? route.kind ?? "skill"}
            catalog={catalog}
            onReconciled={props.onCatalog}
            onSaved={(next, kind) => {
              props.onCatalog(next);
              resetDirectoryBrowse(kind, { source: "personal", installation: "all" });
              navigate({ page: kind === "plugin" ? "plugins" : "skills" }, true);
            }}
            onBack={() => {
              if (route.draftId) {
                navigate({ page: "skills" }, true);
                props.onBack();
                return;
              }
              navigate(
                route.returnTo
                  ? { page: "plugin", id: route.returnTo }
                  : { page: (pkg?.kind ?? route.kind) === "plugin" ? "plugins" : "skills" },
                true,
              );
            }}
            onDirtyChange={(dirty) => {
              editorDirty.current = dirty;
            }}
          />
        ) : (
          <ScrollArea
            className="min-h-0 flex-1"
            contentClassName={`za-extensions-content${route.page === "plugin" || route.page === "manage" ? " za-extension-detail-content" : ""}`}
            viewportRef={contentViewport}
            viewportProps={{
              onScroll(event) {
                if (visibleDirectoryKind) {
                  directoryScroll.current[visibleDirectoryKind] = event.currentTarget.scrollTop;
                }
              },
            }}
          >
            {route.page === "plugins" || route.page === "skills" ? (
              <>
                <header className="za-extensions-header">
                  <div>
                    <h1 ref={heading} tabIndex={-1} className="outline-none">
                      {directoryLabel}
                    </h1>
                    <p>
                      {route.page === "plugins"
                        ? copy(
                            "让 ZeroAgent 在你的工作中发挥更多作用",
                            "Add capabilities to the way you work.",
                          )
                        : copy(
                            "为反复进行的工作，保存一套好用的方法",
                            "Save workflows you can use again.",
                          )}
                    </p>
                  </div>
                  <div className="za-extensions-header-actions">
                    <label htmlFor={searchId} className="za-extension-search">
                      <Search className="size-4" />
                      <Input
                        id={searchId}
                        aria-label={searchLabel}
                        placeholder={searchLabel}
                        maxLength={maxDirectoryQueryLength}
                        value={query}
                        onChange={(event) => {
                          updateDirectoryBrowse(directoryKind, { query: event.target.value });
                        }}
                      />
                    </label>
                    {route.page === "plugins" && (
                      <Button
                        variant="outline"
                        className="za-extension-manage-installed rounded-full"
                        aria-label={copy("管理已安装插件", "Manage installed plugins")}
                        title={copy("管理已安装插件", "Manage installed plugins")}
                        onClick={() =>
                          resetDirectoryBrowse("plugin", { installation: "installed" })
                        }
                      >
                        <Settings className="size-4" />
                        <span>{manageLabel}</span>
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button className="rounded-full" disabled={writeBlocked} />}
                      >
                        <Plus className="size-4" />
                        {copy("添加", "Add")}
                        <ChevronDown className="size-3" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            const creatorId =
                              directoryKind === "plugin" ? "plugin-creator" : "skill-creator";
                            const creator = packages.find((item) => item.id === creatorId);
                            const skill = creator?.skills[0];
                            if (creator && skill && extensionSkillEnabled(creator, skill))
                              tryInChat(
                                creator,
                                skill,
                                usesExtensionPackagePresentation(creator)
                                  ? extensionStarterPrompts(creator, locale)[0]
                                  : route.page === "plugins"
                                    ? copy(
                                        "帮我创建一个插件。以聊天的方式交流，先问我这个插件要完成什么任务，再整理其中的技能，生成可检查的插件包。",
                                        "Help me create a plugin. Ask what it should do, then organize its skills into a package I can review.",
                                      )
                                    : copy(
                                        "帮我创建一个技能。以聊天的方式交流，先问我这个技能要做什么，再生成可检查的技能包。",
                                        "Help me create a skill. Ask what it should do, then prepare a skill package I can review.",
                                      ),
                              );
                            else
                              setError(
                                `请先在${directoryKind === "plugin" ? "插件" : "技能"}目录中安装并启用${directoryKind === "plugin" ? "创建插件" : "创建技能"}。`,
                              );
                          }}
                        >
                          <SquarePen className="size-4" />
                          {copy("通过聊天创建", "Create in chat")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => navigate({ page: "editor", kind: directoryKind })}
                        >
                          <Pencil className="size-4" />
                          {copy("使用编辑器创建", "Create in editor")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setImportKind(directoryKind);
                            setImportFile(null);
                            setImportError("");
                          }}
                        >
                          <Upload className="size-4" />
                          {directoryKind === "plugin"
                            ? copy("上传插件包", "Upload plugin package")
                            : copy("上传技能包", "Upload skill package")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </header>
                {props.loading && !catalog ? (
                  <div
                    className="za-extension-directory"
                    role="status"
                    aria-label={copy("正在加载", "Loading")}
                  >
                    <ExtensionSkeleton />
                    <ExtensionSkeleton />
                    <ExtensionSkeleton />
                    <ExtensionSkeleton />
                  </div>
                ) : (
                  <Tabs
                    value={source}
                    onValueChange={(value) => {
                      if (value === "public" || value === "personal") {
                        updateDirectoryBrowse(directoryKind, { source: value });
                      }
                    }}
                  >
                    <div className="za-extension-filters">
                      <TabsList
                        variant="plain"
                        activateOnFocus
                        aria-label={copy("内容来源", "Source")}
                        className="za-extension-source-tabs"
                      >
                        {sourceOptions.map(([value, label]) => (
                          <TabsTrigger key={value} value={value} variant="plain">
                            {label}
                          </TabsTrigger>
                        ))}
                      </TabsList>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              ref={installationFilter}
                              variant="ghost"
                              size="sm"
                              className="rounded-full"
                              aria-label={copy("安装状态", "Installation status")}
                              aria-describedby={installationValueId}
                            />
                          }
                        >
                          <span id={installationValueId}>
                            {installation === "all"
                              ? copy("全部", "All")
                              : installation === "installed"
                                ? installedLabel
                                : uninstalledLabel}
                          </span>
                          <ChevronDown className="size-3" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuRadioGroup
                            value={installation}
                            onValueChange={(value) => {
                              if (
                                value === "all" ||
                                value === "installed" ||
                                value === "uninstalled"
                              ) {
                                updateDirectoryBrowse(directoryKind, { installation: value });
                              }
                            }}
                          >
                            <DropdownMenuRadioItem value="all" closeOnClick>
                              {copy("全部", "All")}
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="installed" closeOnClick>
                              {installedLabel}
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="uninstalled" closeOnClick>
                              {uninstalledLabel}
                            </DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {sourceOptions.map(([value]) => (
                      <TabsContent key={value} value={value} keepMounted>
                        {source === value && (
                          <>
                            {directorySections.map((section) => (
                              <section className="za-extension-directory-section" key={section.id}>
                                <h2 className="za-extension-section-label">{section.label}</h2>
                                <ul
                                  className="za-extension-directory"
                                  aria-label={
                                    directoryKind === "plugin"
                                      ? copy("插件目录", "Plugin directory")
                                      : copy(`${section.label}技能`, `${section.label} skills`)
                                  }
                                >
                                  {section.items.map((item) => (
                                    <ExtensionDirectoryItem
                                      key={item.id}
                                      item={item}
                                      onOpen={(event) => {
                                        if (item.kind === "skill") {
                                          openReader(
                                            { pkg: item, skill: item.skills[0] },
                                            event.currentTarget,
                                          );
                                          return;
                                        }
                                        directoryFocusReturn.current = {
                                          kind: item.kind,
                                          id: item.id,
                                        };
                                        navigate({ page: "plugin", id: item.id });
                                      }}
                                    >
                                      {item.installed ? (
                                        <>
                                          <span className="za-extension-row-state">
                                            {extensionManagementEnabled(item)
                                              ? installedLabel
                                              : copy("已停用", "Disabled")}
                                          </span>
                                          {actionMenu(
                                            item,
                                            item.kind === "skill" ? item.skills[0] : undefined,
                                          )}
                                        </>
                                      ) : (
                                        <>
                                          <Button
                                            variant="ghost"
                                            size="icon"
                                            className="aria-disabled:opacity-50"
                                            aria-label={`${installLabel} ${extensionDisplayName(item, locale)}`}
                                            title={`${installLabel} ${extensionDisplayName(item, locale)}`}
                                            aria-disabled={writeBlocked || undefined}
                                            aria-busy={
                                              installingDirectoryItem === item.id || undefined
                                            }
                                            onBlur={(event) => {
                                              if (
                                                event.relatedTarget &&
                                                directoryInstallFocus.current?.button ===
                                                  event.currentTarget
                                              )
                                                directoryInstallFocus.current = null;
                                            }}
                                            onClick={(event) =>
                                              void installFromDirectory(item, event)
                                            }
                                          >
                                            {installingDirectoryItem === item.id ? (
                                              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                                            ) : (
                                              <Plus className="size-4" />
                                            )}
                                          </Button>
                                          {extensionOwned(item) &&
                                            actionMenu(
                                              item,
                                              item.kind === "skill" ? item.skills[0] : undefined,
                                            )}
                                        </>
                                      )}
                                    </ExtensionDirectoryItem>
                                  ))}
                                </ul>
                              </section>
                            ))}
                            {!filtered.length && !props.error && (
                              <Empty
                                text={
                                  normalizedQuery
                                    ? searchEmptyMessage
                                    : !packages.some(
                                          (item) =>
                                            item.kind === directoryKind &&
                                            item.visibility === source,
                                        )
                                      ? source === "personal"
                                        ? copy(
                                            "还没有个人内容，可通过聊天创建或上传。",
                                            "Create or upload your first personal extension.",
                                          )
                                        : copy(
                                            `暂无公开${directoryLabel}`,
                                            `No public ${directoryLabel.toLowerCase()}`,
                                          )
                                      : installation === "uninstalled"
                                        ? copy(
                                            `没有未安装的${directoryLabel}`,
                                            `All ${directoryLabel.toLowerCase()} are installed`,
                                          )
                                        : installation === "installed"
                                          ? copy(
                                              `没有已安装的${directoryLabel}`,
                                              `No installed ${directoryLabel.toLowerCase()}`,
                                            )
                                          : copy(
                                              "没有符合筛选的内容",
                                              "Nothing matches the filters",
                                            )
                                }
                              >
                                {searchRecovery && (
                                  <Button
                                    variant="outline"
                                    className="h-auto min-h-11 max-w-full whitespace-normal rounded-full text-center"
                                    onClick={(event) => {
                                      searchRecoveryFocus.current = event.currentTarget;
                                      updateDirectoryBrowse(directoryKind, searchRecovery);
                                    }}
                                  >
                                    {searchRecovery.source === source
                                      ? copy("查看全部安装状态", "Show all installation statuses")
                                      : searchRecovery.installation !== installation
                                        ? copy(
                                            `查看${recoverySourceLabel} · 全部状态`,
                                            `View ${recoverySourceLabel} · All statuses`,
                                          )
                                        : copy(
                                            `查看${recoverySourceLabel}`,
                                            `View ${recoverySourceLabel}`,
                                          )}
                                  </Button>
                                )}
                              </Empty>
                            )}
                          </>
                        )}
                      </TabsContent>
                    ))}
                  </Tabs>
                )}
              </>
            ) : pkg ? (
              <>
                <header className="za-extension-detail-header">
                  <div className="za-extension-detail-identity">
                    <ExtensionMark id={pkg.id} />
                    <div>
                      <h1 ref={heading} tabIndex={-1} className="outline-none">
                        {extensionDisplayName(pkg, locale)}
                      </h1>
                      <p>
                        {pkg.publisher} ·{" "}
                        {pkg.visibility === "public"
                          ? copy("公开", "Public")
                          : copy("个人", "Personal")}
                      </p>
                    </div>
                  </div>
                  <div className="za-extension-detail-actions">
                    {pkg.installed ? (
                      <>
                        <Button
                          variant="outline"
                          className="rounded-full"
                          aria-describedby={trialStatus ? trialStatusId : undefined}
                          onClick={() =>
                            navigate({
                              page: route.page === "manage" ? "plugin" : "manage",
                              id: pkg.id,
                            })
                          }
                        >
                          <Settings className="size-4" />
                          {route.page === "manage" ? copy("详情", "Details") : manageLabel}
                        </Button>
                        {!originalReader && (
                          <Button
                            className="rounded-full"
                            disabled={!canTryPackage || busy}
                            onClick={() => tryInChat(pkg, pkg.skills[0])}
                          >
                            <SquarePen className="size-4" />
                            {copy("在聊天中试用", "Try in chat")}
                          </Button>
                        )}
                      </>
                    ) : (
                      <Button
                        variant={originalReader ? "outline" : "default"}
                        className="rounded-full aria-disabled:opacity-50"
                        disabled={!originalReader && writeBlocked}
                        aria-disabled={originalReader && writeBlocked ? true : undefined}
                        onBlur={(event) => {
                          if (
                            event.relatedTarget &&
                            readerReinstallFocus.current === event.currentTarget
                          )
                            readerReinstallFocus.current = null;
                        }}
                        onClick={(event) => {
                          if (writeBlocked || mutationLock.current) return;
                          const opener = event.currentTarget;
                          if (originalReader && opener.ownerDocument.activeElement === opener) {
                            readerReinstallFocus.current = opener;
                          }
                          void mutate({ action: "install", id: pkg.id }).then((saved) => {
                            if (!saved && readerReinstallFocus.current === opener) {
                              readerReinstallFocus.current = null;
                            }
                          });
                        }}
                      >
                        {installLabel}
                      </Button>
                    )}
                    {backToOriginalSkill}
                  </div>
                </header>
                {trialStatus && (
                  <StatusNotice
                    id={trialStatusId}
                    data-extension-trial-status=""
                    className="my-4"
                    tone="warning"
                    message={trialStatus}
                  />
                )}
                {tryNotice}
                {route.page === "plugin" &&
                  (packageExamples.length > 0 || !usesExtensionPackagePresentation(pkg)) && (
                    <>
                      <h2 className="sr-only">{copy("从这里开始", "Start here")}</h2>
                      <div className="za-extension-starters">
                        {(packageExamples.length
                          ? packageExamples
                          : [
                              copy(
                                "使用这个技能帮我完成工作",
                                "Use this skill to help with my work",
                              ),
                            ]
                        ).map((example) => (
                          <button
                            type="button"
                            key={example}
                            disabled={!canTryPackage}
                            onClick={() => tryInChat(pkg, pkg.skills[0], example)}
                          >
                            <ExtensionMark id={pkg.id} small />
                            <strong>{extensionDisplayName(pkg, locale)}</strong>
                            <span>{example}</span>
                            <ChevronRight className="size-4 shrink-0" />
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                <p className="za-extension-intro">
                  {route.page === "plugin" || pkg.overview
                    ? extensionOverview(pkg, locale)
                    : extensionDescription(pkg, locale)}
                </p>
                <div className="za-extension-management">
                  {route.page === "plugin" &&
                    (pluginEditorAvailable || !!pkg.unavailable_apps?.length) && (
                      <section className="za-extension-apps" aria-labelledby={appsHeadingId}>
                        <h2 id={appsHeadingId} className="za-extension-section-label">
                          {copy("应用", "Apps")}{" "}
                          <span className="za-extension-section-count">
                            {Number(pluginEditorAvailable) + (pkg.unavailable_apps?.length ?? 0)}
                          </span>
                        </h2>
                        {pkg.unavailable_apps?.map((app) => (
                          <div
                            className="za-extension-setting-row za-extension-app-row"
                            key={app.name}
                          >
                            <ExtensionAppRow
                              app={{ ...app, packageId: pkg.id }}
                              status={locale === "en-US" ? "Not connected" : "托管应用未连接"}
                              onOpen={setSelectedApp}
                            />
                          </div>
                        ))}
                        {pluginEditorAvailable && (
                          <div className="za-extension-setting-row za-extension-app-row">
                            <ExtensionAppRow
                              app={{ ...pluginEditorApp, packageId: pkg.id, local: true }}
                              onOpen={setSelectedApp}
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              className="shrink-0 rounded-full"
                              disabled={!pkg.installed || !pkg.enabled || writeBlocked}
                              onClick={() =>
                                navigate({ page: "editor", kind: "plugin", returnTo: pkg.id })
                              }
                            >
                              {locale === "en-US" ? "Open" : "打开"}
                            </Button>
                          </div>
                        )}
                      </section>
                    )}
                  {route.page === "manage" && (
                    <div className="za-extension-setting-row">
                      <div>
                        <h2>{copy("在对话中使用", "Use in chat")}</h2>
                        <p>
                          {copy(
                            "启用后，ZeroAgent 可以按任务需要读取技能指令。",
                            "Allow ZeroAgent to read skill instructions when the task needs them.",
                          )}
                        </p>
                      </div>
                      <Switch
                        aria-label={copy(
                          `启用${pkg.kind === "plugin" ? "插件" : "技能"} ${extensionDisplayName(pkg, locale)}`,
                          `Enable ${pkg.kind === "plugin" ? "plugin" : "skill"} ${extensionDisplayName(pkg, locale)}`,
                        )}
                        checked={extensionManagementEnabled(pkg)}
                        disabled={!pkg.installed || writeBlocked}
                        onCheckedChange={(enabled) =>
                          void mutate({ action: "enable", id: pkg.id, enabled })
                        }
                      />
                    </div>
                  )}
                  <section className="za-extension-skills" aria-label={skillsLabel}>
                    <h2 className="za-extension-section-label">
                      {pkg.kind === "plugin" ? (
                        <>
                          {skillsLabel}{" "}
                          <span className="za-extension-section-count">{pkg.skills.length}</span>
                        </>
                      ) : (
                        copy("技能指令", "Skill instructions")
                      )}
                    </h2>
                    {(route.page === "manage" || expandedSkills
                      ? pkg.skills
                      : pkg.skills.slice(0, 5)
                    ).map((skill) => (
                      <div
                        className="za-extension-setting-row za-extension-skill-row"
                        key={skill.name}
                      >
                        <button
                          className="za-extension-skill-link"
                          type="button"
                          onClick={(event) => openReader({ pkg, skill }, event.currentTarget)}
                        >
                          <ExtensionMark id={pkg.id} small />
                          <span>
                            <strong title={skill.name}>
                              {extensionSkillDisplayName(pkg, skill, locale)}
                            </strong>
                            <span>{extensionSkillDescription(pkg, skill, locale)}</span>
                          </span>
                        </button>
                        {route.page === "manage" && pkg.kind === "plugin" ? (
                          <Switch
                            aria-label={copy(
                              `启用技能 ${extensionSkillDisplayName(pkg, skill, locale)}`,
                              `Enable skill ${extensionSkillDisplayName(pkg, skill, locale)}`,
                            )}
                            checked={extensionSkillEnabled(pkg, skill)}
                            disabled={!pkg.installed || !pkg.enabled || writeBlocked}
                            onCheckedChange={(enabled) =>
                              void mutate({
                                action: "skill",
                                id: pkg.id,
                                skill: skill.name,
                                enabled,
                              })
                            }
                          />
                        ) : (
                          <ChevronRight className="size-4 text-muted-foreground" />
                        )}
                      </div>
                    ))}
                    {route.page === "plugin" && pkg.skills.length > 5 && (
                      <Button
                        variant="ghost"
                        className="za-extension-show-skills"
                        aria-expanded={expandedSkills}
                        onClick={() => setExpandedSkills(!expandedSkills)}
                      >
                        <ChevronDown className={expandedSkills ? "size-4 rotate-180" : "size-4"} />
                        {expandedSkills
                          ? copy("收起技能", "Show fewer skills")
                          : copy(
                              `查看其余 ${pkg.skills.length - 5} 项技能`,
                              `Show ${pkg.skills.length - 5} more`,
                            )}
                      </Button>
                    )}
                  </section>
                  {pkg.id === "imagegen" && props.onConfigureImages && (
                    <div className="za-extension-setting-row">
                      <div>
                        <h2>{copy("默认生图模型", "Default image model")}</h2>
                        <p>
                          {copy(
                            "使用设置中已配置的生图模型。",
                            "Uses the image model selected in settings.",
                          )}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        className="rounded-full"
                        data-extension-configure-images=""
                        onClick={props.onConfigureImages}
                      >
                        {copy("配置模型", "Configure model")}
                      </Button>
                    </div>
                  )}
                  {extensionOwned(pkg) && (
                    <div className="za-extension-setting-row">
                      <div>
                        <h2>
                          {pkg.kind === "plugin"
                            ? copy("插件文件", "Plugin files")
                            : copy("技能文件", "Skill files")}
                        </h2>
                        <p>
                          {copy(
                            "查看完整指令，或下载一份副本。",
                            "View the full instructions or download a copy.",
                          )}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        className="rounded-full"
                        onClick={() => void download(pkg)}
                      >
                        <Download className="size-4" />
                        {copy("下载", "Download")}
                      </Button>
                    </div>
                  )}
                  {extensionOwned(pkg) && (
                    <div className="za-extension-setting-row">
                      <div>
                        <h2>
                          {pkg.kind === "plugin"
                            ? copy("编辑插件", "Edit plugin")
                            : copy("编辑技能", "Edit skill")}
                        </h2>
                        <p>
                          {copy(
                            "修改说明和指令，保存后用于之后的工作。",
                            "Update the description and instructions for future use.",
                          )}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        className="rounded-full"
                        onClick={() => navigate({ page: "editor", id: pkg.id, kind: pkg.kind })}
                      >
                        {copy("编辑", "Edit")}
                      </Button>
                    </div>
                  )}
                  {route.page === "manage" && pkg.installed && (
                    <div className="za-extension-setting-row">
                      <div>
                        <h2>{uninstallLabel}</h2>
                        <p>
                          {copy(
                            "保留已有对话和工作成果。",
                            "Existing conversations and work are kept.",
                          )}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        className="rounded-full text-destructive"
                        onClick={() => openUninstall(pkg)}
                      >
                        {uninstallLabel}
                      </Button>
                    </div>
                  )}
                  {route.page === "plugin" && (
                    <section className="za-extension-info">
                      <h2 className="za-extension-section-label">{copy("信息", "Information")}</h2>
                      <dl>
                        <dt>{copy("发布者", "Publisher")}</dt>
                        <dd>{pkg.publisher}</dd>
                        <dt>{copy("类型", "Type")}</dt>
                        <dd>
                          {pkg.kind === "plugin"
                            ? copy("插件", "Plugin")
                            : copy("独立技能", "Standalone skill")}
                        </dd>
                        <dt>{copy("来源", "Source")}</dt>
                        <dd>
                          {pkg.visibility === "public"
                            ? copy("公开目录", "Public directory")
                            : copy("个人内容", "Personal content")}
                        </dd>
                      </dl>
                    </section>
                  )}
                </div>
              </>
            ) : (
              <Empty text={copy("这个插件已不可用", "This plugin is unavailable.")}>
                {backToOriginalSkill}
                <Button variant="ghost" onClick={() => navigate({ page: "plugins" })}>
                  {copy("返回目录", "Back to directory")}
                </Button>
              </Empty>
            )}
            {!remove && (error || props.error || adapter.writeUnconfirmed) && (
              <div className="za-extension-feedback" role="alert">
                <span>
                  {error ||
                    props.error ||
                    copy(
                      "上次操作结果尚未确认，请刷新目录核对后再继续。",
                      "The last action is unconfirmed. Refresh the directory to check its status.",
                    )}
                </span>
                <Button variant="ghost" size="sm" onClick={props.onRefresh}>
                  {copy("刷新目录", "Refresh directory")}
                </Button>
              </div>
            )}
            {notice && (
              <p role="status" className="za-extension-saved">
                <Check className="size-3" />
                {notice}
              </p>
            )}
          </ScrollArea>
        )}
      </div>
      <input
        type="file"
        ref={upload}
        accept=".zip,application/zip"
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (files.length) selectImportFiles(files);
        }}
      />
      <ExtensionImportDialog
        kind={importKind}
        file={importFile}
        error={importError}
        busy={busy}
        blocked={writeBlocked}
        uncertain={!!adapter.writeUnconfirmed}
        refreshing={props.loading}
        onReconcile={props.onRefresh}
        onChoose={() => upload.current?.click()}
        onFiles={selectImportFiles}
        onConfirm={() => void confirmImport()}
        onClose={() => {
          setImportKind(null);
        }}
      />
      {busy && (
        <span className="sr-only" role="status">
          {copy("正在保存", "Saving")}
        </span>
      )}
      {reader && !readerTarget && (
        <Dialog open onOpenChange={(open) => !open && closeReader()}>
          <DialogContent
            className="max-w-sm p-6"
            showCloseButton
            closeLabel={copy("关闭技能详情", "Close skill details")}
          >
            <DialogTitle>
              {props.loading || (!catalog && !props.error)
                ? copy("正在读取技能信息", "Loading skill information")
                : props.error
                  ? copy("暂时无法读取技能信息", "Could not load skill information")
                  : copy("技能不可用", "Skill unavailable")}
            </DialogTitle>
            <DialogDescription className="mt-2">
              {props.loading || (!catalog && !props.error)
                ? copy("正在核对目录中的技能。", "Checking the skill in your directory.")
                : props.error
                  ? copy(
                      "请重试目录，读取此技能的信息。",
                      "Retry the directory to look up this skill.",
                    )
                  : copy(
                      "此技能已移除，或当前账户没有访问权限。",
                      "This skill was removed or your account does not have access.",
                    )}
            </DialogDescription>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button variant="ghost" onClick={closeReader}>
                {reader.returnToChat ? backLabel : copy("返回目录", "Back to directory")}
              </Button>
              {props.error ? (
                <Button disabled={props.loading} onClick={props.onRefresh}>
                  {copy("重试目录", "Retry directory")}
                </Button>
              ) : null}
            </div>
          </DialogContent>
        </Dialog>
      )}
      {readerTarget && (
        <SkillReader
          key={`${adapter.scope}:${readerTarget.id}:${readerTarget.revision ?? ""}:${readerTarget.skillName ?? ""}`}
          adapter={adapter}
          target={readerTarget}
          pkg={readerPackage ?? selectedPackage ?? undefined}
          skill={selected?.skill}
          catalog={catalog}
          directoryLoading={props.loading}
          directoryError={Boolean(props.error)}
          busy={busy}
          onInstall={(onFailure) =>
            mutate({ action: "install", id: readerTarget.id }, undefined, onFailure)
          }
          onClose={closeReader}
          onRefreshDirectory={props.onRefresh}
          onManage={() => {
            if (!props.onNavigate) setLocalSelection(null);
            navigate({ page: "manage", id: readerTarget.id }, false, {
              packageId: readerTarget.id,
              location: { route, reader },
              selection: selected,
            });
          }}
          onConfigureImages={props.onConfigureImages}
          onTryOnDevice={props.onTryOnDevice}
          onReturnToDraft={() => {
            setSelected(null);
            returnToDraft();
          }}
          onTry={() => {
            if (!selected) return "skill-unavailable";
            const result = props.onTry(selectedPackage ?? selected.pkg, selected.skill);
            if (result === "accepted") setSelected(null);
            return result;
          }}
        />
      )}
      {selectedApp && (
        <Dialog open onOpenChange={(open) => !open && setSelectedApp(null)}>
          <DialogContent className="w-[calc(100%-2rem)] max-w-md p-6">
            <ExtensionMark id={selectedApp.packageId} />
            <DialogTitle className="mt-3">{selectedApp.name}</DialogTitle>
            <DialogDescription className="mt-2">{selectedApp.description}</DialogDescription>
            {!selectedApp.local && (
              <p className="mt-4 text-sm text-muted-foreground">
                {locale === "en-US" ? "This hosted app is not connected." : "托管应用未连接。"}
              </p>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setSelectedApp(null)}>
                {locale === "en-US" ? "Close" : "关闭"}
              </Button>
              {selectedApp.local && (
                <Button
                  disabled={!pkg?.installed || !pkg.enabled || writeBlocked}
                  onClick={() => {
                    setSelectedApp(null);
                    navigate({ page: "editor", kind: "plugin", returnTo: selectedApp.packageId });
                  }}
                >
                  {locale === "en-US" ? "Open" : "打开"}
                </Button>
              )}
            </div>
          </DialogContent>
        </Dialog>
      )}
      <Dialog
        open={!!pendingRoute}
        onOpenChange={(open) => {
          if (!open) setPendingRoute(null);
        }}
      >
        <DialogContent className="p-6">
          <DialogTitle>保留技能草稿？</DialogTitle>
          <DialogDescription className="mt-3 text-muted-foreground">
            当前修改尚未保存。离开后再次打开编辑器，可以继续编辑这份草稿。
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setPendingRoute(null)}>
              继续编辑
            </Button>
            <Button
              onClick={() => {
                if (pendingRoute) {
                  navigate(pendingRoute.route, true);
                  if (!props.onNavigate) setSelected(pendingRoute.reader ?? null);
                }
                setPendingRoute(null);
              }}
            >
              保留草稿并离开
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!remove}
        onOpenChange={(open) => {
          if (!open && !busy) setRemove(null);
        }}
      >
        <DialogContent className="p-6">
          <DialogTitle>
            {removalConfirmed
              ? copy(`已卸载 ${removalName}`, `${removalName} uninstalled`)
              : `${uninstallLabel} ${removalName}${copy("？", "?")}`}
          </DialogTitle>
          {!removalConfirmed && (
            <DialogDescription className="mt-3 text-muted-foreground">
              {copy(
                "卸载后将不再用于新的对话。已有聊天和成果会保留。",
                "Uninstalling removes access in new chats. Existing chats and results are kept.",
              )}
            </DialogDescription>
          )}
          {removalMessage && (
            <StatusNotice
              id={removalStatusId}
              className="mt-4"
              compact
              tone={removalTone}
              busy={removalNeedsCheck && props.loading}
              message={removalMessage}
            />
          )}
          <div className="mt-6 flex flex-wrap justify-end gap-2">
            {!removalConfirmed && (
              <Button variant="ghost" disabled={busy} onClick={() => setRemove(null)}>
                {copy("取消", "Cancel")}
              </Button>
            )}
            <Button
              variant={removalNeedsCheck || removalConfirmed ? "default" : "destructive"}
              aria-disabled={removalActionDisabled || undefined}
              aria-busy={busy || (removalNeedsCheck && props.loading) || undefined}
              aria-describedby={removalMessage ? removalStatusId : undefined}
              className="min-h-11 aria-disabled:opacity-50"
              onClick={() => {
                if (!remove || removalActionDisabled) return;
                if (removalConfirmed) setRemove(null);
                else if (removalNeedsCheck) props.onRefresh();
                else
                  void mutate({ action: "uninstall", id: remove.id }).then((saved) => {
                    if (saved) setRemove(null);
                  });
              }}
            >
              {removalNeedsCheck
                ? props.loading
                  ? copy("正在核对…", "Checking…")
                  : copy("刷新目录核对", "Refresh directory to check")
                : removalConfirmed
                  ? copy("完成", "Done")
                  : busy
                    ? copy("正在卸载…", "Uninstalling…")
                    : uninstallLabel}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
function Empty({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="za-extension-empty">
      <Box className="size-7 text-muted-foreground/50" />
      <p className="text-center">{text}</p>
      {children}
    </div>
  );
}
function ExtensionSkeleton() {
  return (
    <div className="za-extension-row animate-pulse motion-reduce:animate-none">
      <span className="size-8 rounded-lg bg-muted" />
      <span className="flex-1 space-y-2">
        <span className="block h-3 w-28 rounded bg-muted" />
        <span className="block h-2 w-4/5 rounded bg-muted" />
      </span>
    </div>
  );
}
function ExtensionAppRow({
  app,
  status,
  onOpen,
}: {
  app: AppSelection;
  status?: string;
  onOpen: (app: AppSelection) => void;
}) {
  return (
    <button
      className="za-extension-skill-link"
      type="button"
      aria-haspopup="dialog"
      onClick={() => onOpen(app)}
    >
      <ExtensionMark id={app.packageId} />
      <span className="za-extension-link-copy">
        <strong>{app.name}</strong>
        <span>{app.description}</span>
      </span>
      {status && <small className="shrink-0 text-muted-foreground">{status}</small>}
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

type SkillFileView = {
  path: string;
  scrollTop: number;
  origin?: { target: string; index: number };
};

function SkillReader({
  adapter,
  target,
  pkg,
  skill,
  catalog,
  directoryLoading,
  directoryError,
  onClose,
  onRefreshDirectory,
  onManage,
  onTry,
  onInstall,
  busy,
  onConfigureImages,
  onTryOnDevice,
  onReturnToDraft,
}: {
  adapter: ExtensionsAdapter;
  target: SkillReaderTarget;
  pkg?: ExtensionPackage;
  skill?: ExtensionSkill;
  catalog: ExtensionCatalog | null;
  directoryLoading: boolean;
  directoryError: boolean;
  onClose: () => void;
  onRefreshDirectory: () => void;
  onManage: () => void;
  onTry: () => ExtensionTryResult;
  onInstall: (onFailure: (message: string) => void) => Promise<boolean>;
  busy: boolean;
  onConfigureImages?: () => void;
  onTryOnDevice?: DeviceSkillAction;
  onReturnToDraft: () => void;
}) {
  const { locale } = useLocale();
  const english = locale === "en-US";
  const [revision, setRevision] = useState<ExtensionRevision | null>(null),
    [selectedFile, setFile] = useState<string | null>(null),
    [source, setSource] = useState(false),
    [requestError, setError] = useState<"changed" | "failed" | "unavailable" | null>(null),
    [retry, setRetry] = useState(0);
  const [fileHistory, setFileHistory] = useState<SkillFileView[]>([]);
  const fileTitleRef = useRef<HTMLSpanElement>(null);
  const fileViewportRef = useRef<HTMLDivElement>(null);
  const pendingFileView = useRef<SkillFileView | null>(null);
  const { id, revision: pinnedRevision, skillName } = target;
  const requestedRevision = pinnedRevision ?? pkg?.version;
  const [devicePending, setDevicePending] = useState(false);
  const [deviceError, setDeviceError] = useState("");
  const [tryError, setTryError] = useState<Exclude<ExtensionTryResult, "accepted"> | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installFailure, setInstallFailure] = useState<
    { kind: "failed"; message: string } | { kind: "unconfirmed"; previous: ExtensionCatalog } | null
  >(null);
  const installStatusId = useId();
  const catalogAvailable = Boolean(catalog && !directoryError);
  const writeBlocked = busy || !!adapter.writeUnconfirmed || directoryLoading;
  const actionError = deviceError || (tryError ? extensionTryError(tryError, locale) : "");
  const deviceRequest = useRef<AbortController | null>(null);
  useEffect(() => () => deviceRequest.current?.abort(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly re-reads the same selection.
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setRevision(null);
    void adapter
      .read(id, controller.signal, pinnedRevision)
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.revision.number === requestedRevision) setRevision(result.revision);
        else setError("changed");
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof ExtensionRevisionUnavailable ? "unavailable" : "failed");
      });
    return () => controller.abort();
  }, [adapter, id, pinnedRevision, requestedRevision, retry]);
  const aliases = revision?.aliases;
  const canonicalSkillName =
    skillName && aliases && Object.hasOwn(aliases, skillName) ? aliases[skillName] : skillName;
  const loadedSkill = canonicalSkillName
    ? revision?.skills.find((item) => item.name === canonicalSkillName)
    : revision?.skills.length === 1
      ? revision.skills[0]
      : undefined;
  const selectedSkill =
    loadedSkill ?? (pinnedRevision && pinnedRevision !== pkg?.version ? undefined : skill);
  const skillDisabled = pkg?.kind === "plugin" && pkg.disabled_skills?.some(
    (name) => name === skillName || name === selectedSkill?.name,
  );
  const disabledReason =
    catalogAvailable && pkg?.installed && (!pkg.enabled || skillDisabled)
      ? !pkg.enabled && pkg.kind === "plugin"
        ? english
          ? "This plugin is disabled."
          : "此插件已停用。"
        : english
          ? "This skill is disabled."
          : "此技能已停用。"
      : "";
  const pinnedUninstalled =
    catalogAvailable && pkg && !pkg.installed && pinnedRevision !== undefined;
  const managementReason =
    pinnedUninstalled && loadedSkill
      ? pkg.kind === "plugin"
        ? english
          ? "This plugin is not installed. You can reinstall it in Manage."
          : "此插件未安装，可以在管理页重新安装。"
        : english
          ? "This skill is not installed. You can reinstall it in Manage."
          : "此技能未安装，可以在管理页重新安装。"
      : disabledReason;
  const unavailable = requestError === "unavailable" || Boolean(revision && !loadedSkill);
  const refreshDirectory = requestError === "changed" && pinnedRevision === undefined;
  const error = unavailable
    ? english
      ? "This skill revision is unavailable or your account cannot access it."
      : "此技能修订已不可用，或当前账户无权访问。"
    : requestError === "changed"
      ? refreshDirectory
        ? english
          ? "This skill changed. Refresh the directory to view the current skill."
          : "技能已更新，请刷新目录后查看。"
        : english
          ? "The response did not match the requested revision. Try again."
          : "返回内容与请求的修订不符，请重试。"
      : requestError === "failed"
        ? english
          ? "Unable to load the skill. Try again."
          : "暂时无法加载技能，请重试。"
        : "";
  const installNeedsCheck =
    pkg?.kind === "skill" &&
    pinnedRevision === undefined &&
    ((!pkg.installed && !!adapter.writeUnconfirmed) ||
      (installFailure?.kind === "unconfirmed" &&
        (!catalogAvailable || catalog === installFailure.previous || writeBlocked)));
  const primaryActionDisabled = installNeedsCheck
    ? busy || directoryLoading
    : writeBlocked ||
      devicePending ||
      installing ||
      !revision ||
      !!error ||
      Boolean(pkg?.installed && (!loadedSkill || !pkg.enabled || skillDisabled));
  const installingLabel = installNeedsCheck
    ? directoryLoading
      ? english
        ? "Checking…"
        : "正在核对…"
      : english
        ? "Check installation"
        : "核对安装状态"
    : installing
      ? english
        ? "Installing…"
        : "正在安装…"
      : "";
  let installStatus = installFailure?.kind === "failed" ? installFailure.message : "";
  if (installNeedsCheck) {
    installStatus = directoryLoading
      ? english
        ? "Checking the directory for this skill…"
        : "正在从目录核对此技能的安装状态…"
      : directoryError
        ? english
          ? "Couldn't check installation. Try again."
          : "暂时无法核对安装状态，请重试。"
        : installFailure?.kind === "unconfirmed"
          ? english
            ? "The installation result is unconfirmed. Check its status before installing again."
            : "安装结果尚未确认。请核对安装状态后再继续。"
          : english
            ? "Check the directory before installing this skill."
            : "请先核对目录，再安装此技能。";
  } else if (installFailure?.kind === "unconfirmed") {
    installStatus = pkg?.installed
      ? english
        ? "The directory confirms this skill is installed."
        : "目录确认此技能已安装。"
      : english
        ? "The directory shows this skill is still uninstalled. You can install it again."
        : "目录显示此技能仍未安装，可以再次安装。";
  }
  async function installSkill() {
    if (!catalog) return;
    setInstalling(true);
    setInstallFailure(null);
    try {
      await onInstall((message) =>
        setInstallFailure(
          adapter.writeUnconfirmed
            ? { kind: "unconfirmed", previous: catalog }
            : { kind: "failed", message },
        ),
      );
    } finally {
      setInstalling(false);
    }
  }
  const entry = selectedSkill?.entry ?? "";
  const showFileTree = Boolean(loadedSkill && entry && !error);
  const supportingFiles = useMemo(() => {
    if (!revision || !loadedSkill) return [];
    const siblingEntries = new Set(
      revision.skills.filter((skill) => skill.entry !== entry).map((skill) => skill.entry),
    );
    return Object.keys(revision.files)
      .filter((path) => path !== entry && !siblingEntries.has(path))
      .sort();
  }, [entry, loadedSkill, revision]);
  const readableFiles = useMemo(
    () => new Set([entry, ...supportingFiles]),
    [entry, supportingFiles],
  );
  const file = selectedFile && readableFiles.has(selectedFile) ? selectedFile : entry;
  const isEntry = file === entry;
  const displaySkillName = selectedSkill?.name ?? skillName ?? "";
  const builtinCopy = pkg ? undefined : builtinSkillPresentation(id, displaySkillName, locale);
  const title =
    pkg && selectedSkill
      ? pkg.kind === "skill" && requestedRevision === pkg.version
        ? extensionDisplayName(pkg, locale)
        : extensionSkillDisplayName(pkg, selectedSkill, locale)
      : builtinCopy?.title ||
        selectedSkill?.display_name ||
        selectedSkill?.name ||
        skillName ||
        (english ? "Skill details" : "技能详情");
  const publishedAt = new Date(revision?.created_at || pkg?.updated_at || "");
  const hasDate = Number.isFinite(publishedAt.getTime()) && publishedAt.getUTCFullYear() >= 1970;
  const body = revision?.files[file] ?? "";
  const isMarkdown = /\.md$/i.test(file);
  const markdown = body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)(?:\r?\n)*/, "");
  const firstLineEnd = markdown.indexOf("\n");
  const heading = firstLineEnd === -1 ? markdown : markdown.slice(0, firstLineEnd).trimEnd();
  const sourceTitle =
    pkg && selectedSkill
      ? extensionSkillDisplayName(pkg, selectedSkill, "en-US")
      : (builtinSkillPresentation(id, displaySkillName, "en-US")?.title ?? title);
  const displayMarkdown =
    isEntry && (heading === `# ${title}` || heading === `# ${sourceTitle}`)
      ? markdown.slice(firstLineEnd === -1 ? markdown.length : firstLineEnd + 1)
      : markdown;
  const openFile = (path: string) => {
    setFileHistory([]);
    setFile(path);
    setSource(false);
  };
  const followFile = useCallback(
    (path: string, opener: HTMLButtonElement) => {
      const viewport = fileViewportRef.current;
      const index = skillReaderFileLinks(viewport, path).indexOf(opener);
      const previous = {
        path: file,
        scrollTop: viewport?.scrollTop ?? 0,
        origin: index >= 0 ? { target: path, index } : undefined,
      };
      setFileHistory((current) => [...current.slice(-31), previous]);
      pendingFileView.current = { path, scrollTop: 0 };
      setFile(path);
      setSource(false);
    },
    [file],
  );
  const previousFile = fileHistory.at(-1);
  const backFile = previousFile && readableFiles.has(previousFile.path) ? previousFile.path : entry;
  const backToEntry = backFile === entry;
  const backLabel = backToEntry
    ? english
      ? "Back to skill instructions"
      : "返回技能正文"
    : english
      ? "Back to previous file"
      : "返回上一个文件";
  const goBackToFile = () => {
    setFileHistory((current) => current.slice(0, -1));
    pendingFileView.current =
      previousFile?.path === backFile ? previousFile : { path: backFile, scrollTop: 0 };
    setFile(backFile);
    setSource(false);
  };
  useLayoutEffect(() => {
    const view = pendingFileView.current;
    if (view?.path !== file) return;
    pendingFileView.current = null;
    const viewport = fileViewportRef.current;
    if (viewport) viewport.scrollTop = view.scrollTop;
    const opener = view.origin
      ? skillReaderFileLinks(viewport, view.origin.target)[view.origin.index]
      : undefined;
    (opener ?? fileTitleRef.current)?.focus({ preventScroll: true });
  }, [file]);
  async function prepareForDevice() {
    if (!onTryOnDevice || !pkg || !loadedSkill || !requestedRevision || deviceRequest.current)
      return;
    const controller = new AbortController();
    deviceRequest.current = controller;
    setDevicePending(true);
    setDeviceError("");
    setTryError(null);
    try {
      await onTryOnDevice(
        pkg,
        { ...loadedSkill, name: skillName ?? loadedSkill.name },
        requestedRevision,
        controller.signal,
      );
    } catch (cause) {
      if (!controller.signal.aborted) {
        setDeviceError(
          cause instanceof Error
            ? cause.message
            : locale === "en-US"
              ? "The skill could not be checked. Try again."
              : "暂时无法检查技能，请重试。",
        );
      }
    } finally {
      deviceRequest.current = null;
      if (!controller.signal.aborted) setDevicePending(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        layout="fullscreen-mobile"
        className="za-skill-reader max-w-[960px]"
        showCloseButton
        closeLabel={locale === "en-US" ? "Close skill details" : "关闭技能详情"}
      >
        <header>
          <div className="flex items-center gap-3">
            <ExtensionMark id={id} />
            <DialogTitle className="min-w-0 break-words">{title}</DialogTitle>
          </div>
          <div className="za-skill-reader-meta">
            {pkg?.publisher ? <span>{pkg.publisher}</span> : null}
            {pkg?.kind === "plugin" && <span>{extensionDisplayName(pkg, locale)}</span>}
            {hasDate && (
              <time dateTime={publishedAt.toISOString()}>
                {new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(publishedAt)}
              </time>
            )}
          </div>
          <DialogDescription className="za-skill-reader-description">
            {pkg && selectedSkill
              ? extensionSkillDescription(pkg, selectedSkill, locale)
              : builtinCopy?.description ||
                selectedSkill?.description ||
                (english ? "Read the pinned skill revision." : "阅读固定修订的技能内容。")}
          </DialogDescription>
        </header>
        {managementReason && (
          <StatusNotice
            className="za-skill-reader-availability"
            tone="warning"
            message={managementReason}
            actions={
              <button type="button" className="app-status-action" onClick={onManage}>
                {pkg?.kind === "plugin"
                  ? english
                    ? "Manage plugin"
                    : "管理插件"
                  : english
                    ? "Manage skill"
                    : "管理技能"}
              </button>
            }
          />
        )}
        <div className="za-skill-reader-body" data-file-tree={showFileTree || undefined}>
          {showFileTree && (
            <SkillReaderFileTree
              entry={entry}
              files={supportingFiles}
              selected={file}
              onSelect={openFile}
            />
          )}
          <div className="za-skill-reader-document">
            <div className="za-skill-file-bar">
              <div className="za-skill-file-identity" aria-live="polite">
                {isEntry && !previousFile ? (
                  <span
                    className="za-skill-file-title font-medium"
                    ref={fileTitleRef}
                    tabIndex={-1}
                  >
                    {english ? "Skill instructions" : "技能正文"}
                  </span>
                ) : (
                  <>
                    <Button variant="ghost" size="sm" aria-label={backLabel} onClick={goBackToFile}>
                      <ArrowLeft className="size-4" />
                      <span className="hidden sm:inline">
                        {backToEntry
                          ? english
                            ? "Instructions"
                            : "正文"
                          : english
                            ? "Back"
                            : "返回"}
                      </span>
                    </Button>
                    <span
                      className="za-skill-file-title truncate"
                      title={file}
                      ref={fileTitleRef}
                      tabIndex={-1}
                    >
                      {isEntry ? (english ? "Skill instructions" : "技能正文") : file}
                    </span>
                  </>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {isMarkdown && (
                  <Button variant="ghost" size="sm" onClick={() => setSource(!source)}>
                    {source ? (english ? "Read" : "阅读") : english ? "Source" : "原文"}
                  </Button>
                )}
                {supportingFiles.length > 0 && (
                  <SkillReaderFileMenu
                    entry={entry}
                    files={supportingFiles}
                    selected={file}
                    onSelect={openFile}
                  />
                )}
              </div>
            </div>
            <ScrollArea
              key={file}
              className="min-h-0 flex-1"
              contentClassName="za-skill-reader-content"
              viewportRef={fileViewportRef}
              viewportProps={{
                "aria-label": english ? `Read ${file || title}` : `阅读 ${file || title}`,
                className:
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
              }}
            >
              {error ? (
                <StatusNotice
                  className="mx-1 my-3"
                  tone={unavailable ? "warning" : "error"}
                  role="alert"
                  message={error}
                  actions={
                    !unavailable ? (
                      <button
                        type="button"
                        className="app-status-action"
                        onClick={() => {
                          fileTitleRef.current?.focus({ preventScroll: true });
                          if (refreshDirectory) onRefreshDirectory();
                          else setRetry((count) => count + 1);
                        }}
                      >
                        {refreshDirectory
                          ? english
                            ? "Refresh directory"
                            : "刷新目录"
                          : english
                            ? "Retry"
                            : "重试"}
                      </button>
                    ) : null
                  }
                />
              ) : !revision ? (
                <div
                  className="space-y-4"
                  role="status"
                  aria-label={english ? "Loading skill" : "正在加载技能"}
                >
                  <div className="h-5 w-2/3 animate-pulse rounded bg-muted" />
                  <div className="h-32 animate-pulse rounded bg-muted" />
                </div>
              ) : isMarkdown && !source ? (
                <SkillReaderMarkdown
                  file={file}
                  content={displayMarkdown}
                  readableFiles={readableFiles}
                  onFollow={followFile}
                />
              ) : (
                <SkillSourceCard key={file} path={file} text={body} />
              )}
            </ScrollArea>
          </div>
        </div>
        <footer>
          {installStatus && (
            <StatusNotice
              id={installStatusId}
              className="basis-full"
              compact
              tone={
                installFailure?.kind === "failed" || (installNeedsCheck && directoryError)
                  ? "error"
                  : installNeedsCheck
                    ? "warning"
                    : pkg?.installed
                      ? "success"
                      : "info"
              }
              busy={installNeedsCheck && directoryLoading}
              message={installStatus}
            />
          )}
          {actionError && (
            <p className="za-skill-action-error" role="alert">
              {actionError}
            </p>
          )}
          {tryError === "draft-reference-conflict" && !deviceError ? (
            <Button variant="ghost" className="rounded-full" onClick={onReturnToDraft}>
              {english ? "Back to draft" : "返回草稿"}
            </Button>
          ) : null}
          {catalogAvailable && pkg?.id === "imagegen" && onConfigureImages ? (
            <Button
              data-extension-configure-images
              variant="outline"
              className="ml-auto rounded-full"
              onClick={onConfigureImages}
            >
              {english ? "Configure image model" : "配置生图模型"}
            </Button>
          ) : null}
          {catalogAvailable && onTryOnDevice && pkg?.installed && pkg.enabled && (
            <Button
              variant="outline"
              className="rounded-full"
              disabled={writeBlocked || devicePending || !loadedSkill || !!error || skillDisabled}
              onClick={() => void prepareForDevice()}
            >
              {devicePending
                ? locale === "en-US"
                  ? "Checking skill…"
                  : "正在检查技能…"
                : locale === "en-US"
                  ? "Use on this computer"
                  : "在此电脑中使用"}
            </Button>
          )}
          {!installNeedsCheck &&
          (!catalogAvailable ||
            !pkg ||
            pinnedUninstalled ||
            pkg.kind === "plugin" ||
            requestedRevision !== pkg.version) ? (
            <Button className="rounded-full" onClick={onClose}>
              {locale === "en-US" ? "Close" : "关闭"}
            </Button>
          ) : (
            <Button
              className="min-h-11 rounded-full aria-disabled:opacity-50"
              aria-disabled={primaryActionDisabled || undefined}
              aria-busy={installing || (installNeedsCheck && directoryLoading) || undefined}
              aria-describedby={installStatus ? installStatusId : undefined}
              onClick={() => {
                if (primaryActionDisabled) return;
                if (installNeedsCheck) onRefreshDirectory();
                else if (pkg?.installed) {
                  setDeviceError("");
                  const result = onTry();
                  if (result !== "accepted") setTryError(result);
                } else void installSkill();
              }}
            >
              {installingLabel ||
                (pkg?.installed ? (
                  <>
                    <SquarePen className="size-4" />
                    {english ? "Try in chat" : "在对话中使用"}
                  </>
                ) : (
                  <>
                    <Plus className="size-4" />
                    {english ? "Install skill" : "安装技能"}
                  </>
                ))}
            </Button>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  );
}
function SkillEditor({
  adapter,
  id: selectedId,
  draftId: preparedId,
  kind: selectedKind,
  catalog,
  onReconciled,
  onSaved,
  onBack,
  onDirtyChange,
}: {
  adapter: ExtensionsAdapter;
  id?: string;
  draftId?: string;
  kind: ExtensionKind;
  catalog: ExtensionCatalog | null;
  onReconciled: (value: ExtensionCatalog) => void;
  onSaved: (value: ExtensionCatalog, kind: ExtensionKind) => void;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [prepared, setPrepared] = useState<ExtensionPreparedDraft | null>(null);
  const [draftStale, setDraftStale] = useState(false);
  const id = prepared?.target_id ?? selectedId;
  const kind = prepared?.kind ?? selectedKind;
  const draftId = preparedId
    ? `prepared-${preparedId}`
    : (id ?? (kind === "plugin" ? "new-plugin" : undefined));
  const [initial] = useState<ExtensionRevision>({
    number: 0,
    name: "",
    description: "",
    files: { "SKILL.md": "# 工作方法\n\n## 何时使用\n\n## 执行步骤\n\n## 交付要求\n" },
    skills: [],
    created_at: "",
  });
  const [restored] = useState(() =>
    readExtensionDraft(extensionSessionStorage(), adapter.scope, draftId),
  );
  const [revision, setRevision] = useState<ExtensionRevision>(restored?.revision ?? initial);
  const [baseline, setBaseline] = useState(restored?.baseline ?? JSON.stringify(initial)),
    [version, setVersion] = useState(restored?.version ?? catalog?.version ?? 0),
    [file, setFile] = useState(restored?.revision.skills[0]?.entry ?? "SKILL.md"),
    [loading, setLoading] = useState(!!selectedId || !!preparedId),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [discard, setDiscard] = useState(false),
    [fileName, setFileName] = useState("");
  const [conflict, setConflict] = useState<{
    revision?: ExtensionRevision;
    version: number;
    names?: string[];
  } | null>(null);
  const saveLock = useRef(false);
  const nameId = useId(),
    descriptionId = useId();
  const dirty = !!baseline && JSON.stringify(revision) !== baseline;
  const reportDirty = useRef(onDirtyChange);
  reportDirty.current = onDirtyChange;
  useEffect(() => {
    reportDirty.current(dirty);
    return () => reportDirty.current(false);
  }, [dirty]);
  useEffect(() => {
    if (!selectedId) {
      return;
    }
    const controller = new AbortController();
    void adapter
      .read(selectedId, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (!restored) {
          setRevision(value.revision);
          setFile(value.revision.skills[0]?.entry ?? "SKILL.md");
          setBaseline(JSON.stringify(value.revision));
          setVersion(value.version);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [adapter, selectedId, restored]);
  useEffect(() => {
    if (!preparedId) return;
    if (!adapter.readDraft) {
      setLoading(false);
      setError("对话草稿暂不可用。");
      return;
    }
    const controller = new AbortController();
    void Promise.all([
      adapter.readDraft(preparedId, controller.signal),
      adapter.list(controller.signal),
    ])
      .then(([draft, current]) => {
        if (controller.signal.aborted) return;
        setPrepared(draft);
        const body = restored?.revision ?? draft.revision;
        setRevision(body);
        setBaseline(JSON.stringify(draft.revision));
        setFile(body.skills[0]?.entry ?? "SKILL.md");
        setVersion(current.version);
        if (
          draft.target_id &&
          current.packages.find((pkg) => pkg.id === draft.target_id)?.version !==
            draft.base_revision
        ) {
          setDraftStale(true);
          setError("原包已更新。可查看这份草稿，请基于最新内容重新生成后再保存。");
        }
        if (!draft.target_id && current.packages.some((pkg) => pkg.id === preparedId)) {
          setDraftStale(true);
          setError("这份草稿已保存，可在个人目录中打开。");
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "读取草稿失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [adapter, preparedId, restored]);
  useEffect(() => {
    if (!loading)
      writeExtensionDraft(
        extensionSessionStorage(),
        adapter.scope,
        draftId,
        dirty ? { revision, baseline, version } : null,
      );
  }, [adapter.scope, draftId, loading, dirty, revision, baseline, version]);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [dirty]);
  const valid =
    (!preparedId || (!!prepared && !draftStale)) &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(revision.name) &&
    revision.name.length <= 64 &&
    !!revision.description.trim() &&
    revision.description.length <= 500;
  const primaryEntry = revision.skills[0]?.entry ?? "SKILL.md";
  const generatedManifest = !!preparedId && !id && kind === "plugin" && file === "plugin.json";
  const change = (update: Partial<ExtensionRevision>) =>
    setRevision((current) => ({ ...current, ...update }));
  async function save() {
    if (!valid || saveLock.current || loading || adapter.writeUnconfirmed) return;
    saveLock.current = true;
    setBusy(true);
    setError("");
    try {
      const primary = {
        name: id && kind === "plugin" ? (revision.skills[0]?.name ?? revision.name) : revision.name,
        description: revision.description,
        entry: primaryEntry,
      };
      const updated = {
        ...revision,
        files: {
          ...revision.files,
          [primaryEntry]: `---\nname: ${primary.name}\ndescription: ${JSON.stringify(revision.description)}\n---\n\n${(revision.files[primaryEntry] ?? "").replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "")}`,
        },
        skills: [primary, ...revision.skills.slice(1)],
      };
      const result = await adapter.mutate(version, {
        action: "save",
        id,
        kind,
        revision: updated,
        base_revision: prepared?.base_revision,
        draft_id: preparedId,
      });
      writeExtensionDraft(extensionSessionStorage(), adapter.scope, draftId, null);
      onSaved(result, kind);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，编辑内容已保留。");
    } finally {
      setBusy(false);
      saveLock.current = false;
    }
  }
  return (
    <div className="za-skill-editor">
      <header>
        <Button
          variant="ghost"
          size="icon"
          title={preparedId ? "返回对话" : kind === "plugin" ? "返回插件" : "返回技能"}
          aria-label={preparedId ? "返回对话" : kind === "plugin" ? "返回插件" : "返回技能"}
          disabled={busy}
          onClick={() => (dirty ? setDiscard(true) : onBack())}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <h1>
          {preparedId
            ? "审阅草稿"
            : `${id ? "编辑" : "创建"}${kind === "plugin" ? "插件" : "技能"}`}
        </h1>
        <Button
          className="ml-auto rounded-full"
          disabled={loading || busy || !valid || adapter.writeUnconfirmed}
          onClick={() => void save()}
        >
          {busy && <Loader2 className="size-4 animate-spin" />}保存
        </Button>
      </header>
      <ScrollArea className="min-h-0 flex-1" contentClassName="za-skill-editor-form">
        {restored && (
          <p role="status" className="text-sm text-muted-foreground">
            已恢复未保存的编辑。
          </p>
        )}
        <label htmlFor={nameId}>
          名称
          <Input
            id={nameId}
            disabled={loading || busy}
            value={revision.name}
            placeholder="例如 weekly-review"
            onChange={(event) => change({ name: event.target.value })}
            maxLength={64}
          />
          <span>使用小写英文字母、数字和连字符。</span>
        </label>
        <label htmlFor={descriptionId}>
          描述
          <Input
            id={descriptionId}
            disabled={loading || busy}
            value={revision.description}
            placeholder={`这个${kind === "plugin" ? "插件" : "技能"}做什么，什么时候使用？`}
            maxLength={500}
            onChange={(event) => change({ description: event.target.value })}
          />
        </label>
        <div className="za-skill-editor-files">
          <nav aria-label={kind === "plugin" ? "编辑插件文件" : "编辑技能文件"}>
            {Object.keys(revision.files)
              .sort()
              .map((name) => (
                <SidebarMenuButton
                  key={name}
                  type="button"
                  className="za-extension-nav h-auto min-h-9 rounded-lg"
                  isActive={name === file}
                  aria-current={name === file ? "true" : undefined}
                  onClick={() => setFile(name)}
                >
                  <FileText className="size-4 shrink-0" />
                  <LabelTooltip
                    label={name}
                    render={<span className="min-w-0 truncate">{name}</span>}
                  />
                </SidebarMenuButton>
              ))}
            <form
              className="mt-4 flex gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const name = fileName.trim();
                if (
                  !name ||
                  name.startsWith(".") ||
                  name.includes("..") ||
                  name.includes("\\") ||
                  name.startsWith("/") ||
                  revision.files[name] !== undefined
                )
                  return;
                change({ files: { ...revision.files, [name]: "" } });
                setFile(name);
                setFileName("");
              }}
            >
              <Input
                aria-label="新文件名"
                placeholder="references/guide.md"
                value={fileName}
                onChange={(event) => setFileName(event.target.value)}
              />
              <Button
                type="submit"
                variant="ghost"
                size="icon"
                title="添加文件"
                aria-label="添加文件"
                disabled={busy}
              >
                <Plus className="size-4" />
              </Button>
            </form>
          </nav>
          <div>
            <div className="za-skill-file-bar">
              <span className="truncate">{file}</span>
              {generatedManifest && (
                <span className="text-xs text-muted-foreground">随包信息生成</span>
              )}
              {file !== primaryEntry && !generatedManifest && (
                <Button
                  variant="ghost"
                  size="icon"
                  title="删除文件"
                  aria-label="删除文件"
                  disabled={busy}
                  onClick={() => {
                    const files = { ...revision.files };
                    delete files[file];
                    change({
                      files,
                      skills: revision.skills.filter((skill) => skill.entry !== file),
                    });
                    setFile(primaryEntry);
                  }}
                >
                  <X className="size-4" />
                </Button>
              )}
            </div>
            <textarea
              className="za-skill-source"
              aria-label={`编辑 ${file}`}
              spellCheck={false}
              disabled={loading || busy}
              readOnly={generatedManifest}
              value={revision.files[file] ?? ""}
              onChange={(event) =>
                change({ files: { ...revision.files, [file]: event.target.value } })
              }
            />
          </div>
        </div>
        {error && (
          <div role="alert" className="za-extension-feedback">
            <span>{error}</span>
            {adapter.writeUnconfirmed && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void adapter
                    .list()
                    .then((next) => {
                      onReconciled(next);
                      setError(
                        id
                          ? "目录已核对，编辑已保留。请核对其他页面的修改后再保存。"
                          : `目录已核对，编辑已保留。请先返回${kind === "plugin" ? "插件" : "技能"}目录检查是否已创建，避免重复创建。`,
                      );
                    })
                    .catch((cause) => setError(cause instanceof Error ? cause.message : "读取失败"))
                    .finally(() => setBusy(false));
                }}
              >
                刷新目录核对
              </Button>
            )}
            {!id && (
              <Button
                variant="ghost"
                disabled={busy || adapter.writeUnconfirmed}
                onClick={() => {
                  setBusy(true);
                  void adapter
                    .list()
                    .then((next) => {
                      onReconciled(next);
                      setConflict({
                        version: next.version,
                        names: next.packages
                          .filter((item) => extensionOwned(item) && item.kind === kind)
                          .map((item) => item.name),
                      });
                    })
                    .catch((cause) => setError(cause instanceof Error ? cause.message : "读取失败"))
                    .finally(() => setBusy(false));
                }}
              >
                核对{kind === "plugin" ? "插件" : "技能"}目录
              </Button>
            )}
            {id && (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void adapter
                    .read(id)
                    .then(setConflict)
                    .catch((cause) => setError(cause instanceof Error ? cause.message : "读取失败"))
                    .finally(() => setBusy(false));
                }}
              >
                比较已保存内容
              </Button>
            )}
          </div>
        )}
      </ScrollArea>
      <Dialog open={discard} onOpenChange={setDiscard}>
        <DialogContent className="p-6">
          <DialogTitle>放弃未保存的修改？</DialogTitle>
          <DialogDescription className="mt-3 text-muted-foreground">
            {kind === "plugin" ? "插件" : "技能"}还没有保存。你可以继续编辑，或放弃这次修改。
          </DialogDescription>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDiscard(false)}>
              继续编辑
            </Button>
            <Button
              onClick={() => {
                writeExtensionDraft(extensionSessionStorage(), adapter.scope, draftId, null);
                onBack();
              }}
            >
              放弃修改
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!conflict}
        onOpenChange={(open) => {
          if (!open) setConflict(null);
        }}
      >
        <DialogContent className="max-w-[900px] p-6" layout="fullscreen-mobile">
          <DialogTitle>比较已保存内容</DialogTitle>
          <DialogDescription>
            {id
              ? "先核对其他页面的修改，再决定是否保存当前编辑。"
              : "先检查技能是否已经创建。已有同名技能时，可返回查看，或明确选择继续创建新的技能。"}
          </DialogDescription>
          <div className="grid min-h-0 grid-cols-1 gap-4 sm:grid-cols-2">
            {[
              { title: id ? "已保存内容" : "已创建的技能", value: conflict?.revision },
              { title: "当前编辑", value: revision },
            ].map((item) => (
              <div key={item.title} className="min-w-0">
                <h3 className="my-3 font-medium">{item.title}</h3>
                <ScrollArea className="h-72 rounded-xl bg-muted/40" contentClassName="p-4">
                  <pre className="whitespace-pre-wrap break-words text-xs">
                    {item.value
                      ? `${item.value.name}\n${item.value.description}\n\n${JSON.stringify(item.value.files, null, 2)}`
                      : conflict?.names?.join("\n") || "还没有创建技能"}
                  </pre>
                </ScrollArea>
              </div>
            ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConflict(null)}>
              继续编辑
            </Button>
            <Button
              onClick={() => {
                if (conflict) setVersion(conflict.version);
                setConflict(null);
                setError("");
              }}
            >
              {id ? "使用当前编辑，准备保存" : "使用当前编辑，准备创建"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
