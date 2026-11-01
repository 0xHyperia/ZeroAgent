import {
  Check,
  Download,
  FileText,
  FolderOpen,
  Info,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  Upload,
} from "@liveagent/ui/components/IconSet";
import { PreviewLoading } from "@liveagent/ui/components/resource-preview/PreviewFeedback";
import { resourcePreviewKind } from "@liveagent/ui/components/resource-preview/previewPolicy";
import type { DocumentRevisionComment } from "@liveagent/ui/components/resource-preview/ResourceDocumentComments";
import { ResourcePreview } from "@liveagent/ui/components/resource-preview/ResourcePreview";
import {
  ResourceDeleteDialog,
  ResourceInspector,
  ResourceTitleMenu,
} from "@liveagent/ui/components/resource-preview/ResourceReaderDetails";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { Input } from "@liveagent/ui/components/ui/input";
import { TooltipButton as ReaderAction } from "@liveagent/ui/components/ui/tooltip-button";
import { useEffect, useRef, useState } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import {
  CLOUD_FILE_CONTEXT_BYTES,
  type CloudChatFile,
  type CloudChatFilesClient,
  type CloudFileSource,
  cloudFileCanReference,
  cloudFileStatus,
} from "@/lib/cloudChatFiles";
import { CloudChatFeedback } from "./cloudchat/CloudChatFeedback";
import { CloudChatResourcePanel } from "./cloudchat/CloudChatResourcePanel";

type Props = {
  onRequestRevision?: (
    resource: CloudChatFile,
    comments: readonly DocumentRevisionComment[],
  ) => Promise<boolean>;
  client: CloudChatFilesClient;
  initialFileId?: string;
  fromLine?: number;
  toLine?: number;
  canAttach: boolean;
  attached?: boolean;
  isCurrent: () => boolean;
  onClose: () => void;
  // biome-ignore lint/suspicious/noConfusingVoidType: existing hosts return void; false explicitly rejects a reference.
  onAttach: (file: CloudChatFile) => boolean | void;
  onDeleted: (id: string) => void;
  onError: (cause: unknown) => void;
  onUpload?: () => void;
  onBrowseLibrary?: () => void;
  onOpenInSpace?: () => void;
  onOpenSourceConversation?: (id: string) => void;
};

export function CloudChatFilePanel(props: Props) {
  const { client, initialFileId, fromLine = 1, toLine = fromLine + 99 } = props;
  const [files, setFiles] = useState<CloudChatFile[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [selected, setSelected] = useState<CloudChatFile | null>(null);
  const [source, setSource] = useState<CloudFileSource | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sourceOpen, setSourceOpen] = useState(props.fromLine !== undefined);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const selectedUsage =
    selected?.state === "vision_ready"
      ? "可由支持视觉的模型理解，此文件没有文字原文。"
      : selected?.workspace_loadable
        ? selected.mime === "application/zip"
          ? "引用后可在隔离沙箱中读取或解压，不会自动运行其中的代码。"
          : "可在工作模式中读取；在线预览不表示文件已完成文本解析。"
        : selected?.state !== "ready"
          ? "暂时无法供模型理解，可下载原件或刷新处理状态。"
          : "引用资料后，可在对话中继续分析。";
  const mounted = useRef(true);
  const controller = useRef(new AbortController());
  const generation = useRef(0);
  const currentProps = useRef(props);
  currentProps.current = props;

  function valid() {
    return mounted.current && currentProps.current.isCurrent();
  }
  function report(cause: unknown) {
    if (!valid()) return;
    setError(cause instanceof Error ? cause.message : "文件操作失败");
    currentProps.current.onError(cause);
  }

  async function loadLibrary(append = false) {
    const seq = ++generation.current;
    const guard = captureAccountRequestGuard();
    setBusy(true);
    setError("");
    setSelected(null);
    setSource(null);
    setConfirmDelete(null);
    try {
      const page = await client.list({
        before: append ? nextCursor : undefined,
        signal: controller.current.signal,
      });
      guard();
      if (!valid() || generation.current !== seq) return;
      setFiles((old) =>
        append
          ? [...old, ...page.files.filter((file) => !old.some((item) => item.id === file.id))]
          : page.files,
      );
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (generation.current === seq && !controller.current.signal.aborted) report(cause);
    } finally {
      if (valid() && generation.current === seq) setBusy(false);
    }
  }

  async function showFile(id: string, first = 1, last = first + 99) {
    const seq = ++generation.current;
    const guard = captureAccountRequestGuard();
    setBusy(true);
    setError("");
    setSource(null);
    setConfirmDelete(null);
    // Metadata refresh must not remount an unchanged document or reset its reading position.
    if (selected?.id !== id) setSelected(null);
    try {
      const file = await client.get(id, controller.current.signal);
      guard();
      if (!valid() || generation.current !== seq) return;
      setSelected(file);
      if (
        file.state === "ready" &&
        (!file.workspace_loadable || file.text_bytes <= CLOUD_FILE_CONTEXT_BYTES)
      ) {
        const excerpt = await client.source(
          id,
          first,
          Math.min(last, first + 199),
          controller.current.signal,
        );
        guard();
        if (!valid() || generation.current !== seq) return;
        setSource(excerpt);
      }
    } catch (cause) {
      if (generation.current === seq && !controller.current.signal.aborted) report(cause);
    } finally {
      if (valid() && generation.current === seq) setBusy(false);
    }
  }

  // The parent keys the panel to its view. Callback changes do not restart work.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the modal owns one request lifetime per target
  useEffect(() => {
    mounted.current = true;
    controller.current = new AbortController();
    if (initialFileId) void showFile(initialFileId, fromLine, toLine);
    else void loadLibrary();
    return () => {
      mounted.current = false;
      generation.current++;
      controller.current.abort();
    };
  }, [client, initialFileId, fromLine, toLine]);

  async function download(file: CloudChatFile) {
    const guard = captureAccountRequestGuard();
    setBusy(true);
    setError("");
    try {
      const result = await client.download(file, controller.current.signal);
      guard();
      result.guard();
      if (!valid()) return;
      const url = URL.createObjectURL(result.blob);
      try {
        guard();
        result.guard();
        if (!valid()) return;
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (cause) {
      if (!controller.current.signal.aborted) report(cause);
    } finally {
      if (valid()) setBusy(false);
    }
  }

  async function remove(file: CloudChatFile) {
    const guard = captureAccountRequestGuard();
    setBusy(true);
    setError("");
    try {
      await client.remove(file, controller.current.signal);
      guard();
      if (!valid()) return;
      currentProps.current.onDeleted(file.id);
      setFiles((old) => old.filter((item) => item.id !== file.id));
      setSelected(null);
      setSource(null);
      setConfirmDelete(null);
    } catch (cause) {
      if (!controller.current.signal.aborted) report(cause);
    } finally {
      if (valid()) setBusy(false);
    }
  }

  function attach(file: CloudChatFile) {
    if (!valid() || busy || !currentProps.current.canAttach || !cloudFileCanReference(file)) return;
    try {
      captureAccountRequestGuard()();
      if (currentProps.current.onAttach(file) === false) {
        setError("未能添加引用，请检查草稿中的资料数量或等待当前操作完成。");
        return;
      }
      currentProps.current.onClose();
    } catch (cause) {
      report(cause);
    }
  }

  const actions = (file: CloudChatFile) => (
    <div className="flex flex-wrap items-center gap-8px">
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={busy || !props.canAttach || !cloudFileCanReference(file)}
        onClick={() => attach(file)}
      >
        引用到消息
      </Button>
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={
          busy || !file.uploaded_at || file.state === "deleting" || file.state === "deleted"
        }
        onClick={() => void download(file)}
      >
        下载原件
      </Button>
      <Button
        variant="outline"
        size="sm"
        type="button"
        className="text-destructive"
        disabled={busy}
        onClick={() => setConfirmDelete(file.id)}
      >
        删除原件
      </Button>
    </div>
  );

  return (
    <CloudChatResourcePanel
      title={
        selected ? (
          <ResourceTitleMenu name={selected.name}>
            <DropdownMenuItem className="gap-2" onClick={() => setDetailsOpen(true)}>
              <Info className="size-4" />
              文件信息
            </DropdownMenuItem>
            {props.onOpenInSpace ? (
              <DropdownMenuItem className="gap-2" onClick={props.onOpenInSpace}>
                <FolderOpen className="size-4" />
                在资料空间中打开
              </DropdownMenuItem>
            ) : null}
          </ResourceTitleMenu>
        ) : initialFileId ? (
          "文件预览"
        ) : (
          "文件库"
        )
      }
      details={
        selected && detailsOpen ? (
          <ResourceInspector title="文件详情" onClose={() => setDetailsOpen(false)}>
            <p className="font-medium">{selected.name}</p>
            <p className="text-muted-foreground">资料空间 / 上传文件</p>
            <dl>
              <dt>文件类型</dt>
              <dd>{selected.name.split(".").pop()?.toUpperCase()} 文件</dd>
              <dt>文件大小</dt>
              <dd>{(selected.size / 1024).toFixed(1)} KB</dd>
              <dt>最近更新</dt>
              <dd>{new Date(selected.updated_at).toLocaleString("zh-CN")}</dd>
              <dt>状态</dt>
              <dd>{cloudFileStatus(selected)}</dd>
              <dt>AI 使用</dt>
              <dd>{selectedUsage}</dd>
            </dl>
            {selected.conversation_id && props.onOpenSourceConversation ? (
              <dl>
                <dt>来源对话</dt>
                <dd>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-0"
                    onClick={() => props.onOpenSourceConversation?.(selected.conversation_id)}
                  >
                    打开来源对话
                  </Button>
                </dd>
              </dl>
            ) : null}
          </ResourceInspector>
        ) : null
      }
      dragResource={
        selected && props.canAttach && cloudFileCanReference(selected) && !busy
          ? { kind: "file", id: selected.id, target_id: selected.id }
          : undefined
      }
      description="查看、引用和下载你的资料，在新的对话中接着使用。"
      subtitle={
        selected
          ? `${selected.name.split(".").pop()?.toUpperCase()} · ${(selected.size / 1024).toFixed(1)} KiB · ${selected.uploaded_at && !["deleting", "deleted"].includes(selected.state) ? "原件已保存" : cloudFileStatus(selected)}`
          : undefined
      }
      headerActions={
        selected ? (
          <>
            <ReaderAction
              variant="ghost"
              size="sm"
              className="cloud-reader-reference-action"
              aria-label={props.attached ? "已添加到草稿" : "引用到消息"}
              tooltip={props.attached ? "已添加到草稿" : "引用到消息"}
              disabled={
                busy || props.attached || !props.canAttach || !cloudFileCanReference(selected)
              }
              onClick={() => attach(selected)}
            >
              {props.attached ? <Check className="size-4" /> : <Plus className="size-4" />}
              <span className="sr-only">{props.attached ? "已添加到草稿" : "引用到消息"}</span>
            </ReaderAction>
            <ReaderAction
              variant="ghost"
              size="icon-sm"
              data-reader-secondary=""
              aria-label="下载原件"
              tooltip="下载原件"
              disabled={
                busy || !selected.uploaded_at || ["deleting", "deleted"].includes(selected.state)
              }
              onClick={() => void download(selected)}
            >
              <Download className="size-4" />
              <span className="sr-only">下载原件</span>
            </ReaderAction>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label="文件更多操作"
                disabled={busy}
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={
                    busy || props.attached || !props.canAttach || !cloudFileCanReference(selected)
                  }
                  onClick={() => attach(selected)}
                  className="gap-2.5"
                >
                  <Plus className="size-4" />
                  {props.attached ? "已添加到草稿" : "引用到消息"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDetailsOpen(true)} className="gap-2.5">
                  <Info className="size-4" />
                  文件信息
                </DropdownMenuItem>
                {source ? (
                  <DropdownMenuItem
                    onClick={() => setSourceOpen((open) => !open)}
                    className="gap-2.5"
                  >
                    <FileText className="size-4" />
                    {sourceOpen ? "收起原文" : "查看原文"}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => setConfirmDelete(selected.id)}
                  className="gap-2.5 text-destructive"
                >
                  <Trash2 className="size-4" />
                  删除原件
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        ) : undefined
      }
      closeLabel="关闭文件库"
      wide={Boolean(
        selected &&
          ["docx", "pptx", "pdf", "sheet", "html", "svg"].includes(resourcePreviewKind(selected)),
      )}
      onClose={props.onClose}
    >
      {!selected && !initialFileId ? (
        <div className="flex flex-wrap items-center gap-8px">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              aria-label="筛选已加载文件"
              placeholder="筛选已加载的文件"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="rounded-full pl-9"
            />
          </div>
          {props.onUpload ? (
            <Button
              size="sm"
              disabled={busy}
              onClick={props.onUpload}
              className="gap-2 rounded-full"
            >
              <Upload className="size-4" />
              上传到对话
            </Button>
          ) : null}
          {busy ? (
            <span role="status" className="text-xs text-muted-foreground">
              正在处理…
            </span>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <CloudChatFeedback
          tone="error"
          message={error}
          compact
          actions={
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                const id = selected?.id ?? initialFileId;
                if (id) void showFile(id, fromLine, toLine);
                else void loadLibrary();
              }}
            >
              重新读取
            </Button>
          }
        />
      ) : null}
      {confirmDelete ? (
        <ResourceDeleteDialog
          open
          busy={busy}
          name={selected?.name ?? files.find((item) => item.id === confirmDelete)?.name ?? "文件"}
          description="原件将被永久删除，已有消息中的该文件和引用将无法再读取。只想从当前草稿移除时，请使用附件上的移除按钮。"
          confirmLabel="确认删除"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => {
            const file =
              selected?.id === confirmDelete
                ? selected
                : files.find((item) => item.id === confirmDelete);
            if (file) void remove(file);
          }}
        />
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <>
            {selected.uploaded_at && !["deleting", "deleted"].includes(selected.state) ? (
              <ResourcePreview
                key={`${selected.id}:${selected.sha256}`}
                resource={{ ...selected, identity: `${selected.id}:${selected.sha256}` }}
                load={async (signal) => {
                  const guard = captureAccountRequestGuard();
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
                  props.onRequestRevision && cloudFileCanReference(selected)
                    ? (comments) =>
                        currentProps.current.onRequestRevision?.(selected, comments) ?? false
                    : undefined
                }
                onDownload={() => void download(selected)}
              />
            ) : null}
            {source ? (
              <details
                className="mt-4"
                open={sourceOpen}
                onToggle={(event) => setSourceOpen(event.currentTarget.open)}
              >
                <summary className="flex min-h-11 items-center text-sm text-muted-foreground">
                  原文 · 第 {source.from_line}–{source.to_line} 行，共 {source.total_lines} 行
                </summary>
                <div className="overflow-x-auto rounded-xl border border-border bg-muted/30 p-12px font-mono text-xs">
                  {source.lines.map((line) => (
                    <div key={line.line} className="flex gap-12px">
                      <span className="min-w-40px select-none text-right text-muted-foreground">
                        L{line.line}
                      </span>
                      <pre className="m-0 whitespace-pre-wrap break-all">{line.text || " "}</pre>
                    </div>
                  ))}
                </div>
                <div className="mt-12px flex gap-8px">
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={busy || source.from_line <= 1}
                    onClick={() =>
                      void showFile(
                        selected.id,
                        Math.max(1, source.from_line - 100),
                        source.from_line - 1,
                      )
                    }
                  >
                    上一段
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={busy || source.to_line >= source.total_lines}
                    onClick={() =>
                      void showFile(selected.id, source.to_line + 1, source.to_line + 100)
                    }
                  >
                    下一段
                  </Button>
                </div>
              </details>
            ) : null}
          </>
        ) : initialFileId && busy ? (
          <div className="cloud-reader-opening">
            <PreviewLoading message="正在打开文件…" />
          </div>
        ) : files.length ? (
          <ul className="m-0 list-none space-y-12px p-0">
            {files
              .filter((file) =>
                file.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
              )
              .map((file) => (
                <li key={file.id} className="rounded-xl border border-border p-12px">
                  <div className="flex min-w-0 items-center gap-3">
                    <FileText className="size-5 shrink-0 text-muted-foreground" />
                    <button
                      type="button"
                      className="max-w-full truncate text-left text-sm font-medium underline-offset-2 hover:underline"
                      disabled={busy}
                      onClick={() => void showFile(file.id)}
                    >
                      {file.name}
                    </button>
                  </div>
                  <p className="mt-4px mb-12px text-xs text-muted-foreground">
                    {cloudFileStatus(file)} · {(file.size / 1024).toFixed(1)} KiB
                  </p>
                  {actions(file)}
                </li>
              ))}
            {files.every(
              (file) => !file.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
            ) ? (
              <li className="py-8 text-center text-sm text-muted-foreground">
                已加载文件中没有匹配项。{nextCursor ? "可加载更多文件后继续筛选。" : ""}
              </li>
            ) : null}
          </ul>
        ) : !busy ? (
          <div className="cloud-resource-empty-state">
            <FileText className="size-7 text-muted-foreground" />
            <h2 className="text-base font-medium">还没有文件</h2>
            <p className="text-sm text-muted-foreground">
              在对话中上传资料后，可在这里查看、引用和下载。
            </p>
          </div>
        ) : null}
      </div>
      {!selected && nextCursor ? (
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() => void loadLibrary(true)}
        >
          加载更多文件
        </Button>
      ) : null}
    </CloudChatResourcePanel>
  );
}
