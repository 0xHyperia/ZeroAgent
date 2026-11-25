// GitReview panel assembly: reads the right-dock tool context, owns the
// layout/presentation state shared across views and composes the toolbar,
// status view and history view around the data layer.
//
// Shared implementation owned by @liveagent/ui. Host-specific Git operations
// and optional platform capabilities enter through the shared contracts.

import "@liveagent/ui/i18n/namespaces/gitReview";
import { useLocale } from "@liveagent/ui/i18n/index";
import { memo, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../../ui/button";
import { useRightDockToolContext } from "../RightDockContext";
import { WorkspaceFileDiff } from "../WorkspaceFileDiff";
import { GitReviewHistoryView } from "./HistoryView";
import type { ChangeListSection, DiffViewKind, GitReviewStackedPane } from "./model";
import { GitReviewStatusView } from "./StatusView";
import { GitOperationNoticeToast, GitRemoteSetupModal, GitReviewToolbar } from "./Toolbar";
import { useGitReviewData } from "./useGitReviewData";

export type { GitCommitContextPayload, GitFileContextPayload } from "./model";

const GIT_REVIEW_SPLIT_LAYOUT_MIN_WIDTH = 500;

type GitReviewPanelProps = {
  // Visibility contract from the right-dock registry: while inactive the
  // panel issues no requests (invalidations are buffered and flushed on
  // activation by the data layer).
  active?: boolean;
};

export const GitReviewPanel = memo(function GitReviewPanel(props: GitReviewPanelProps) {
  const context = useRightDockToolContext();
  if (context.git.workspaceReview && context.clients.git)
    return <WorkspaceReviewPanel active={props.active} />;
  return <GitReviewOperationsPanel {...props} />;
});

function WorkspaceReviewPanel({ active = true }: GitReviewPanelProps) {
  const { clients, cwd, git } = useRightDockToolContext();
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [operations, setOperations] = useState(false);
  const review = git.workspaceReview;
  if (!review || !clients.git) return null;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div hidden={operations} className="min-h-0 flex-1">
        <WorkspaceFileDiff
          active={active && !operations}
          client={clients.git}
          workdir={cwd}
          comparison={review.comparison}
          conversationId={review.conversationId}
          onComparisonChange={review.onComparisonChange}
          onOpenFile={review.onOpenFile}
          tree={review.tree}
          fileJumpRef={review.fileJumpRef}
          headerTarget={review.headerTarget}
          onReviewStateChange={review.onStateChange}
          workspaceActivityClient={clients.workspaceActivity ?? undefined}
          onInsertComposerSegments={git.onInsertComposerSegments}
          onOpenGitActions={() => setOperations(true)}
        />
      </div>
      {operations && (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center border-b border-border/70 px-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setOperations(false)}
            >
              {zh ? "返回审查" : "Back to review"}
            </Button>
          </div>
          <div className="min-h-0 flex-1">
            <GitReviewOperationsPanel active={active} />
          </div>
        </div>
      )}
    </div>
  );
}

const GitReviewOperationsPanel = memo(function GitReviewOperationsPanel(
  props: GitReviewPanelProps,
) {
  const { active = true } = props;
  const { t } = useLocale();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [useSplitReviewLayout, setUseSplitReviewLayout] = useState(false);
  const [activeDiffView, setActiveDiffView] = useState<DiffViewKind>("workingTree");
  const [commitMessage, setCommitMessage] = useState("");
  const [collapsedChangeSections, setCollapsedChangeSections] = useState<
    Record<ChangeListSection, boolean>
  >({
    staged: false,
    changes: false,
  });
  const [changesStackedPane, setChangesStackedPane] = useState<GitReviewStackedPane>("list");
  const [historyStackedPane, setHistoryStackedPane] = useState<GitReviewStackedPane>("list");

  const data = useGitReviewData({ active });
  const { busy, canWrite, cwd, disabledMessage, reviewMode, state } = data;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    const updateLayout = () => {
      const nextUseSplitLayout =
        panel.getBoundingClientRect().width >= GIT_REVIEW_SPLIT_LAYOUT_MIN_WIDTH;
      setUseSplitReviewLayout((current) =>
        current === nextUseSplitLayout ? current : nextUseSplitLayout,
      );
    };

    updateLayout();
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateLayout);
    resizeObserver?.observe(panel);
    window.addEventListener("resize", updateLayout);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", updateLayout);
    };
  }, []);

  const writeDisabled = !canWrite || Boolean(disabledMessage) || state.status !== "ready";
  const visibleError =
    reviewMode === "history"
      ? data.historyCommits.length === 0
        ? data.historyError
        : ""
      : data.error;

  const handleToggleSection = useCallback((section: ChangeListSection) => {
    setCollapsedChangeSections((current) => ({
      ...current,
      [section]: !current[section],
    }));
  }, []);

  const handleChangesStackedPaneChange = useCallback((pane: GitReviewStackedPane) => {
    setChangesStackedPane(pane);
  }, []);

  const handleHistoryStackedPaneChange = useCallback((pane: GitReviewStackedPane) => {
    setHistoryStackedPane(pane);
  }, []);

  const handleToolbarStackedPaneChange = useCallback(
    (pane: GitReviewStackedPane) => {
      if (data.reviewMode === "changes") {
        setChangesStackedPane(pane);
      } else {
        setHistoryStackedPane(pane);
      }
    },
    [data.reviewMode],
  );

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 flex-col bg-background">
      <GitRemoteSetupModal
        open={data.remoteSetupOpen}
        action={data.remoteSetupAction}
        workdir={cwd}
        branch={state.head || t("projectTools.gitReview.unresolved")}
        remoteUrl={data.remoteSetupUrl}
        loading={busy === "set_remote"}
        error={data.remoteSetupError}
        onRemoteUrlChange={data.setRemoteSetupUrl}
        onClose={data.closeRemoteSetup}
        onSubmit={data.saveRemoteAndContinue}
      />
      <GitOperationNoticeToast
        notice={data.operationNotice}
        onDismiss={data.dismissOperationNotice}
      />
      <GitReviewToolbar
        data={data}
        stackedPane={reviewMode === "changes" ? changesStackedPane : historyStackedPane}
        onStackedPaneChange={handleToolbarStackedPaneChange}
        useSplitReviewLayout={useSplitReviewLayout}
        visibleError={visibleError}
        writeDisabled={writeDisabled}
      />
      {reviewMode === "changes" ? (
        <GitReviewStatusView
          activeDiffView={activeDiffView}
          collapsedSections={collapsedChangeSections}
          commitMessage={commitMessage}
          data={data}
          onActiveDiffViewChange={setActiveDiffView}
          onCommitMessageChange={setCommitMessage}
          onStackedPaneChange={handleChangesStackedPaneChange}
          onToggleSection={handleToggleSection}
          panelRef={panelRef}
          stackedPane={changesStackedPane}
          useSplitReviewLayout={useSplitReviewLayout}
          writeDisabled={writeDisabled}
        />
      ) : (
        <GitReviewHistoryView
          data={data}
          onStackedPaneChange={handleHistoryStackedPaneChange}
          panelRef={panelRef}
          stackedPane={historyStackedPane}
          useSplitReviewLayout={useSplitReviewLayout}
          writeDisabled={writeDisabled}
        />
      )}
    </div>
  );
});
