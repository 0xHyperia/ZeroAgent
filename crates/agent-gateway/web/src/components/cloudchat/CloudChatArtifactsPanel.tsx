import { resourcePreviewKind } from "@liveagent/ui/components/resource-preview/previewPolicy";
import { ResourcePreview } from "@liveagent/ui/components/resource-preview/ResourcePreview";
import { Button, buttonVariants } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { TooltipButton as ReaderAction } from "@liveagent/ui/components/ui/tooltip-button";
import { useEffect, useRef, useState } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import {
  type CloudChatArtifactsClient,
  type CloudChatArtifactVersion,
  cloudArtifactCanPreviewImage,
  cloudArtifactCanViewText,
  cloudArtifactSize,
  cloudArtifactStatus,
} from "@/lib/cloudChatArtifacts";
import { CloudChatFeedback } from "./CloudChatFeedback";
import { CloudChatResourcePanel } from "./CloudChatResourcePanel";
import { CloudChatSiteView } from "./CloudChatSiteView";

type Props = {
  client: CloudChatArtifactsClient;
  conversationId?: string;
  initialVersionId?: string;
  initialSite?: boolean;
  isCurrent: () => boolean;
  onClose: () => void;
  onDeleted?: (familyId: string) => void;
  onOpenSourceRun?: (runId: string, conversationId: string) => void;
  // biome-ignore lint/suspicious/noConfusingVoidType: existing hosts return void; false explicitly rejects a reference.
  onContinue?: (version: CloudChatArtifactVersion) => boolean | void;
  onError?: (cause: unknown) => void;
};
const buttonClass = buttonVariants({ variant: "outline", size: "sm" });

export function CloudChatArtifactsPanel(props: Props) {
  const { client, conversationId, initialVersionId } = props;
  const [versions, setVersions] = useState<CloudChatArtifactVersion[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [selected, setSelected] = useState<CloudChatArtifactVersion | null>(null);
  const [sitePreviewId, setSitePreviewId] = useState("");
  const [familyVersions, setFamilyVersions] = useState<CloudChatArtifactVersion[]>([]);
  const [scope, setScope] = useState<"conversation" | "account">(
    conversationId ? "conversation" : "account",
  );
  const [text, setText] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false),
    [notice, setNotice] = useState("");
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
    setText(null);
    setConfirmDelete(false);
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
    if (selected?.id !== versionId) {
      setText(null);
      setSelected(null);
    }
    setConfirmDelete(false);
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

  async function viewText() {
    if (!selected || !valid()) return;
    const guard = captureAccountRequestGuard(),
      seq = ++generation.current;
    setBusy(true);
    setError("");
    setText(null);
    try {
      metadataGuard.current?.();
      const result = await client.text(selected, abort.current.signal);
      guard();
      result.guard();
      if (valid() && generation.current === seq) setText(result.text);
    } catch (cause) {
      if (generation.current === seq && !abort.current.signal.aborted) report(cause);
    } finally {
      if (valid() && generation.current === seq) setBusy(false);
    }
  }
  function viewImage() {
    if (!selected || !valid()) return;
    try {
      metadataGuard.current?.();
      setText(null);
      setError("");
    } catch (cause) {
      report(cause);
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
  async function removeFamily() {
    if (!selected || !valid()) return;
    const guard = captureAccountRequestGuard(),
      seq = ++generation.current;
    setBusy(true);
    setError("");
    try {
      metadataGuard.current?.();
      const result = await client.removeFamily(selected.family_id, abort.current.signal);
      guard();
      if (!valid() || generation.current !== seq) return;
      currentProps.current.onDeleted?.(result.familyId);
      setNotice(
        result.state === "deleted"
          ? "已删除这项成果的全部版本。"
          : "删除已提交，所有版本已停止访问，正在清理原件。",
      );
      await loadList();
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

  return (
    <CloudChatResourcePanel
      title={selected ? selected.name : "成果库"}
      dragResource={
        selected?.state === "ready" && props.onContinue && !busy
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
            {props.onContinue ? (
              <Button
                size="sm"
                disabled={busy || selected.state !== "ready"}
                onClick={continueWork}
              >
                继续修改
              </Button>
            ) : null}
            <ReaderAction
              variant="outline"
              size="sm"
              data-reader-secondary=""
              aria-label="下载此版本"
              tooltip="下载此版本"
              disabled={busy || selected.state !== "ready"}
              onClick={() => void download()}
            >
              <Download className="size-4" />
              <span className="cloud-reader-action-label">下载此版本</span>
            </ReaderAction>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label="成果更多操作"
                disabled={busy}
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {conversationId ? (
                  <DropdownMenuItem
                    onClick={() => void loadList("conversation")}
                    className="gap-2.5"
                  >
                    <FolderOpen className="size-4" />
                    当前对话成果
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem onClick={() => void loadList("account")} className="gap-2.5">
                  <FolderOpen className="size-4" />
                  账户成果库
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void showVersion(selected.id)} className="gap-2.5">
                  <RefreshCw className="size-4" />
                  刷新状态
                </DropdownMenuItem>
                {props.onOpenSourceRun ? (
                  <DropdownMenuItem
                    onClick={() => {
                      try {
                        metadataGuard.current?.();
                        if (valid())
                          currentProps.current.onOpenSourceRun?.(
                            selected.source_run_id,
                            selected.conversation_id,
                          );
                      } catch (cause) {
                        report(cause);
                      }
                    }}
                    className="gap-2.5"
                  >
                    <FileText className="size-4" />
                    查看来源对话
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                {cloudArtifactCanPreviewImage(selected) ||
                resourcePreviewKind(selected) === "image" ? (
                  <DropdownMenuItem onClick={viewImage} className="gap-2.5">
                    <ImageIcon className="size-4" />
                    查看图片
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={!cloudArtifactCanViewText(selected)}
                  onClick={() => void viewText()}
                  className="gap-2.5"
                >
                  <FileText className="size-4" />
                  查看文本
                </DropdownMenuItem>
                {text !== null ? (
                  <DropdownMenuItem onClick={() => setText(null)} className="gap-2.5">
                    <FileText className="size-4" />
                    返回文件预览
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setConfirmDelete(true)}
                  className="gap-2.5 text-destructive"
                >
                  <Trash2 className="size-4" />
                  删除全部版本
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : undefined
      }
      closeLabel="关闭成果库"
      wide={Boolean(
        selected &&
          ["docx", "pptx", "pdf", "sheet", "html", "svg", "archive"].includes(
            resourcePreviewKind(selected),
          ),
      )}
      onClose={props.onClose}
    >
      {!selected ? (
        <div className="flex flex-wrap items-center gap-8px">
          {conversationId ? (
            <button
              type="button"
              className={buttonClass}
              disabled={busy}
              onClick={() => void loadList("conversation")}
            >
              当前对话成果
            </button>
          ) : null}
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void loadList("account")}
          >
            账户成果库
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={busy}
            onClick={() => void loadList()}
          >
            刷新状态
          </button>
          {busy ? (
            <span role="status" className="text-xs text-muted-foreground">
              正在读取成果…
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? <CloudChatFeedback tone="error" message={error} compact /> : null}
      {notice ? <CloudChatFeedback message={notice} compact /> : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <>
            <label className="flex items-center gap-8px text-sm">
              历史版本
              <select
                aria-label="成果版本"
                className="min-w-0 flex-1 rounded-lg border border-border bg-background px-10px py-6px"
                disabled={busy}
                value={selected.id}
                onChange={(event) => checkedShow(event.target.value)}
              >
                {familyVersions.map((version) => (
                  <option key={version.id} value={version.id}>
                    v{version.number} · {version.name} · {cloudArtifactStatus(version)}
                  </option>
                ))}
              </select>
            </label>
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
            {selected.state === "ready" && sitePreviewId !== selected.id && text === null ? (
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
                onDownload={() => void download()}
              />
            ) : null}
            {text !== null ? (
              <>
                <p className="mt-16px mb-8px text-xs text-muted-foreground">
                  文本查看；网页和 SVG 以源码显示。
                </p>
                <pre className="overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/30 p-12px font-mono text-xs">
                  {text}
                </pre>
              </>
            ) : null}
            {confirmDelete ? (
              <div
                role="alert"
                className="mt-12px rounded-xl border border-destructive/30 p-12px text-sm"
              >
                <p>确认删除这项成果的全部历史版本？已有消息中的下载和版本引用会失效。</p>
                <div className="mt-8px flex gap-8px">
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => void removeFamily()}
                  >
                    确认删除成果
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => setConfirmDelete(false)}
                  >
                    保留成果
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : families.length ? (
          <>
            <p className="mb-12px text-xs text-muted-foreground">
              {scope === "conversation" ? "当前对话" : "账户"}已加载 {versions.length}{" "}
              个版本，按成果合并展示。
            </p>
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
            ) : (
              <p className="mt-12px text-xs text-muted-foreground">已显示全部可用成果。</p>
            )}
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

import {
  Download,
  FileText,
  FolderOpen,
  ImageIcon,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from "@liveagent/ui/components/IconSet";
