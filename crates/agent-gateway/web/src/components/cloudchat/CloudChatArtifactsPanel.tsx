import { PreviewLoading } from "@liveagent/ui/components/resource-preview/PreviewFeedback";
import { resourcePreviewKind } from "@liveagent/ui/components/resource-preview/previewPolicy";
import type { DocumentRevisionComment } from "@liveagent/ui/components/resource-preview/ResourceDocumentComments";
import { ResourcePreview } from "@liveagent/ui/components/resource-preview/ResourcePreview";
import {
  ResourceInspector,
  ResourceTitleMenu,
} from "@liveagent/ui/components/resource-preview/ResourceReaderDetails";
import { ResourceVersionTimeline } from "@liveagent/ui/components/resource-preview/ResourceVersionTimeline";
import { Button, buttonVariants } from "@liveagent/ui/components/ui/button";
import { DropdownMenuItem } from "@liveagent/ui/components/ui/dropdown-menu";
import { TooltipButton as ReaderAction } from "@liveagent/ui/components/ui/tooltip-button";
import { useEffect, useRef, useState } from "react";
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
  isCurrent: () => boolean;
  onClose: () => void;
  onDeleted?: (familyId: string) => void;
  onOpenSourceRun?: (runId: string, conversationId: string) => void;
  // biome-ignore lint/suspicious/noConfusingVoidType: existing hosts return void; false explicitly rejects a reference.
  onContinue?: (version: CloudChatArtifactVersion) => boolean | void;
  workFromSpace?: boolean;
  workActive?: boolean;
  onError?: (cause: unknown) => void;
};
const buttonClass = buttonVariants({ variant: "outline", size: "sm" });

export function CloudChatArtifactsPanel(props: Props) {
  const { client, conversationId, initialVersionId } = props;
  const [versions, setVersions] = useState<CloudChatArtifactVersion[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [selected, setSelected] = useState<CloudChatArtifactVersion | null>(null);
  const [sitePreviewId, setSitePreviewId] = useState("");
  const restoreInFlight = useRef(false);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [restoreRequest, setRestoreRequest] = useState<{
    requestId: string;
    source: CloudChatArtifactVersion;
    head: string;
  } | null>(null);
  const [familyVersions, setFamilyVersions] = useState<CloudChatArtifactVersion[]>([]);
  const [scope, setScope] = useState<"conversation" | "account">(
    conversationId ? "conversation" : "account",
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [inspector, setInspector] = useState<"details" | "history" | null>(null);
  const mounted = useRef(true),
    generation = useRef(0),
    abort = useRef(new AbortController());
  const metadataGuard = useRef<(() => void) | null>(null),
    currentProps = useRef(props);
  currentProps.current = props;
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
    setError("");
    setSelected(null);
    setFamilyVersions([]);
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
  async function showVersion(versionId: string) {
    const seq = ++generation.current,
      guard = captureAccountRequestGuard();
    setBusy(true);
    setError("");
    try {
      const version = await client.get(versionId, abort.current.signal);
      const family = await client.list({
        familyId: version.family_id,
        limit: 100,
        signal: abort.current.signal,
      });
      if (family.nextCursor) throw new Error("成果版本列表尚未完整，请刷新后重试。");
      guard();
      if (!valid() || generation.current !== seq) return;
      metadataGuard.current = guard;
      setSelected(version);
      setFamilyVersions(family.versions.sort((left, right) => right.number - left.number));
    } catch (cause) {
      if (generation.current === seq && !abort.current.signal.aborted) report(cause);
    } finally {
      if (valid() && generation.current === seq) setBusy(false);
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
  function checkedShow(id: string) {
    try {
      metadataGuard.current?.();
      if (valid()) void showVersion(id);
    } catch (cause) {
      report(cause);
    }
  }

  async function restoreVersion() {
    if (!selected || restoreInFlight.current || restoreBusy || !valid()) return;
    const head = familyVersions[0];
    if (
      !head ||
      (!restoreRequest &&
        (head.state !== "ready" ||
          head.id === selected.id ||
          selected.state !== "ready" ||
          /\.zip$/i.test(selected.name)))
    )
      return;
    const request = restoreRequest ?? {
      requestId: crypto.randomUUID(),
      source: selected,
      head: head.id,
    };
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
        await showVersion(version.id);
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
  function continueWork() {
    if (!selected || busy || selected.state !== "ready" || !valid()) return;
    try {
      metadataGuard.current?.();
      if (currentProps.current.onContinue?.(selected) === false)
        setError("未能添加此版本，请检查草稿中的资料数量或等待当前操作完成。");
    } catch (cause) {
      report(cause);
    }
  }

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
          onContinue: props.onContinue ? continueWork : undefined,
          onRequestRevision: props.onRequestRevision
            ? (comments) =>
                currentProps.current.onRequestRevision?.(selected, comments) ??
                Promise.resolve(false)
            : undefined,
          versions: familyVersions,
          onVersion: checkedShow,
          displayName: props.siteName,
          onRename: props.onSiteRename,
          initialAction: props.siteAction,
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
            tooltip="返回"
            aria-label="返回文件阅读"
            onClick={() => setInspector(null)}
          >
            <ArrowLeft className="size-4 shrink-0" />
            <span className="truncate za-reader-history-time-full">
              {new Date(selected.created_at).toLocaleString("zh-CN")}
            </span>
            <span className="truncate za-reader-history-time-compact">
              {new Date(selected.created_at).toLocaleString("zh-CN", {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </ReaderAction>
        ) : selected ? (
          <ResourceTitleMenu name={selected.name}>
            {props.onContinue ? (
              <DropdownMenuItem
                className="gap-2"
                disabled={busy || selected.state !== "ready"}
                onClick={continueWork}
              >
                与 AI 一起工作
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem className="gap-2" onClick={() => setInspector("details")}>
              <Info className="size-4" />
              文件信息
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2" onClick={() => setInspector("history")}>
              <History className="size-4" />
              版本历史记录
            </DropdownMenuItem>
          </ResourceTitleMenu>
        ) : initialVersionId ? (
          "文件预览"
        ) : (
          "成果库"
        )
      }
      details={
        selected && inspector ? (
          <ResourceInspector
            title={inspector === "history" ? "版本历史记录" : "文件详情"}
            onClose={() => setInspector(null)}
          >
            {inspector === "history" ? (
              <ResourceVersionTimeline
                versions={familyVersions}
                selected={selected.id}
                busy={busy}
                onSelect={checkedShow}
              />
            ) : (
              <>
                <p className="font-medium">{selected.name}</p>
                <p className="text-muted-foreground">资料空间 / 工作成果</p>
                <dl>
                  <dt>文件类型</dt>
                  <dd>{selected.name.split(".").pop()?.toUpperCase()} 文件</dd>
                  <dt>文件大小</dt>
                  <dd>{cloudArtifactSize(selected.size)}</dd>
                  <dt>保存时间</dt>
                  <dd>{new Date(selected.created_at).toLocaleString("zh-CN")}</dd>
                  <dt>当前版本</dt>
                  <dd>
                    v{selected.number} · {cloudArtifactStatus(selected)}
                  </dd>
                </dl>
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
      description="只提供正式保存的版本。删除对话会保留成果，删除成果会移除它的全部版本。"
      subtitle={
        selected
          ? `v${selected.number} · ${cloudArtifactStatus(selected)} · ${cloudArtifactSize(selected.size)} · ${selected.name.split(".").pop()?.toUpperCase()}`
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
                disabled={
                  restoreBusy ||
                  (!restoreRequest &&
                    (familyVersions[0]?.state !== "ready" ||
                      familyVersions[0]?.id === selected.id ||
                      selected.state !== "ready" ||
                      /\.zip$/i.test(selected.name)))
                }
                onClick={() => void restoreVersion()}
              >
                {restoreBusy ? (
                  <span className="za-reader-button-spinner" aria-hidden="true" />
                ) : null}
                {restoreRequest && !restoreBusy ? "核对恢复状态" : "恢复此版本"}
              </Button>
            ) : null}
            {props.onContinue &&
            !props.workActive &&
            (props.workFromSpace || !["docx", "pdf"].includes(resourcePreviewKind(selected))) ? (
              <Button
                size="sm"
                className="cloud-reader-continue-action"
                disabled={busy || selected.state !== "ready"}
                onClick={continueWork}
              >
                {props.workFromSpace ? "与 AI 一起工作" : "继续修改"}
              </Button>
            ) : null}
            <ReaderAction
              variant="ghost"
              size="icon-sm"
              data-reader-secondary=""
              aria-label="下载此版本"
              tooltip="下载此版本"
              disabled={busy || selected.state !== "ready"}
              onClick={() => void download()}
            >
              <Download className="size-4" />
              <span className="sr-only">下载此版本</span>
            </ReaderAction>
          </>
        ) : undefined
      }
      className={inspector === "history" ? "cloud-reader-history-open" : undefined}
      closeLabel="关闭成果库"
      wide={Boolean(
        selected &&
          ["docx", "pptx", "pdf", "sheet", "html", "svg", "archive", "markdown", "text"].includes(
            resourcePreviewKind(selected),
          ),
      )}
      onClose={props.onClose}
    >
      {error ? (
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
                if (id) checkedShow(id);
                else void loadList();
              }}
            >
              重新读取
            </Button>
          }
        />
      ) : null}
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
                  props.onRequestRevision
                    ? (comments) =>
                        currentProps.current.onRequestRevision?.(selected, comments) ?? false
                    : undefined
                }
                onDownload={() => void download()}
              />
            ) : null}
          </>
        ) : initialVersionId && busy ? (
          <div className="cloud-reader-opening">
            <PreviewLoading message="正在打开文件…" />
          </div>
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
                    v{version.number} · {cloudArtifactStatus(version)} ·{" "}
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
            {error
              ? "暂时无法读取成果，请刷新后重试。"
              : "还没有成果。任务正式保存的成果会显示在这里。"}
          </p>
        ) : null}
      </div>
    </CloudChatResourcePanel>
  );
}

import { ArrowLeft, Download, History, Info } from "@liveagent/ui/components/IconSet";
