import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { DiffSquare, Eye, FileText, Globe, Loader2, X } from "@liveagent/ui/components/IconSet";
import type {
  WorkspaceBrowserTools,
  WorkspaceFileChrome,
} from "@liveagent/ui/components/project-tools/RightDockPanel";
import type { RightDockWorkspaceTab } from "@liveagent/ui/components/project-tools/RightDockTabStrip";
import {
  WorkspaceFileDiff,
  WorkspaceGitComparisonMenu,
} from "@liveagent/ui/components/project-tools/WorkspaceFileDiff";
import { Button } from "@liveagent/ui/components/ui/button";
import { ContextMenuItem } from "@liveagent/ui/components/ui/context-menu";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import { Input } from "@liveagent/ui/components/ui/input";
import { TooltipButton } from "@liveagent/ui/components/ui/tooltip-button";
import type { WorkspaceFileEditorHandle } from "@liveagent/ui/components/workspace-editor/WorkspaceCodeEditorOverlay";
import type { WorkspaceDocumentRevision } from "@liveagent/ui/components/workspace-editor/WorkspaceFilePreviewOverlay";
import {
  WorkspaceFileEditor,
  WorkspaceFileReader,
} from "@liveagent/ui/components/workspace-editor/WorkspaceOverlayHost";
import {
  getWorkspacePreviewKind,
  isWorkspaceEditablePreviewPath,
  isWorkspacePreviewPath,
} from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import {
  workspaceImageAbsolutePathForCopy,
  workspaceImageRelativePathForCopy,
} from "@liveagent/ui/components/workspace-editor/workspaceImageViewer";
import { classifyWorkspaceMarkdownTarget } from "@liveagent/ui/components/workspace-editor/workspaceMarkdownAssets";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ProjectToolTextGenerationClient } from "@liveagent/ui/lib/ai/projectToolTextGeneration";
import type { CodeMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { GitClient } from "@liveagent/ui/lib/git/types";
import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";
import type { WorkspaceActivityClient } from "@liveagent/ui/lib/workspace-activity/types";
import {
  type ComponentProps,
  lazy,
  Suspense,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import CodeIcon from "~icons/lucide/code-xml";
import { DesktopWorkspaceFileHeader, workspaceFileName } from "./DesktopWorkspaceFileHeader";
import type {
  DesktopWorkspaceTab,
  useDesktopWorkspaceTabs,
  WorkspaceFileMode,
} from "./useDesktopWorkspaceTabs";

const BrowserPane = lazy(async () => ({
  default: (await import("../../../components/workbench-browser/WorkbenchBrowserPane"))
    .WorkbenchBrowserPane,
}));

type BrowserAnnotation = Parameters<
  NonNullable<ComponentProps<typeof BrowserPane>["onAnnotate"]>
>[0];
type Resources = ReturnType<typeof useDesktopWorkspaceTabs>;
type DetachedAnnotationTarget = { scope: string; owner: string; tabId: string };

type TabOptions = {
  resources: Resources;
  open: boolean;
  scope: string;
  owner: string;
  comparisonConversationId?: string;
  projectPathKey: string;
  browserSshTargets?: readonly { id: string; label: string }[];
  theme: "light" | "dark";
  gitClient?: GitClient;
  activityClient: WorkspaceActivityClient;
  onInsertCodeMention: (reference: CodeMentionReference) => void;
  onInsertMarkdownSelection?: (text: string, path: string, comment?: string) => boolean;
  markdownTextGeneration?: ProjectToolTextGenerationClient;
  onDocumentRevision?: (revision: WorkspaceDocumentRevision) => Promise<boolean>;
  onBrowserAnnotation?: (
    annotation: BrowserAnnotation,
    detached?: DetachedAnnotationTarget,
  ) => void | Promise<void>;
  onError: (message: string) => void;
};

export function useDesktopWorkspaceTabPresentation(options: TabOptions) {
  const { resources, open, scope, owner, onBrowserAnnotation, onError } = options;
  const { locale, t } = useLocale();
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const [rename, setRename] = useState<{
    scope: string;
    owner: string;
    id: string;
    value: string;
  } | null>(null);
  const currentRename = rename?.scope === scope && rename.owner === owner ? rename : null;
  const browserName = copy("新标签页", "New tab");
  const tabs: RightDockWorkspaceTab[] = resources.view.tabs.map((tab) => {
    const onActivate = () => resources.activate(tab.id);
    if (tab.kind === "file") {
      return {
        id: tab.id,
        label: workspaceFileName(tab.request.path),
        icon: <FileText className="size-3.5 shrink-0" />,
        dirty: tab.dirty,
        temporary: tab.temporary,
        onKeepOpen: () => resources.keepFileOpen(tab.id),
        onActivate,
        onClose: () => resources.requestCloseFile(tab.id),
        menuItems: (
          <ContextMenuItem
            onSelect={() =>
              void copyTextToClipboard(
                workspaceImageAbsolutePathForCopy(tab.request.workdir, tab.request.path),
              )
            }
          >
            {copy("复制文件路径", "Copy file path")}
          </ContextMenuItem>
        ),
      };
    }
    const label = tab.customTitle || tab.title || tab.url || browserName;
    const runExternal = () => {
      void openUrl(tab.url).catch(() =>
        onError(
          copy("无法在系统浏览器打开此网页", "Could not open the page in the system browser"),
        ),
      );
    };
    return {
      id: tab.id,
      label,
      icon: <Globe className="size-3.5 shrink-0" />,
      onActivate,
      onClose: () => resources.close(tab.id),
      menuItems: (
        <>
          <ContextMenuItem onSelect={() => resources.openBrowser("", tab.id)}>
            {copy("在右侧新建标签", "New tab to the right")}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!tab.url}
            onSelect={() =>
              resources.updateBrowser(tab.id, { reloadToken: (tab.reloadToken ?? 0) + 1 }, scope)
            }
          >
            {copy("重新加载", "Reload")}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() =>
              resources.openBrowser(
                tab.url,
                tab.id,
                true,
                scope,
                tab.history?.index != null ? tab.history : undefined,
              )
            }
          >
            {copy("复制标签", "Duplicate tab")}
          </ContextMenuItem>
          <ContextMenuItem disabled={!tab.url} onSelect={() => void copyTextToClipboard(tab.url)}>
            {copy("复制网址", "Copy URL")}
          </ContextMenuItem>
          <ContextMenuItem disabled={!tab.url} onSelect={runExternal}>
            {copy("在系统浏览器中打开", "Open in system browser")}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => setRename({ scope, owner, id: tab.id, value: tab.customTitle ?? "" })}
          >
            {copy("重命名", "Rename")}
          </ContextMenuItem>
        </>
      ),
    };
  });

  const renderContent = (browserTools: WorkspaceBrowserTools, fileChrome: WorkspaceFileChrome) => (
    <>
      {[...resources.views].flatMap(([tabScope, view]) =>
        view.tabs.map((tab) => {
          const active = open && tabScope === scope && resources.view.activeId === tab.id;
          return (
            <div
              key={JSON.stringify([owner, tabScope, tab.id])}
              hidden={!active}
              inert={!active}
              className={active ? "absolute inset-0 flex min-h-0 flex-col" : "hidden"}
              data-desktop-workspace-resource={tab.kind}
            >
              {tab.kind === "browser" ? (
                <Suspense fallback={null}>
                  <BrowserPane
                    id={tab.id}
                    newTabTools={browserTools}
                    visits={view.tabs.filter((entry) => entry.kind === "browser")}
                    scope={owner}
                    projectPathKey={tabScope === scope ? options.projectPathKey : undefined}
                    sshTargets={tabScope === scope ? options.browserSshTargets : undefined}
                    url={tab.url}
                    history={tab.history}
                    active={active}
                    reloadToken={tab.reloadToken}
                    onNavigate={(url, title) =>
                      resources.updateBrowser(
                        tab.id,
                        { url, ...(title === undefined ? {} : { title }) },
                        tabScope,
                      )
                    }
                    onHistory={(history) => resources.updateBrowser(tab.id, { history }, tabScope)}
                    onOpenTab={(url, foreground = true) =>
                      resources.openBrowser(url, tab.id, foreground, tabScope)
                    }
                    onAnnotate={active ? onBrowserAnnotation : undefined}
                    onDetachedAnnotate={
                      active && onBrowserAnnotation
                        ? (annotations) =>
                            onBrowserAnnotation(annotations, {
                              scope: tabScope,
                              owner,
                              tabId: tab.id,
                            })
                        : undefined
                    }
                  />
                </Suspense>
              ) : (
                <WorkspaceFileTabPane
                  options={options}
                  tab={tab}
                  scope={tabScope}
                  active={active}
                  chrome={fileChrome}
                />
              )}
            </div>
          );
        }),
      )}
      {currentRename && (
        <Dialog
          open
          onOpenChange={(next) => {
            if (!next) setRename(null);
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>{copy("重命名网页标签", "Rename browser tab")}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  resources.updateBrowser(
                    currentRename.id,
                    { customTitle: currentRename.value.trim() || undefined },
                    scope,
                  );
                  setRename(null);
                }}
              >
                <Input
                  aria-label={copy("标签名称", "Tab name")}
                  value={currentRename.value}
                  maxLength={120}
                  onChange={(event) => setRename({ ...currentRename, value: event.target.value })}
                />
                <DialogActions className="mt-3">
                  <Button type="button" variant="secondary" onClick={() => setRename(null)}>
                    {t("settings.cancel")}
                  </Button>
                  <Button type="submit">{copy("保存", "Save")}</Button>
                </DialogActions>
              </form>
            </DialogBody>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
  const browserActive = resources.view.tabs.some(
    (tab) => tab.kind === "browser" && tab.id === resources.view.activeId,
  );
  return { tabs, browserActive, renderContent };
}

function WorkspaceFileTabPane({
  options,
  tab,
  scope,
  active,
  chrome,
}: {
  options: TabOptions;
  tab: Extract<DesktopWorkspaceTab, { kind: "file" }>;
  scope: string;
  active: boolean;
  chrome: WorkspaceFileChrome;
}) {
  const { locale } = useLocale();
  const { request, mode, openedModes } = tab;
  const {
    resources,
    theme,
    gitClient,
    comparisonConversationId,
    activityClient,
    onDocumentRevision,
    onInsertCodeMention,
    onInsertMarkdownSelection,
    projectPathKey,
  } = options;
  const viewId = JSON.stringify([scope, tab.id]);
  const canPreview = isWorkspacePreviewPath(request.path);
  const canEdit = !canPreview || isWorkspaceEditablePreviewPath(request.path);
  const workspacePath = workspaceImageRelativePathForCopy(request.workdir, request.path);
  const liveMarkdown =
    getWorkspacePreviewKind(request.path) === "markdown" &&
    !request.remote &&
    !!workspacePath &&
    !/^(?:[/\\@]|[a-z]:)/i.test(workspacePath) &&
    !workspacePath.split("/").includes("..");
  const canDiff = Boolean(gitClient && request.projectPathKey === projectPathKey);
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const currentMode = useRef<WorkspaceFileMode | null>(null);
  const returnMode = useRef<WorkspaceFileMode>(canPreview ? "preview" : "source");
  useLayoutEffect(() => {
    currentMode.current = active ? mode : null;
    if (mode !== "diff") returnMode.current = mode;
    return () => {
      currentMode.current = null;
    };
  }, [active, mode]);
  const editorHandle = useRef<WorkspaceFileEditorHandle>(null);
  const [formatTools, setFormatTools] = useState<HTMLDivElement | null>(null);
  const [diffNavigation, setDiffNavigation] = useState<HTMLDivElement | null>(null);
  const [diffActions, setDiffActions] = useState<HTMLDivElement | null>(null);
  const [switching, setSwitching] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const previewRequest = useMemo(
    () => ({ ...request, id: request.id + previewRevision }),
    [request, previewRevision],
  );
  const close = () => resources.requestCloseFile(tab.id);
  const openMode = async (next: WorkspaceFileMode) => {
    if (mode === next || switching || !active) return;
    if ((mode === "source" || (liveMarkdown && mode === "preview")) && editorHandle.current) {
      setSwitching(true);
      try {
        if (!(await editorHandle.current.saveForModeChange()) || currentMode.current !== mode)
          return;
      } finally {
        setSwitching(false);
      }
    }
    resources.openFile(request, next, tab.temporary);
  };
  const comparison = resources.views.get(scope)?.comparison ?? resources.view.comparison;
  const viewSource = copy("查看源代码", "View source");
  const viewPreview = copy("查看预览", "View preview");
  const showChanges = copy("显示更改", "Show changes");
  const hideChanges = copy("隐藏更改", "Hide changes");
  const markdownSelectionActions =
    active && mode === "preview" && onInsertMarkdownSelection
      ? {
          onAddToChat: (text: string, comment?: string) =>
            onInsertMarkdownSelection(text, request.path, comment),
          onEditSource: async (line: number, column: number) => {
            if (liveMarkdown && !(await editorHandle.current?.saveForModeChange())) return;
            if (currentMode.current !== "preview") return;
            resources.openFile(
              { ...request, line, column, endLine: undefined },
              "source",
              tab.temporary,
            );
          },
        }
      : undefined;
  const showEditor = mode === "source" || (liveMarkdown && mode === "preview");
  const openRelatedFile = (path: string) =>
    resources.openFile(
      { projectPathKey: request.projectPathKey, workdir: request.workdir, path },
      isWorkspacePreviewPath(path) ? "preview" : "source",
      true,
    );
  const openMarkdownLink = (href: string) => {
    if (currentMode.current !== "preview") return false;
    const target = classifyWorkspaceMarkdownTarget(workspacePath, href);
    if (target.kind === "workspace") {
      if (target.path.split(/[/\\]/).some((part) => !part || part === "." || part === ".."))
        return false;
      openRelatedFile(target.path);
      return true;
    }
    if (target.kind !== "external") return false;
    let url: URL;
    try {
      url = new URL(target.url);
    } catch {
      return false;
    }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
      return false;
    void openUrl(url.href).catch(() =>
      options.onError(copy("无法打开链接", "Could not open link")),
    );
    return true;
  };
  const modeActions = (
    <>
      {mode === "diff" && gitClient && (
        <WorkspaceGitComparisonMenu
          client={gitClient}
          workdir={request.workdir}
          comparison={comparison}
          conversationId={comparisonConversationId}
          onComparisonChange={resources.setComparison}
          capsule
        />
      )}
      {(canDiff || mode === "diff") && (
        <TooltipButton
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2 text-xs"
          aria-label={mode === "diff" ? hideChanges : showChanges}
          tooltip={mode === "diff" ? hideChanges : showChanges}
          disabled={switching}
          onClick={() => void openMode(mode === "diff" ? returnMode.current : "diff")}
        >
          {mode === "diff" ? (
            <X aria-hidden="true" className="size-3.5" />
          ) : (
            <DiffSquare aria-hidden="true" className="size-3.5" />
          )}
          {mode !== "diff" && <span className="za-workspace-file-action-label">{showChanges}</span>}
        </TooltipButton>
      )}
      {mode === "diff" && <div ref={setDiffNavigation} className="empty:hidden" />}
    </>
  );
  const viewAction =
    canPreview && canEdit ? (
      <TooltipButton
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-xs"
        aria-label={mode === "source" ? viewPreview : viewSource}
        aria-busy={switching}
        tooltip={mode === "source" ? viewPreview : viewSource}
        disabled={switching}
        onClick={() => void openMode(mode === "source" ? "preview" : "source")}
      >
        {switching ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        ) : mode !== "source" ? (
          <CodeIcon aria-hidden="true" className="size-3.5" />
        ) : (
          <Eye aria-hidden="true" className="size-3.5" />
        )}
        <span className="za-workspace-file-action-label">
          {mode === "source" ? viewPreview : viewSource}
        </span>
      </TooltipButton>
    ) : null;

  const fileHeader = active ? (
    <DesktopWorkspaceFileHeader
      gitClient={canDiff ? gitClient : undefined}
      active={active}
      request={request}
      modeActions={modeActions}
      viewAction={viewAction}
      comparisonActions={mode === "diff" && <div ref={setDiffActions} className="empty:hidden" />}
      fileTree={chrome.tree}
      editorTools={showEditor}
      setFormatTools={setFormatTools}
      onOpenFile={openRelatedFile}
      onError={options.onError}
      readDraft={() => editorHandle.current?.readDraft()}
      beforeOpen={async () => {
        if (switching || currentMode.current !== mode) return false;
        if (showEditor && editorHandle.current) {
          if (!(await editorHandle.current.saveForModeChange())) return false;
        }
        return currentMode.current === mode;
      }}
    />
  ) : null;

  return (
    <>
      {fileHeader &&
        (chrome.headerTarget ? createPortal(fileHeader, chrome.headerTarget) : fileHeader)}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {openedModes.includes("preview") && !liveMarkdown && (
          <div
            hidden={mode !== "preview"}
            inert={mode !== "preview"}
            className={mode === "preview" ? "absolute inset-0 flex min-h-0 flex-col" : "hidden"}
          >
            <WorkspaceFileReader
              tabbed
              tabbedToolbarTarget={active && mode === "preview" ? formatTools : null}
              locale={locale}
              readingViewId={viewId}
              isOpen
              openRequest={previewRequest}
              onOpenHTMLLink={
                active && mode === "preview"
                  ? (link) => {
                      if (link.kind === "file") openRelatedFile(link.path);
                      else openMarkdownLink(link.url);
                    }
                  : undefined
              }
              markdownSelectionActions={markdownSelectionActions}
              onOpenEditor={() => void openMode("source")}
              onRequestClose={close}
              onClose={() => undefined}
              onRequestRevision={
                onDocumentRevision &&
                ((revision) =>
                  onDocumentRevision({
                    ...revision,
                    assertCurrent: () => {
                      if (currentMode.current !== "preview")
                        throw new Error("The reader is no longer active.");
                      revision.assertCurrent();
                    },
                  }))
              }
            />
          </div>
        )}
        {(openedModes.includes("source") || (liveMarkdown && openedModes.includes("preview"))) && (
          <div
            hidden={!showEditor}
            inert={!showEditor}
            className={showEditor ? "absolute inset-0" : "hidden"}
          >
            <WorkspaceFileEditor
              embedded
              embeddedToolbarTarget={active && showEditor ? formatTools : null}
              embeddedMarkdownMode={
                liveMarkdown
                  ? mode === "preview" || (mode === "diff" && returnMode.current === "preview")
                    ? "preview"
                    : "source"
                  : undefined
              }
              markdownSelectionActions={markdownSelectionActions}
              onOpenMarkdownLink={openMarkdownLink}
              markdownTextGeneration={options.markdownTextGeneration}
              editorHandle={editorHandle}
              onFileSaved={() => setPreviewRevision((revision) => revision + 1)}
              finalCloseRequested
              showDialogs={active}
              viewScope={viewId}
              theme={theme}
              isOpen={active && showEditor}
              openRequest={request}
              closeRequestId={tab.closeRequestId}
              onDirtyChange={(dirty) => resources.setFileDirty(tab.id, dirty, scope)}
              onPreviewFile={() => void openMode("preview")}
              onInsertCodeMention={onInsertCodeMention}
              onHide={close}
              onClose={() => resources.close(tab.id, scope)}
            />
          </div>
        )}
        {openedModes.includes("diff") && gitClient && (
          <div
            hidden={mode !== "diff"}
            inert={mode !== "diff"}
            className={mode === "diff" ? "absolute inset-0 flex min-h-0 flex-col" : "hidden"}
          >
            <WorkspaceFileDiff
              active={active && mode === "diff"}
              comparison={comparison}
              conversationId={comparisonConversationId}
              fileToolbar={{ navigation: diffNavigation, actions: diffActions }}
              onComparisonChange={resources.setComparison}
              workdir={request.workdir}
              path={request.path}
              client={gitClient}
              workspaceActivityClient={activityClient}
            />
          </div>
        )}
      </div>
    </>
  );
}
