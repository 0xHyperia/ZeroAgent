import {
  ArrowLeft,
  Download,
  History,
  Info,
  MessageSquare,
} from "@liveagent/ui/components/IconSet";
import { resourcePreviewKind } from "@liveagent/ui/components/resource-preview/previewPolicy";
import type { DocumentRevisionComment } from "@liveagent/ui/components/resource-preview/ResourceDocumentComments";
import { ResourcePreview } from "@liveagent/ui/components/resource-preview/ResourcePreview";
import {
  ResourceDeleteDialog,
  ResourceInspector,
  ResourceTitleMenu,
} from "@liveagent/ui/components/resource-preview/ResourceReaderDetails";
import { ResourceVersionTimeline } from "@liveagent/ui/components/resource-preview/ResourceVersionTimeline";
import { Button, buttonVariants } from "@liveagent/ui/components/ui/button";
import { DropdownMenuItem } from "@liveagent/ui/components/ui/dropdown-menu";
import { TooltipButton as ReaderAction } from "@liveagent/ui/components/ui/tooltip-button";
import { useLocale } from "@liveagent/ui/i18n";
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import {
  CloudChatArtifactError,
  type CloudChatArtifactsClient,
  type CloudChatArtifactVersion,
  cloudArtifactSize,
  cloudArtifactStatus,
} from "@/lib/cloudChatArtifacts";
import { CloudChatFeedback } from "./CloudChatFeedback";
import { CloudChatResourcePanel } from "./CloudChatResourcePanel";
import { CloudChatSiteView } from "./CloudChatSiteView";
import {
  CloudReaderOpening,
  type CloudReaderOpeningFailure,
  cloudReaderOpeningFailure,
} from "./CloudReaderOpening";
import { WorkspaceHandoffMenuItem, type WorkspaceHandoffSource } from "./WorkspaceHandoffDialog";

type Props = {
  onRequestRevision?: (
    resource: CloudChatArtifactVersion,
    comments: readonly DocumentRevisionComment[],
  ) => Promise<boolean>;
  client: CloudChatArtifactsClient;
  conversationId?: string;
  initialVersionId?: string;
  initialSite?: boolean;
  siteAction?: "share" | "settings";
  siteName?: string;
  onSiteRename?: (name: string) => Promise<void>;
  onHandoff?: (source: WorkspaceHandoffSource) => void;
  isCurrent: () => boolean;
  onClose: () => void;
  onDeleted?: (familyId: string) => void;
  onVersionRestored?: () => void;
  onVersionChange?: (versionId: string) => void;
  onOpenSourceRun?: (
    version: CloudChatArtifactVersion,
    revise: boolean,
    signal: AbortSignal,
  ) => Promise<void>;
  // biome-ignore lint/suspicious/noConfusingVoidType: existing hosts return void; false explicitly rejects a reference.
  onContinue?: (version: CloudChatArtifactVersion) => boolean | void;
  workFromSpace?: boolean;
  workActive?: boolean;
  onError?: (cause: unknown) => void;
};
const buttonClass = buttonVariants({ variant: "outline", size: "sm" });
type FamilyHistory = {
  familyId: string;
  versions: CloudChatArtifactVersion[];
  cursor: string;
  pending: boolean;
  failure?: "first" | "older" | "changed";
};
type VersionAttempt = {
  id: string;
  updateLocation: boolean;
  failure: CloudReaderOpeningFailure;
  retrying: boolean;
};

export function CloudChatArtifactsPanel(props: Props) {
  const { client, conversationId, initialVersionId } = props;
  const { locale } = useLocale();
  const copy = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const [versions, setVersions] = useState<CloudChatArtifactVersion[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [selected, setSelected] = useState<CloudChatArtifactVersion | null>(null);
  const [openingVersionId, setOpeningVersionId] = useState("");
  const [openingFailure, setOpeningFailure] = useState<CloudReaderOpeningFailure | null>(null);
  const retryButton = useRef<HTMLElement>(null);
  const readerFocus = useRef<HTMLElement>(null);
  const restoreRetryFocus = useRef(false);
  const [versionAttempt, setVersionAttempt] = useState<VersionAttempt | null>(null);
  const versionRequest = useRef<number | null>(null);
  const versionRetryButton = useRef<HTMLButtonElement>(null);
  const selectedVersionRow = useRef<HTMLButtonElement>(null);
  const restoreVersionFocus = useRef(false);
  const [sitePreviewId, setSitePreviewId] = useState("");
  const restoreInFlight = useRef(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreRequest, setRestoreRequest] = useState<{
    requestId: string;
    source: CloudChatArtifactVersion;
    head: string;
  } | null>(null);
  const [familyHistory, setFamilyHistory] = useState<FamilyHistory>();
  const familyRequest = useRef<AbortController | null>(null);
  const [scope, setScope] = useState<"conversation" | "account">(
    conversationId ? "conversation" : "account",
  );
  const [busy, setBusy] = useState(Boolean(initialVersionId)),
    [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [sourceAttempt, setSourceAttempt] = useState<{
    versionId: string;
    revise: boolean;
    status: "opening" | "retrying" | "failed";
  }>();
  const sourceOpening = useRef(false);
  const [confirmDelete, setConfirmDelete] = useState<CloudChatArtifactVersion | null>(null);
  const deleteLock = useRef(false);
  const uncertainDeletions = useRef(new Set<string>());
  const [inspector, setInspector] = useState<"details" | "history" | null>(null);
  const mounted = useRef(true),
    generation = useRef(0),
    abort = useRef(new AbortController());
  const metadataGuard = useRef<(() => void) | null>(null),
    currentProps = useRef(props);
  currentProps.current = props;
  const selectedFamilyId = selected?.family_id;
  const history = familyHistory?.familyId === selectedFamilyId ? familyHistory : undefined;
  const historyHead =
    history?.pending || history?.failure === "first" || history?.failure === "changed"
      ? undefined
      : history?.versions[0];
  const canRestoreVersion =
    historyHead?.state === "ready" &&
    selected?.state === "ready" &&
    historyHead.number > selected.number &&
    !/\.zip$/i.test(selected.name);
  function valid() {
    return mounted.current && currentProps.current.isCurrent();
  }
  function report(cause: unknown) {
    if (valid()) {
      setError(cause instanceof Error ? cause.message : "成果操作失败。");
      currentProps.current.onError?.(cause);
    }
  }
  async function loadList(nextScope: "conversation" | "account" = scope, before = "") {
    const seq = ++generation.current,
      guard = captureAccountRequestGuard();
    setBusy(true);
    setOpeningVersionId("");
    setOpeningFailure(null);
    setError("");
    setSourceAttempt(undefined);
    setVersionAttempt(null);
    setSelected(null);
    setScope(nextScope);
    if (!before) {
      setVersions([]);
      setNextCursor("");
    }
    try {
      const list = await client.list({
        conversationId: nextScope === "conversation" ? conversationId : undefined,
        before: before || undefined,
        signal: abort.current.signal,
      });
      guard();
      if (!valid() || generation.current !== seq) return;
      metadataGuard.current = guard;
      setVersions((current) =>
        before
          ? [...current, ...list.versions].filter(
              (version, index, all) => all.findIndex((other) => other.id === version.id) === index,
            )
          : list.versions,
      );
      setNextCursor(list.nextCursor);
    } catch (cause) {
      if (generation.current === seq && !abort.current.signal.aborted) report(cause);
    } finally {
      if (valid() && generation.current === seq) setBusy(false);
    }
  }
  async function loadFamilyHistory(familyId: string, cursor = "") {
    if (!valid() || familyRequest.current) return;
    const guard = captureAccountRequestGuard();
    const controller = new AbortController();
    familyRequest.current = controller;
    setFamilyHistory((old) =>
      old?.familyId === familyId
        ? { ...old, pending: true }
        : { familyId, versions: [], cursor: "", pending: true },
    );
    try {
      const page = await client.list({
        familyId,
        before: cursor || undefined,
        limit: 50,
        signal: controller.signal,
      });
      guard();
      if (!valid() || controller.signal.aborted) return;
      setFamilyHistory((old) => {
        const items = new Map(
          (cursor && old?.familyId === familyId ? old.versions : []).map((item) => [item.id, item]),
        );
        for (const item of page.versions) items.set(item.id, item);
        return {
          familyId,
          versions: [...items.values()].sort((left, right) => right.number - left.number),
          cursor: page.nextCursor,
          pending: false,
        };
      });
    } catch (cause) {
      if (!valid() || controller.signal.aborted) return;
      try {
        guard();
      } catch {
        return;
      }
      const failure = cursor
        ? cause instanceof CloudChatArtifactError && cause.status === 404
          ? "changed"
          : "older"
        : "first";
      setFamilyHistory((old) =>
        old?.familyId === familyId ? { ...old, pending: false, failure } : old,
      );
      if (cause instanceof CloudChatArtifactError && cause.status === 401)
        currentProps.current.onError?.(cause);
    } finally {
      if (familyRequest.current === controller) familyRequest.current = null;
    }
  }
  const readFamilyHistory = useEffectEvent(loadFamilyHistory);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new client retires the previous history transport.
  useEffect(() => {
    if (!selectedFamilyId) return;
    void readFamilyHistory(selectedFamilyId);
    return () => {
      familyRequest.current?.abort();
      familyRequest.current = null;
    };
  }, [client, selectedFamilyId]);

  async function showVersion(versionId: string, updateLocation = false, retry?: VersionAttempt) {
    const seq = ++generation.current,
      guard = captureAccountRequestGuard();
    const openingLink = initialVersionId === versionId && !selected;
    versionRequest.current = seq;
    setBusy(true);
    setOpeningVersionId(versionId);
    setError("");
    setSourceAttempt(undefined);
    setVersionAttempt(retry ? { ...retry, retrying: true } : null);
    try {
      const version = await client.get(versionId, abort.current.signal);
      guard();
      if (!valid() || generation.current !== seq) return;
      metadataGuard.current = guard;
      uncertainDeletions.current.delete(version.family_id);
      if (openingLink) {
        restoreRetryFocus.current = document.activeElement === retryButton.current;
        setOpeningFailure(null);
      }
      if (retry) {
        restoreVersionFocus.current = document.activeElement === versionRetryButton.current;
        setVersionAttempt(null);
      }
      setSelected(version);
      if (updateLocation) {
        if (currentProps.current.initialSite) setInspector("history");
        currentProps.current.onVersionChange?.(version.id);
      }
    } catch (cause) {
      if (!valid() || generation.current !== seq || abort.current.signal.aborted) return;
      const failure = cloudReaderOpeningFailure(
        cause instanceof CloudChatArtifactError ? cause.status : undefined,
      );
      if (openingLink) {
        setOpeningFailure(failure);
      } else {
        setVersionAttempt({ id: versionId, updateLocation, failure, retrying: false });
      }
      currentProps.current.onError?.(cause);
    } finally {
      if (versionRequest.current === seq) versionRequest.current = null;
      if (valid() && generation.current === seq) {
        setOpeningVersionId("");
        setBusy(false);
      }
    }
  }
  // The parent keys this controlled panel to its owner/view; callbacks are live refs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: requests belong to one panel target lifetime
  useEffect(() => {
    mounted.current = true;
    abort.current = new AbortController();
    if (initialVersionId) void showVersion(initialVersionId);
    else void loadList(conversationId ? "conversation" : "account");
    return () => {
      mounted.current = false;
      generation.current++;
      abort.current.abort();
    };
  }, [client, conversationId, initialVersionId]);
  useLayoutEffect(() => {
    if (
      !selected ||
      versionAttempt?.retrying ||
      (!restoreRetryFocus.current && !restoreVersionFocus.current)
    )
      return;
    const target = restoreVersionFocus.current ? selectedVersionRow.current : null;
    restoreRetryFocus.current = false;
    restoreVersionFocus.current = false;
    if (
      document.activeElement === document.body ||
      document.activeElement === document.documentElement
    )
      (target ?? readerFocus.current)?.focus({ preventScroll: true });
  }, [selected, versionAttempt]);

  async function removeConfirmedFamily() {
    const target = confirmDelete;
    if (
      !target ||
      !valid() ||
      deleteLock.current ||
      uncertainDeletions.current.has(target.family_id)
    )
      return;
    const guard = captureAccountRequestGuard();
    let requested = false;
    deleteLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      metadataGuard.current?.();
      guard();
      requested = true;
      const receipt = await client.removeFamily(target.family_id, abort.current.signal);
      guard();
      if (!valid()) return;
      setConfirmDelete(null);
      setSelected(null);
      setInspector(null);
      setVersions((current) => current.filter((version) => version.family_id !== target.family_id));
      setNotice(
        receipt.state === "deleting"
          ? "删除已提交，正在清理原件。已有引用已停止访问，稍后可刷新核对。"
          : "成果及其全部版本已删除。",
      );
      currentProps.current.onDeleted?.(target.family_id);
    } catch (cause) {
      if (!valid()) return;
      setConfirmDelete(null);
      if (
        requested &&
        !(cause instanceof CloudChatArtifactError && cause.status >= 400 && cause.status < 500)
      ) {
        uncertainDeletions.current.add(target.family_id);
        report(new Error("删除结果尚未确认，请重新读取核对，暂不重复删除。"));
      } else report(cause);
    } finally {
      deleteLock.current = false;
      if (valid()) setBusy(false);
    }
  }

  async function download() {
    if (!selected || !valid()) return;
    const guard = captureAccountRequestGuard(),
      seq = ++generation.current;
    setBusy(true);
    setError("");
    try {
      metadataGuard.current?.();
      const result = await client.download(selected, abort.current.signal);
      guard();
      result.guard();
      if (!valid() || generation.current !== seq) return;
      const url = URL.createObjectURL(result.blob);
      try {
        guard();
        result.guard();
        if (!valid() || generation.current !== seq) return;
        const link = document.createElement("a");
        link.href = url;
        link.download = result.filename;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (cause) {
      if (generation.current === seq && !abort.current.signal.aborted) report(cause);
    } finally {
      if (valid() && generation.current === seq) setBusy(false);
    }
  }
  const families = versions.filter(
    (version) =>
      !versions.some(
        (other) => other.family_id === version.family_id && other.number > version.number,
      ),
  );
  function checkedShow(id: string, updateLocation = true, retry?: VersionAttempt) {
    if (busy || restoreBusy || versionRequest.current !== null) return;
    try {
      metadataGuard.current?.();
      if (valid()) void showVersion(id, updateLocation, retry);
    } catch (cause) {
      report(cause);
    }
  }

  async function restoreVersion() {
    if (!selected || busy || restoreInFlight.current || restoreBusy || !valid()) return;
    const request =
      restoreRequest ??
      (historyHead && canRestoreVersion
        ? { requestId: crypto.randomUUID(), source: selected, head: historyHead.id }
        : null);
    if (!request) return;
    restoreInFlight.current = true;
    setRestoreRequest(request);
    setRestoreBusy(true);
    setError("");
    const guard = captureAccountRequestGuard();
    try {
      const version = restoreRequest
        ? await client.restoreReceipt(request.requestId, abort.current.signal)
        : await client.restore(
            request.source,
            request.head,
            request.requestId,
            abort.current.signal,
          );
      guard();
      if (!valid()) return;
      if (
        version.family_id !== request.source.family_id ||
        version.sha256 !== request.source.sha256
      )
        throw new Error("恢复版本响应不一致");
      if (version.state === "ready") {
        setRestoreRequest(null);
        currentProps.current.onVersionRestored?.();
        await showVersion(version.id, true);
        if (valid()) {
          familyRequest.current?.abort();
          familyRequest.current = null;
          void loadFamilyHistory(version.family_id);
        }
      } else if (version.state === "failed" || version.state === "deleted") {
        setRestoreRequest(null);
        throw new Error("版本未能恢复，旧文件和批注保持不变。");
      } else setError("恢复结果尚未确认，请稍后核对。不会重复提交恢复请求。");
    } catch (cause) {
      if (!valid()) return;
      if (
        cause instanceof CloudChatArtifactError &&
        ([400, 401, 409, 413].includes(cause.status) || (cause.status === 404 && !restoreRequest))
      )
        setRestoreRequest(null);
      report(cause);
    } finally {
      restoreInFlight.current = false;
      if (valid()) setRestoreBusy(false);
    }
  }
  const inSourceConversation = selected?.conversation_id === conversationId;
  const canReviseAtSource = !!props.onOpenSourceRun && !inSourceConversation;
  const continueLabel = canReviseAtSource
    ? copy("在来源会话中修改", "Revise in source chat")
    : props.workFromSpace
      ? copy("与 AI 一起工作", "Work with AI")
      : copy("继续修改", "Continue editing");
  const sourceLabel = copy("打开来源会话", "Open source conversation");
  function handoffSelectedVersion() {
    if (!selected || selected.state !== "ready" || busy || restoreBusy || !valid()) return;
    currentProps.current.onHandoff?.({
      kind: "artifact",
      target_id: selected.id,
      name: selected.name,
      artifactNumber: selected.number,
    });
  }

  async function openSource(revise: boolean) {
    const open = currentProps.current.onOpenSourceRun;
    if (!open || !selected || busy || sourceOpening.current || !valid()) return;
    const signal = abort.current.signal;
    const seq = generation.current;
    const active = () => valid() && !signal.aborted && seq === generation.current;
    const intent = { versionId: selected.id, revise };
    const retrying =
      sourceAttempt?.versionId === intent.versionId && sourceAttempt.revise === revise;
    sourceOpening.current = true;
    setBusy(true);
    setSourceAttempt({ ...intent, status: retrying ? "retrying" : "opening" });
    try {
      metadataGuard.current?.();
      await open(selected, revise, signal);
      if (active()) setSourceAttempt(undefined);
    } catch (cause) {
      if (active()) {
        setSourceAttempt({ ...intent, status: "failed" });
        currentProps.current.onError?.(cause);
      }
    } finally {
      sourceOpening.current = false;
      if (active()) setBusy(false);
    }
  }

  function continueWork(reviseAtSource = canReviseAtSource) {
    if (!selected || busy || selected.state !== "ready" || !valid()) return;
    if (reviseAtSource) {
      void openSource(true);
      return;
    }
    try {
      metadataGuard.current?.();
      if (currentProps.current.onContinue?.(selected) === false)
        setError("未能添加此版本，请检查草稿中的资料数量或等待当前操作完成。");
    } catch (cause) {
      report(cause);
    }
  }

  const attemptedVersion =
    versionAttempt &&
    (history?.versions.find((version) => version.id === versionAttempt.id) ??
      versions.find((version) => version.id === versionAttempt.id) ??
      (selected?.id === versionAttempt.id ? selected : undefined));
  const attemptedLabel = attemptedVersion
    ? `v${attemptedVersion.number}`
    : copy("此版本", "this version");
  const readFeedback = versionAttempt ? (
    <CloudChatFeedback
      tone={versionAttempt.retrying ? "info" : "error"}
      busy={versionAttempt.retrying}
      message={
        versionAttempt.retrying
          ? copy(`正在打开 ${attemptedLabel}…`, `Opening ${attemptedLabel}…`)
          : versionAttempt.failure === "unavailable"
            ? copy(
                `${attemptedLabel} 不可用，可能已移除或无权查看。`,
                `${attemptedLabel} may have been removed or you may no longer have access.`,
              )
            : copy(`暂时无法打开 ${attemptedLabel}。`, `Couldn't open ${attemptedLabel}.`)
      }
      compact
      stackActions
      actions={
        <Button
          ref={versionRetryButton}
          variant="ghost"
          size="sm"
          className="min-h-11 aria-disabled:opacity-50 sm:min-h-8"
          aria-disabled={busy || restoreBusy}
          onClick={() =>
            checkedShow(versionAttempt.id, versionAttempt.updateLocation, versionAttempt)
          }
        >
          {versionAttempt.retrying
            ? copy("正在重试…", "Retrying…")
            : copy("重新读取", "Retry reading")}
        </Button>
      }
    />
  ) : error ? (
    <CloudChatFeedback
      tone="error"
      message={error}
      compact
      actions={
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || restoreBusy}
          onClick={() => {
            const id = selected?.id ?? initialVersionId;
            if (id) {
              checkedShow(id, false);
              if (selectedFamilyId) void loadFamilyHistory(selectedFamilyId);
            } else void loadList();
          }}
        >
          {copy("重新读取", "Retry reading")}
        </Button>
      }
    />
  ) : null;
  const sourceFeedback =
    props.onOpenSourceRun && sourceAttempt && sourceAttempt.versionId === selected?.id ? (
      <CloudChatFeedback
        className="cloud-reader-source-feedback"
        tone={sourceAttempt.status === "failed" ? "error" : "info"}
        busy={sourceAttempt.status !== "failed"}
        message={
          sourceAttempt.status === "failed"
            ? copy(
                "暂时无法打开来源会话。可以继续查看此版本。",
                "The source conversation is unavailable. You can keep reading this version.",
              )
            : copy("正在打开来源会话…", "Opening the source conversation…")
        }
        compact
        stackActions
        actions={
          sourceAttempt.status !== "opening" ? (
            <button
              type="button"
              className="app-status-action"
              aria-disabled={busy || restoreBusy}
              onClick={() => {
                if (!restoreBusy) void openSource(sourceAttempt.revise);
              }}
            >
              {sourceAttempt.revise
                ? copy("重试进入来源会话修改", "Retry opening source to revise")
                : copy("重试打开来源", "Retry opening source")}
            </button>
          ) : null
        }
      />
    ) : null;
  const versionHistory = selectedFamilyId
    ? {
        pending: !history || history.pending,
        failure: history?.failure,
        hasMore: Boolean(history?.cursor),
        onRead: () =>
          void loadFamilyHistory(
            selectedFamilyId,
            history?.failure === "first" || history?.failure === "changed" ? "" : history?.cursor,
          ),
      }
    : undefined;

  if (props.initialSite && selected?.state === "ready")
    return (
      <CloudChatSiteView
        key={`site:${selected.id}`}
        client={client.sites}
        artifact={selected}
        openOnMount
        isCurrent={valid}
        workspace={{
          onClose: props.onClose,
          closeControlRef: readerFocus,
          onContinue: props.onContinue || canReviseAtSource ? () => continueWork() : undefined,
          onHandoff: props.onHandoff ? handoffSelectedVersion : undefined,
          continueLabel,
          source: props.onOpenSourceRun
            ? { label: sourceLabel, onOpen: () => void openSource(false), busy }
            : undefined,
          onRequestRevision:
            props.onRequestRevision && inSourceConversation
              ? (comments) =>
                  currentProps.current.onRequestRevision?.(selected, comments) ??
                  Promise.resolve(false)
              : undefined,
          versions: history?.versions ?? [],
          onVersion: checkedShow,
          versionBusy: busy,
          openingVersion: openingVersionId,
          selectedVersionRef: selectedVersionRow,
          versionHistory,
          readerFeedback: (
            <>
              {readFeedback}
              {sourceFeedback}
            </>
          ),
          displayName: props.siteName,
          onRename: props.onSiteRename,
          initialAction: inspector === "history" ? "versions" : props.siteAction,
        }}
      />
    );
  return (
    <CloudChatResourcePanel
      title={
        selected && inspector === "history" ? (
          <ReaderAction
            variant="ghost"
            size="sm"
            className="za-reader-title-menu"
            tooltip={copy("返回", "Back")}
            aria-label={copy("返回文件阅读", "Return to the reader")}
            onClick={() => setInspector(null)}
          >
            <ArrowLeft className="size-4 shrink-0" />
            <span className="truncate za-reader-history-time-full">
              v{selected.number} · {new Date(selected.created_at).toLocaleString(locale)}
            </span>
            <span className="truncate za-reader-history-time-compact">
              v{selected.number} ·{" "}
              {new Date(selected.created_at).toLocaleString(locale, {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </ReaderAction>
        ) : selected ? (
          <ResourceTitleMenu name={selected.name} triggerRef={readerFocus}>
            {props.onContinue || canReviseAtSource ? (
              <DropdownMenuItem
                className="gap-2"
                disabled={busy || selected.state !== "ready"}
                onClick={() => continueWork()}
              >
                {continueLabel}
              </DropdownMenuItem>
            ) : null}
            {props.onOpenSourceRun ? (
              <DropdownMenuItem
                className="gap-2"
                disabled={busy}
                onClick={() => void openSource(false)}
              >
                <MessageSquare className="size-4" />
                {sourceLabel}
              </DropdownMenuItem>
            ) : null}
            {canReviseAtSource && props.onContinue ? (
              <DropdownMenuItem
                className="gap-2"
                disabled={busy || selected.state !== "ready"}
                onClick={() => continueWork(false)}
              >
                {copy("引用到当前对话", "Attach to current conversation")}
              </DropdownMenuItem>
            ) : null}
            {props.onHandoff && selected.state === "ready" ? (
              <WorkspaceHandoffMenuItem
                disabled={busy || restoreBusy}
                onClick={handoffSelectedVersion}
              />
            ) : null}
            <DropdownMenuItem className="gap-2" onClick={() => setInspector("details")}>
              <Info className="size-4" />
              {copy("文件信息", "File information")}
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onClick={() => setInspector("history")}>
              <History className="size-4" />
              {copy("版本历史记录", "Version history")}
            </DropdownMenuItem>
          </ResourceTitleMenu>
        ) : initialVersionId ? (
          props.initialSite ? (
            copy("站点预览", "Site preview")
          ) : (
            copy("成果预览", "Artifact preview")
          )
        ) : (
          copy("成果库", "Artifacts")
        )
      }
      details={
        selected && inspector ? (
          <ResourceInspector
            title={
              inspector === "history"
                ? copy("版本历史记录", "Version history")
                : copy("文件详情", "File details")
            }
            onClose={() => setInspector(null)}
          >
            {readFeedback}
            {sourceFeedback}
            {inspector === "history" ? (
              <ResourceVersionTimeline
                versions={history?.versions ?? []}
                selected={selected.id}
                selectedNumber={selected.number}
                opening={openingVersionId}
                busy={busy || restoreBusy}
                selectedRowRef={selectedVersionRow}
                onSelect={checkedShow}
                history={versionHistory}
              />
            ) : (
              <>
                <p className="font-medium">{selected.name}</p>
                <p className="text-muted-foreground">
                  {copy("资料空间 / 工作成果", "Library / Artifacts")}
                </p>
                <dl>
                  <dt>{copy("文件类型", "File type")}</dt>
                  <dd>{selected.name.split(".").pop()?.toUpperCase()}</dd>
                  <dt>{copy("文件大小", "Size")}</dt>
                  <dd>{cloudArtifactSize(selected.size)}</dd>
                  <dt>{copy("保存时间", "Saved")}</dt>
                  <dd>{new Date(selected.created_at).toLocaleString(locale)}</dd>
                  <dt>{copy("当前版本", "Version")}</dt>
                  <dd>
                    v{selected.number} · {cloudArtifactStatus(selected, locale)}
                  </dd>
                </dl>
                {props.onOpenSourceRun ? (
                  <Button
                    variant="ghost"
                    className="mt-4"
                    disabled={busy}
                    onClick={() => void openSource(false)}
                  >
                    <MessageSquare className="size-4" />
                    {sourceLabel}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  className="mt-4 text-destructive"
                  disabled={
                    busy || restoreBusy || uncertainDeletions.current.has(selected.family_id)
                  }
                  onClick={() => setConfirmDelete(selected)}
                >
                  {copy("删除全部版本", "Delete all versions")}
                </Button>
              </>
            )}
          </ResourceInspector>
        ) : null
      }
      dragResource={
        selected?.state === "ready" && inspector !== "history" && props.onContinue && !busy
          ? { kind: "artifact", id: selected.family_id, target_id: selected.id }
          : undefined
      }
      description={
        initialVersionId
          ? props.initialSite
            ? copy("私人预览", "Private preview")
            : copy("已保存的成果版本", "Saved artifact version")
          : copy(
              "只提供正式保存的版本。删除对话会保留成果，删除成果会移除它的全部版本。",
              "Saved artifacts remain available after a conversation is deleted. Deleting an artifact removes all its versions.",
            )
      }
      subtitle={
        selected
          ? `v${selected.number} · ${cloudArtifactStatus(selected, locale)} · ${cloudArtifactSize(selected.size)} · ${selected.name.split(".").pop()?.toUpperCase()}`
          : undefined
      }
      continueAction={
        selected &&
        (props.onContinue || canReviseAtSource) &&
        !props.workActive &&
        (canReviseAtSource ||
          props.workFromSpace ||
          !["docx", "pdf"].includes(resourcePreviewKind(selected)))
          ? {
              label: continueLabel,
              disabled: busy || selected.state !== "ready",
              onClick: () => continueWork(),
            }
          : undefined
      }
      headerActions={
        selected ? (
          <>
            {inspector === "history" ? (
              <Button
                size="sm"
                variant="outline"
                className="za-reader-restore-button"
                disabled={busy || restoreBusy || (!restoreRequest && !canRestoreVersion)}
                onClick={() => void restoreVersion()}
              >
                {restoreBusy ? (
                  <span className="za-reader-button-spinner" aria-hidden="true" />
                ) : null}
                {restoreRequest && !restoreBusy
                  ? copy("核对恢复状态", "Check restore status")
                  : copy("恢复此版本", "Restore this version")}
              </Button>
            ) : null}
            <ReaderAction
              variant="ghost"
              size="icon-sm"
              data-reader-secondary=""
              aria-label={copy("下载此版本", "Download this version")}
              tooltip={copy("下载此版本", "Download this version")}
              disabled={busy || selected.state !== "ready"}
              onClick={() => void download()}
            >
              <Download className="size-4" />
              <span className="sr-only">{copy("下载此版本", "Download this version")}</span>
            </ReaderAction>
          </>
        ) : undefined
      }
      className={inspector === "history" ? "cloud-reader-history-open" : undefined}
      closeLabel={
        props.workActive
          ? copy("关闭阅读器", "Close reader")
          : copy("关闭成果库", "Close artifact reader")
      }
      backToLibrary={props.workFromSpace && !props.workActive}
      wide={Boolean(
        selected &&
          ["docx", "pptx", "pdf", "sheet", "html", "svg", "archive", "markdown", "text"].includes(
            resourcePreviewKind(selected),
          ),
      )}
      onClose={props.onClose}
    >
      {!(selected && inspector) && sourceFeedback}
      {confirmDelete && (
        <ResourceDeleteDialog
          open
          busy={busy}
          name={confirmDelete.name}
          description="此成果的全部版本将被永久删除，已有消息中的版本引用将无法再读取。原有对话会保留。"
          confirmLabel="确认删除成果"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void removeConfirmedFamily()}
        />
      )}
      {notice && (
        <CloudChatFeedback
          tone="info"
          compact
          message={notice}
          actions={
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void loadList(scope)}>
              刷新列表
            </Button>
          }
        />
      )}
      {!(selected && inspector) && readFeedback}
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <>
            {selected.state !== "ready" ? (
              <p className="mt-12px text-sm text-muted-foreground">
                正式文件尚未保存完成，此版本暂不可下载。请稍后刷新核对。
              </p>
            ) : null}
            {selected.state === "ready" && /\.zip$/i.test(selected.name) ? (
              <CloudChatSiteView
                key={`site:${selected.id}`}
                client={client.sites}
                artifact={selected}
                openOnMount={props.initialSite}
                isCurrent={valid}
                onPreviewChange={(open) => setSitePreviewId(open ? selected.id : "")}
              />
            ) : null}
            {selected.state === "ready" && sitePreviewId !== selected.id ? (
              <ResourcePreview
                key={selected.id}
                resource={{ ...selected, identity: selected.id }}
                load={async (signal) => {
                  const guard = captureAccountRequestGuard();
                  metadataGuard.current?.();
                  const result = await client.download(selected, signal);
                  const assertCurrent = () => {
                    guard();
                    result.guard();
                    if (!valid()) throw new DOMException("预览已关闭", "AbortError");
                  };
                  assertCurrent();
                  return { blob: result.blob, assertCurrent };
                }}
                onRequestRevision={
                  props.onRequestRevision && inSourceConversation
                    ? (comments) =>
                        currentProps.current.onRequestRevision?.(selected, comments) ?? false
                    : undefined
                }
                onDownload={() => void download()}
              />
            ) : null}
          </>
        ) : initialVersionId && (busy || openingFailure) ? (
          <CloudReaderOpening
            kind={props.initialSite ? "site" : "artifact"}
            failure={openingFailure}
            busy={busy}
            retryRef={retryButton}
            onRetry={() => showVersion(initialVersionId)}
          />
        ) : families.length ? (
          <>
            <ul className="m-0 list-none space-y-12px p-0">
              {families.map((version) => (
                <li key={version.family_id} className="rounded-xl border border-border p-12px">
                  <button
                    type="button"
                    className="max-w-full truncate text-left text-sm font-medium hover:underline"
                    disabled={busy}
                    onClick={() => checkedShow(version.id)}
                  >
                    {version.name}
                  </button>
                  <p className="mt-4px text-xs text-muted-foreground">
                    v{version.number} · {cloudArtifactStatus(version, locale)} ·{" "}
                    {cloudArtifactSize(version.size)}
                  </p>
                </li>
              ))}
            </ul>
            {nextCursor ? (
              <button
                type="button"
                className={`${buttonClass} mt-12px`}
                disabled={busy}
                onClick={() => void loadList(scope, nextCursor)}
              >
                {busy ? "正在加载更多…" : "加载更多成果"}
              </button>
            ) : null}
          </>
        ) : !busy ? (
          <p className="py-24px text-center text-sm text-muted-foreground">
            {error || versionAttempt
              ? "暂时无法读取成果，请刷新后重试。"
              : notice
                ? "所选成果已停止访问。"
                : "还没有成果。任务正式保存的成果会显示在这里。"}
          </p>
        ) : null}
      </div>
    </CloudChatResourcePanel>
  );
}
