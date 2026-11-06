import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  Blend,
  Package as Box,
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
import { Markdown } from "../../components/Markdown";
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
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from "../../components/ui/sidebar";
import {
  SidebarResizeContext,
  SidebarResizeHandle,
  useSidebarWidthLayout,
} from "../../components/ui/sidebar-resize";
import { Switch } from "../../components/ui/switch";
import { TooltipButton as Button } from "../../components/ui/tooltip-button";
import { useLocale } from "../../i18n";
import {
  extensionDescription,
  extensionDisplayName,
  extensionOverview,
  extensionSearchText,
  extensionSkillDescription,
  extensionSkillDisplayName,
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
  type ExtensionSkill,
  type ExtensionsAdapter,
  extensionOwned,
  extensionSkillEnabled,
} from "./extensionTypes";
import { SkillFileIcon, SkillReaderFileTree, SkillSourceCard } from "./SkillReaderFiles";
import "./extensions.css";

type Route =
  | { page: "plugins" | "skills" }
  | { page: "plugin" | "manage"; id: string }
  | { page: "editor"; id?: string; draftId?: string; kind?: ExtensionKind; returnTo?: string };
type SkillSelection = { pkg: ExtensionPackage; skill: ExtensionSkill; returnToChat?: boolean };
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
export function ExtensionsWorkspace(props: {
  adapter: ExtensionsAdapter;
  catalog: ExtensionCatalog | null;
  loading: boolean;
  error: string;
  onCatalog: (catalog: ExtensionCatalog) => void;
  onRefresh: () => void;
  onBack: () => void;
  onTry: (pkg: ExtensionPackage, skill: ExtensionSkill, text?: string) => void;
  onConfigureImages?: () => void;
  openPackage?: { id: string; key: number; draft?: boolean; skillName?: string };
}) {
  const { adapter, catalog } = props;
  const { locale } = useLocale();
  const host = useRef<HTMLDivElement>(null);
  const sidebarLayout = useSidebarWidthLayout(host, false, 720);
  const [route, setRoute] = useState<Route>(() => restoredRoute(adapter.scope));
  const [query, setQuery] = useState("");
  const [installedSearchOpen, setInstalledSearchOpen] = useState(false);
  const [installedQuery, setInstalledQuery] = useState("");
  const installedSearchInput = useRef<HTMLInputElement>(null);
  const installedSearchButton = useRef<HTMLButtonElement>(null);
  const [source, setSource] = useState<"public" | "personal">("public");
  const [installation, setInstallation] = useState("all");
  const [selected, setSelected] = useState<SkillSelection | null>(null);
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
  const [notice, setNotice] = useState("");
  const [expandedSkills, setExpandedSkills] = useState(false);
  const [importKind, setImportKind] = useState<ExtensionKind | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState("");
  const [remove, setRemove] = useState<ExtensionPackage | null>(null);
  const mutationLock = useRef(false);
  const searchId = useId();
  const upload = useRef<HTMLInputElement>(null);
  const editorDirty = useRef(false);
  const writeBlocked = busy || !!adapter.writeUnconfirmed || props.loading;
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
      setQuery("");
      setError("");
      setNotice("");
      setSelected(reader ?? null);
      setSelectedApp(null);
      setExpandedSkills(false);
      if (reader) return;
      const frame = requestAnimationFrame(() =>
        host.current?.querySelector<HTMLElement>("h1")?.focus(),
      );
      return () => cancelAnimationFrame(frame);
    }
  }, [props.openPackage, catalog]);
  useEffect(() => {
    try {
      extensionSessionStorage()?.setItem(
        `zeroagent:extensions-view:${adapter.scope}`,
        JSON.stringify(route),
      );
    } catch {
      /* Navigation remains available without session storage. */
    }
  }, [adapter.scope, route]);
  const packages = catalog?.packages ?? [];
  const selectedPackage = selected
    ? (packages.find((item) => item.id === selected.pkg.id) ?? selected.pkg)
    : null;
  const pkg = "id" in route ? packages.find((item) => item.id === route.id) : undefined;
  const navigate = (next: Route, force = false) => {
    if (!force && route.page === "editor" && editorDirty.current) {
      setPendingRoute({ route: next });
      return;
    }
    setRoute(next);
    setQuery("");
    setError("");
    setNotice("");
    setExpandedSkills(false);
  };
  async function mutate(input: ExtensionMutation) {
    if (!catalog || mutationLock.current || writeBlocked) return false;
    mutationLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      props.onCatalog(await adapter.mutate(catalog.version, input));
      setNotice("已保存");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请重试。");
      return false;
    } finally {
      setBusy(false);
      mutationLock.current = false;
    }
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
      setError(cause instanceof Error ? cause.message : "下载失败，请重试。");
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
      setSource("personal");
      setInstallation("all");
      setQuery("");
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
  const directoryKind = route.page === "skills" ? "skill" : "plugin";
  const pluginDirectoryActive =
    route.page === "plugins" || (pkg?.kind === "plugin" && !pkg.installed);
  const skillDirectoryActive = route.page === "skills" || pkg?.kind === "skill";
  const filtered = packages.filter(
    (item) =>
      item.kind === directoryKind &&
      item.visibility === source &&
      (installation === "all" || item.installed === (installation === "installed")) &&
      extensionSearchText(item).includes(query.trim().toLocaleLowerCase()),
  );
  const installedPlugins = packages.filter(
    (item) =>
      item.installed &&
      item.kind === "plugin" &&
      extensionSearchText(item).includes(installedQuery.trim().toLocaleLowerCase()),
  );
  const directorySections =
    directoryKind === "skill" && installation === "all"
      ? [
          { label: "已安装", items: filtered.filter((item) => item.installed) },
          { label: "未安装", items: filtered.filter((item) => !item.installed) },
        ].filter(({ items }) => items.length > 0)
      : [
          {
            label:
              installation === "installed"
                ? "已安装"
                : installation === "uninstalled"
                  ? "未安装"
                  : source === "public"
                    ? "公开目录"
                    : "你创建的",
            items: filtered,
          },
        ];
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
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            sidebar ? (
              <SidebarMenuAction
                type="button"
                showOnHover
                aria-label={`已安装插件 ${label}的操作`}
              />
            ) : (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${skill ? extensionSkillDisplayName(item, skill, locale) : label}的操作`}
                title="更多"
              />
            )
          }
        >
          <MoreHorizontal className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={!extensionSkillEnabled(item, skill ?? item.skills[0])}
            onClick={() => props.onTry(item, skill ?? item.skills[0])}
          >
            <SquarePen className="size-4" />
            在对话中使用
          </DropdownMenuItem>
          {extensionOwned(item) && (
            <DropdownMenuItem onClick={() => void download(item)}>
              <Download className="size-4" />
              {item.kind === "plugin" ? "下载插件包" : "下载技能包"}
            </DropdownMenuItem>
          )}
          {extensionOwned(item) && (
            <DropdownMenuItem
              onClick={() => navigate({ page: "editor", id: item.id, kind: item.kind })}
            >
              <Pencil className="size-4" />
              {item.kind === "plugin" ? "编辑插件" : "编辑技能"}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => navigate({ page: "manage", id: item.id })}>
            <Settings className="size-4" />
            管理
          </DropdownMenuItem>
          {item.installed && (
            <DropdownMenuItem
              disabled={writeBlocked}
              onClick={() => void mutate({ action: "enable", id: item.id, enabled: !item.enabled })}
            >
              {item.enabled ? "停用" : "启用"}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          {item.installed ? (
            <DropdownMenuItem
              className="text-destructive"
              disabled={writeBlocked}
              onClick={() => setRemove(item)}
            >
              卸载
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              disabled={writeBlocked}
              onClick={() => void mutate({ action: "install", id: item.id })}
            >
              安装
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };
  return (
    <div
      ref={host}
      className="za-extensions-workspace"
      data-testid="extensions-workspace"
      style={{ "--sidebar-width": `${sidebarLayout.width}px` } as CSSProperties}
    >
      {route.page !== "editor" && (
        <SidebarResizeContext.Provider value={sidebarLayout}>
          <div className="za-extensions-sidebar-container">
            <ScrollArea className="h-full">
              <aside>
                <SidebarHeader className="px-3 pb-2 pt-2.5">
                  <div className="flex h-8 items-center gap-2">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      title="返回对话"
                      aria-label="返回对话"
                      onClick={props.onBack}
                    >
                      <ArrowLeft className="size-4" />
                    </Button>
                    <h2 className="min-w-0 flex-1 truncate text-[17px] font-semibold leading-6">
                      自定义
                    </h2>
                    <Button
                      ref={installedSearchButton}
                      variant="ghost"
                      size="icon-sm"
                      title="搜索已安装的插件"
                      aria-label="搜索已安装的插件"
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
                  </div>
                  {installedSearchOpen && (
                    <Input
                      ref={installedSearchInput}
                      className="mt-2 h-8"
                      type="search"
                      aria-label="筛选已安装的插件"
                      placeholder="搜索已安装的插件"
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
                    <nav aria-label="自定义">
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
                            <span>插件</span>
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
                            <span>技能</span>
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      </SidebarMenu>
                    </nav>
                  </SidebarGroup>
                  <SidebarGroup className="mt-4 px-3">
                    <SidebarGroupLabel className="h-7">已安装</SidebarGroupLabel>
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
                          没有匹配的已安装插件
                        </p>
                      )}
                    </SidebarGroupContent>
                  </SidebarGroup>
                </SidebarContent>
              </aside>
            </ScrollArea>
            <SidebarResizeHandle />
          </div>
        </SidebarResizeContext.Provider>
      )}
      <div className="za-extensions-main">
        <div className="za-extensions-mobile-nav">
          <Button
            variant="ghost"
            size="icon"
            title="返回对话"
            aria-label="返回对话"
            onClick={props.onBack}
          >
            <ArrowLeft className="size-4" />
          </Button>
          <Button
            variant={route.page === "plugins" ? "secondary" : "ghost"}
            onClick={() => navigate({ page: "plugins" })}
          >
            插件
          </Button>
          <Button
            variant={route.page === "skills" ? "secondary" : "ghost"}
            onClick={() => navigate({ page: "skills" })}
          >
            技能
          </Button>
        </div>
        {pkg && (route.page === "plugin" || route.page === "manage") && (
          <nav className="za-extension-breadcrumb" aria-label="当前位置">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate({ page: pkg.kind === "skill" ? "skills" : "plugins" })}
            >
              {pkg.kind === "skill" ? "技能" : "插件"}
            </Button>
            <ChevronRight className="size-3.5" />
            {route.page === "manage" ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="查看详情"
                  onClick={() => navigate({ page: "plugin", id: pkg.id })}
                >
                  {extensionDisplayName(pkg, locale)}
                </Button>
                <ChevronRight className="size-3.5" />
                <span>管理</span>
              </>
            ) : (
              <span>{extensionDisplayName(pkg, locale)}</span>
            )}
          </nav>
        )}
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
              setSource("personal");
              setInstallation("all");
              setQuery("");
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
          >
            {route.page === "plugins" || route.page === "skills" ? (
              <>
                <header className="za-extensions-header">
                  <div>
                    <h1>{route.page === "plugins" ? "插件" : "技能"}</h1>
                    <p>
                      {route.page === "plugins"
                        ? "让 ZeroAgent 在你的工作中发挥更多作用"
                        : "为反复进行的工作，保存一套好用的方法"}
                    </p>
                  </div>
                  <div className="za-extensions-header-actions">
                    <label htmlFor={searchId} className="za-extension-search">
                      <Search className="size-4" />
                      <Input
                        id={searchId}
                        aria-label={route.page === "plugins" ? "搜索插件" : "搜索技能"}
                        placeholder={route.page === "plugins" ? "搜索插件" : "搜索技能"}
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                      />
                    </label>
                    {route.page === "plugins" && (
                      <Button
                        variant="outline"
                        className="rounded-full"
                        aria-label="管理已安装插件"
                        onClick={() => {
                          setInstallation("installed");
                          setQuery("");
                        }}
                      >
                        <Settings className="size-4" />
                        管理
                      </Button>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button className="rounded-full" disabled={writeBlocked} />}
                      >
                        <Plus className="size-4" />
                        添加
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
                              props.onTry(
                                creator,
                                skill,
                                usesExtensionPackagePresentation(creator)
                                  ? creator.examples?.[0]
                                  : route.page === "plugins"
                                    ? "帮我创建一个插件。以聊天的方式交流，先问我这个插件要完成什么任务，再整理其中的技能，生成可检查的插件包。"
                                    : "帮我创建一个技能。以聊天的方式交流，先问我这个技能要做什么，再生成可检查的技能包。",
                              );
                            else
                              setError(
                                `请先在${directoryKind === "plugin" ? "插件" : "技能"}目录中安装并启用${directoryKind === "plugin" ? "创建插件" : "创建技能"}。`,
                              );
                          }}
                        >
                          <SquarePen className="size-4" />
                          通过聊天创建
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => navigate({ page: "editor", kind: directoryKind })}
                        >
                          <Pencil className="size-4" />
                          使用编辑器创建
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => {
                            setImportKind(directoryKind);
                            setImportFile(null);
                            setImportError("");
                          }}
                        >
                          <Upload className="size-4" />
                          {directoryKind === "plugin" ? "上传插件包" : "上传技能包"}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </header>
                {props.loading && !catalog ? (
                  <div className="za-extension-directory" role="status" aria-label="正在加载">
                    <ExtensionSkeleton />
                    <ExtensionSkeleton />
                    <ExtensionSkeleton />
                    <ExtensionSkeleton />
                  </div>
                ) : (
                  <>
                    <div className="za-extension-filters">
                      <div
                        role="tablist"
                        aria-label="内容来源"
                        className="za-extension-source-tabs"
                        onKeyDown={(event) => {
                          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
                            return;
                          event.preventDefault();
                          const next =
                            event.key === "Home"
                              ? "public"
                              : event.key === "End"
                                ? "personal"
                                : source === "public"
                                  ? "personal"
                                  : "public";
                          setSource(next);
                          event.currentTarget
                            .querySelector<HTMLButtonElement>(`[data-source="${next}"]`)
                            ?.focus();
                        }}
                      >
                        {(
                          [
                            ["public", "公开"],
                            ["personal", "个人"],
                          ] as const
                        ).map(([value, label]) => (
                          <button
                            type="button"
                            role="tab"
                            key={value}
                            data-source={value}
                            aria-selected={source === value}
                            tabIndex={source === value ? 0 : -1}
                            onClick={() => setSource(value)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="sm"
                              className="rounded-full"
                              aria-label="安装状态"
                            />
                          }
                        >
                          {installation === "all"
                            ? "全部"
                            : installation === "installed"
                              ? "已安装"
                              : "未安装"}
                          <ChevronDown className="size-3" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuRadioGroup
                            value={installation}
                            onValueChange={setInstallation}
                          >
                            <DropdownMenuRadioItem value="all" closeOnClick>
                              全部
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="installed" closeOnClick>
                              已安装
                            </DropdownMenuRadioItem>
                            <DropdownMenuRadioItem value="uninstalled" closeOnClick>
                              未安装
                            </DropdownMenuRadioItem>
                          </DropdownMenuRadioGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                    {directorySections.map((section) => (
                      <section className="za-extension-directory-section" key={section.label}>
                        <h2 className="za-extension-section-label">{section.label}</h2>
                        <ul
                          className="za-extension-directory"
                          aria-label={
                            directoryKind === "plugin" ? "插件目录" : section.label + "技能"
                          }
                        >
                          {section.items.map((item) => (
                            <ExtensionDirectoryItem
                              key={item.id}
                              item={item}
                              onOpen={() =>
                                item.kind === "skill"
                                  ? setSelected({ pkg: item, skill: item.skills[0] })
                                  : navigate({ page: "plugin", id: item.id })
                              }
                            >
                              {item.installed ? (
                                <>
                                  <span className="za-extension-row-state">
                                    {item.enabled ? "已安装" : "已停用"}
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
                                    aria-label={`安装 ${extensionDisplayName(item, locale)}`}
                                    title={`安装 ${extensionDisplayName(item, locale)}`}
                                    disabled={writeBlocked}
                                    onClick={() => void mutate({ action: "install", id: item.id })}
                                  >
                                    <Plus className="size-4" />
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
                          query
                            ? "没有找到匹配结果"
                            : !packages.some(
                                  (item) =>
                                    item.kind === directoryKind && item.visibility === source,
                                )
                              ? source === "personal"
                                ? "还没有个人内容，可通过聊天创建或上传。"
                                : `暂无公开${directoryKind === "plugin" ? "插件" : "技能"}`
                              : installation === "uninstalled"
                                ? `没有未安装的${directoryKind === "plugin" ? "插件" : "技能"}`
                                : installation === "installed"
                                  ? `没有已安装的${directoryKind === "plugin" ? "插件" : "技能"}`
                                  : "没有符合筛选的内容"
                        }
                      />
                    )}
                  </>
                )}
              </>
            ) : pkg ? (
              <>
                <header className="za-extension-detail-header">
                  <ExtensionMark id={pkg.id} />
                  <div>
                    <h1 tabIndex={-1} className="outline-none">
                      {extensionDisplayName(pkg, locale)}
                    </h1>
                    <p>
                      {pkg.publisher} · {pkg.visibility === "public" ? "公开" : "个人"}
                    </p>
                  </div>
                  <div className="ml-auto flex items-center gap-2">
                    {pkg.installed ? (
                      <>
                        <Button
                          variant="outline"
                          className="rounded-full"
                          onClick={() =>
                            navigate({
                              page: route.page === "manage" ? "plugin" : "manage",
                              id: pkg.id,
                            })
                          }
                        >
                          <Settings className="size-4" />
                          {route.page === "manage" ? "详情" : "管理"}
                        </Button>
                        <Button
                          className="rounded-full"
                          disabled={!extensionSkillEnabled(pkg, pkg.skills[0]) || busy}
                          onClick={() => props.onTry(pkg, pkg.skills[0])}
                        >
                          <SquarePen className="size-4" />
                          在聊天中试用
                        </Button>
                      </>
                    ) : (
                      <Button
                        className="rounded-full"
                        disabled={writeBlocked}
                        onClick={() => void mutate({ action: "install", id: pkg.id })}
                      >
                        安装
                      </Button>
                    )}
                  </div>
                </header>
                {route.page === "plugin" &&
                  (pkg.examples?.length > 0 || !usesExtensionPackagePresentation(pkg)) && (
                    <>
                      <h2 className="sr-only">从这里开始</h2>
                      <div className="za-extension-starters">
                        {(pkg.examples?.length ? pkg.examples : ["使用这个技能帮我完成工作"]).map(
                          (example) => (
                            <button
                              type="button"
                              key={example}
                              disabled={!extensionSkillEnabled(pkg, pkg.skills[0])}
                              onClick={() => props.onTry(pkg, pkg.skills[0], example)}
                            >
                              <ExtensionMark id={pkg.id} small />
                              <strong>{extensionDisplayName(pkg, locale)}</strong>
                              <span>{example}</span>
                              <ChevronRight className="size-4 shrink-0" />
                            </button>
                          ),
                        )}
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
                      <section
                        className="za-extension-apps"
                        aria-labelledby="extension-apps-heading"
                      >
                        <h2 id="extension-apps-heading" className="za-extension-section-label">
                          应用{" "}
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
                        <h2>在对话中使用</h2>
                        <p>启用后，ZeroAgent 可以按任务需要读取技能指令。</p>
                      </div>
                      <Switch
                        aria-label={`启用${pkg.kind === "plugin" ? "插件" : "技能"} ${extensionDisplayName(pkg, locale)}`}
                        checked={pkg.installed && pkg.enabled}
                        disabled={!pkg.installed || writeBlocked}
                        onCheckedChange={(enabled) =>
                          void mutate({ action: "enable", id: pkg.id, enabled })
                        }
                      />
                    </div>
                  )}
                  <section className="za-extension-skills" aria-label="技能">
                    <h2 className="za-extension-section-label">
                      {pkg.kind === "plugin" ? (
                        <>
                          技能{" "}
                          <span className="za-extension-section-count">{pkg.skills.length}</span>
                        </>
                      ) : (
                        "技能指令"
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
                          onClick={() => setSelected({ pkg, skill })}
                        >
                          <ExtensionMark id={pkg.id} small />
                          <span>
                            <strong title={skill.name}>
                              {extensionSkillDisplayName(pkg, skill, locale)}
                            </strong>
                            <span>{extensionSkillDescription(pkg, skill, locale)}</span>
                          </span>
                        </button>
                        {route.page === "manage" ? (
                          <Switch
                            aria-label={`启用技能 ${extensionSkillDisplayName(pkg, skill, locale)}`}
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
                        {expandedSkills ? "收起技能" : `查看其余 ${pkg.skills.length - 5} 项技能`}
                      </Button>
                    )}
                  </section>
                  {pkg.id === "imagegen" && props.onConfigureImages && (
                    <div className="za-extension-setting-row">
                      <div>
                        <h2>默认生图模型</h2>
                        <p>使用设置中已配置的生图模型。</p>
                      </div>
                      <Button
                        variant="outline"
                        className="rounded-full"
                        data-extension-configure-images=""
                        onClick={props.onConfigureImages}
                      >
                        配置模型
                      </Button>
                    </div>
                  )}
                  {extensionOwned(pkg) && (
                    <div className="za-extension-setting-row">
                      <div>
                        <h2>{pkg.kind === "plugin" ? "插件文件" : "技能文件"}</h2>
                        <p>查看完整指令，或下载一份副本。</p>
                      </div>
                      <Button
                        variant="ghost"
                        className="rounded-full"
                        onClick={() => void download(pkg)}
                      >
                        <Download className="size-4" />
                        下载
                      </Button>
                    </div>
                  )}
                  {extensionOwned(pkg) && (
                    <div className="za-extension-setting-row">
                      <div>
                        <h2>编辑{pkg.kind === "plugin" ? "插件" : "技能"}</h2>
                        <p>修改说明和指令，保存后用于之后的工作。</p>
                      </div>
                      <Button
                        variant="outline"
                        className="rounded-full"
                        onClick={() => navigate({ page: "editor", id: pkg.id, kind: pkg.kind })}
                      >
                        编辑
                      </Button>
                    </div>
                  )}
                  {route.page === "manage" && pkg.installed && (
                    <div className="za-extension-setting-row">
                      <div>
                        <h2>卸载</h2>
                        <p>保留已有对话和工作成果。</p>
                      </div>
                      <Button
                        variant="ghost"
                        className="rounded-full text-destructive"
                        onClick={() => setRemove(pkg)}
                      >
                        卸载
                      </Button>
                    </div>
                  )}
                  {route.page === "plugin" && (
                    <section className="za-extension-info">
                      <h2 className="za-extension-section-label">信息</h2>
                      <dl>
                        <dt>发布者</dt>
                        <dd>{pkg.publisher}</dd>
                        <dt>类型</dt>
                        <dd>{pkg.kind === "plugin" ? "插件" : "独立技能"}</dd>
                        <dt>来源</dt>
                        <dd>{pkg.visibility === "public" ? "公开目录" : "个人内容"}</dd>
                      </dl>
                    </section>
                  )}
                </div>
              </>
            ) : (
              <Empty text="这个插件已不可用">
                <Button variant="ghost" onClick={() => navigate({ page: "plugins" })}>
                  返回目录
                </Button>
              </Empty>
            )}
            {(error || props.error || adapter.writeUnconfirmed) && (
              <div className="za-extension-feedback" role="alert">
                <span>
                  {error || props.error || "上次操作结果尚未确认，请刷新目录核对后再继续。"}
                </span>
                <Button variant="ghost" size="sm" onClick={props.onRefresh}>
                  刷新目录
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
          正在保存
        </span>
      )}
      {selected && (
        <SkillReader
          key={`${adapter.scope}:${selected.pkg.id}:${selected.skill.entry}`}
          adapter={adapter}
          selection={{ ...selected, pkg: selectedPackage ?? selected.pkg }}
          busy={writeBlocked}
          onInstall={() => void mutate({ action: "install", id: selected.pkg.id })}
          onClose={() => {
            setSelected(null);
            if (selected.returnToChat) props.onBack();
          }}
          onConfigureImages={props.onConfigureImages}
          onTry={() => {
            props.onTry(selectedPackage ?? selected.pkg, selected.skill);
            setSelected(null);
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
                  setSelected(pendingRoute.reader ?? null);
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
          <DialogTitle>卸载 {remove ? extensionDisplayName(remove, locale) : ""}？</DialogTitle>
          <DialogDescription className="mt-3 text-muted-foreground">
            卸载后将不再用于新的对话。已有聊天和成果会保留。
          </DialogDescription>
          {error && (
            <p role="alert" className="za-extension-feedback">
              {error}
              {adapter.writeUnconfirmed && (
                <Button variant="ghost" onClick={props.onRefresh}>
                  刷新目录核对
                </Button>
              )}
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => setRemove(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={writeBlocked}
              onClick={() => {
                if (remove)
                  void mutate({ action: "uninstall", id: remove.id }).then((saved) => {
                    if (saved) setRemove(null);
                  });
              }}
            >
              卸载
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
      <p>{text}</p>
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

function SkillReader({
  adapter,
  selection,
  onClose,
  onTry,
  onInstall,
  busy,
  onConfigureImages,
}: {
  adapter: ExtensionsAdapter;
  selection: SkillSelection;
  onClose: () => void;
  onTry: () => void;
  onInstall: () => void;
  busy: boolean;
  onConfigureImages?: () => void;
}) {
  const { locale } = useLocale();
  const [revision, setRevision] = useState<ExtensionRevision | null>(null),
    [file, setFile] = useState(selection.skill.entry),
    [source, setSource] = useState(false),
    [error, setError] = useState(""),
    [retry, setRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly re-reads the same selection.
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    setRevision(null);
    void adapter
      .read(selection.pkg.id, controller.signal)
      .then((result) => {
        if (result.revision.number !== selection.pkg.version)
          throw new Error("内容已更新，请刷新目录后重新打开。");
        if (!controller.signal.aborted) setRevision(result.revision);
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "加载失败");
      });
    return () => controller.abort();
  }, [adapter, selection.pkg.id, selection.pkg.version, retry]);
  const entry = selection.skill.entry;
  const isEntry = file === entry;
  const title =
    selection.pkg.kind === "skill"
      ? extensionDisplayName(selection.pkg, locale)
      : extensionSkillDisplayName(selection.pkg, selection.skill, locale);
  const publishedAt = new Date(selection.pkg.updated_at);
  const hasDate = Number.isFinite(publishedAt.getTime()) && publishedAt.getUTCFullYear() >= 1970;
  const siblingEntries = new Set(
    revision?.skills.filter((skill) => skill.entry !== entry).map((skill) => skill.entry),
  );
  const supportingFiles = Object.keys(revision?.files ?? {})
    .filter((path) => path !== entry && !siblingEntries.has(path))
    .sort();
  const body = revision?.files[file] ?? "";
  const isMarkdown = /\.md$/i.test(file);
  const markdown = body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)(?:\r?\n)*/, "");
  const firstLineEnd = markdown.indexOf("\n");
  const heading = firstLineEnd === -1 ? markdown : markdown.slice(0, firstLineEnd).trimEnd();
  const sourceTitle = extensionSkillDisplayName(selection.pkg, selection.skill, "en-US");
  const displayMarkdown =
    isEntry && (heading === `# ${title}` || heading === `# ${sourceTitle}`)
      ? markdown.slice(firstLineEnd === -1 ? markdown.length : firstLineEnd + 1)
      : markdown;
  const openFile = (path: string) => {
    setFile(path);
    setSource(false);
  };
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
            <ExtensionMark id={selection.pkg.id} />
            <DialogTitle className="min-w-0 break-words">{title}</DialogTitle>
          </div>
          <div className="za-skill-reader-meta">
            <span>{selection.pkg.publisher}</span>
            {selection.pkg.kind === "plugin" && (
              <span>{extensionDisplayName(selection.pkg, locale)}</span>
            )}
            {hasDate && (
              <time dateTime={publishedAt.toISOString()}>
                {new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(publishedAt)}
              </time>
            )}
          </div>
          <DialogDescription className="za-skill-reader-description">
            {extensionSkillDescription(selection.pkg, selection.skill, locale)}
          </DialogDescription>
        </header>
        <div className="za-skill-reader-body">
          <SkillReaderFileTree
            entry={entry}
            files={supportingFiles}
            selected={file}
            onSelect={openFile}
          />
          <div className="za-skill-reader-document">
            <div className="za-skill-file-bar" data-source-file={!isMarkdown}>
              <div className="za-skill-file-identity" aria-live="polite">
                {isEntry ? (
                  <span className="font-medium">技能正文</span>
                ) : (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label="返回技能正文"
                      onClick={() => openFile(entry)}
                    >
                      <ArrowLeft className="size-4" />
                      <span className="hidden sm:inline">正文</span>
                    </Button>
                    <span className="truncate" title={file}>
                      {file}
                    </span>
                  </>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {isMarkdown && (
                  <Button variant="ghost" size="sm" onClick={() => setSource(!source)}>
                    {source ? "阅读" : "原文"}
                  </Button>
                )}
                {supportingFiles.length > 0 && (
                  <div className="za-skill-mobile-files">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={<Button variant="ghost" size="sm" aria-label="浏览包内资料" />}
                      >
                        <FileText className="size-4" />
                        <span>资料</span>
                        <ChevronDown className="size-3" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="end"
                        className="za-skill-file-menu max-w-[calc(100vw-32px)] max-h-[60dvh] overflow-y-auto"
                      >
                        {supportingFiles.map((path) => (
                          <DropdownMenuItem key={path} onClick={() => openFile(path)}>
                            <SkillFileIcon path={path} />
                            <span className="min-w-0 flex-1 truncate">{path}</span>
                            {file === path && <Check className="size-4 shrink-0" />}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                )}
              </div>
            </div>
            <ScrollArea
              key={file}
              className="min-h-0 flex-1"
              contentClassName="za-skill-reader-content"
            >
              {error ? (
                <div role="alert">
                  {error}
                  <Button variant="ghost" onClick={() => setRetry(retry + 1)}>
                    重试
                  </Button>
                </div>
              ) : !revision ? (
                <div className="space-y-4" role="status" aria-label="正在加载技能">
                  <div className="h-5 w-2/3 animate-pulse rounded bg-muted" />
                  <div className="h-32 animate-pulse rounded bg-muted" />
                </div>
              ) : isMarkdown && !source ? (
                <Markdown content={displayMarkdown} readOnly />
              ) : (
                <SkillSourceCard key={file} path={file} text={body} />
              )}
            </ScrollArea>
          </div>
        </div>
        <footer>
          {selection.pkg.id === "imagegen" && onConfigureImages ? (
            <Button
              data-extension-configure-images
              variant="outline"
              className="ml-auto rounded-full"
              onClick={onConfigureImages}
            >
              配置生图模型
            </Button>
          ) : null}
          {selection.pkg.kind === "plugin" ? (
            <Button className="rounded-full" onClick={onClose}>
              {locale === "en-US" ? "Close" : "关闭"}
            </Button>
          ) : (
            <Button
              className="rounded-full"
              disabled={
                busy ||
                !revision ||
                !!error ||
                (selection.pkg.installed && !extensionSkillEnabled(selection.pkg, selection.skill))
              }
              onClick={selection.pkg.installed ? onTry : onInstall}
            >
              <SquarePen className="size-4" />
              {selection.pkg.installed
                ? locale === "en-US"
                  ? "Try in chat"
                  : "在对话中使用"
                : locale === "en-US"
                  ? "Install skill"
                  : "安装技能"}
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
