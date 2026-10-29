import { FileText, Search, Upload } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useEffect, useRef, useState } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import { cloudArtifactImageDimensions } from "@/lib/cloudChatArtifacts";
import {
  CLOUD_FILE_CONTEXT_BYTES,
  type CloudChatFile,
  type CloudChatFilesClient,
  type CloudFileSource,
  cloudFileCanReference,
  cloudFileStatus,
} from "@/lib/cloudChatFiles";
import { CloudChatResourcePanel } from "./cloudchat/CloudChatResourcePanel";

type Props = {
  client: CloudChatFilesClient;
  initialFileId?: string;
  fromLine?: number;
  toLine?: number;
  canAttach: boolean;
  isCurrent: () => boolean;
  onClose: () => void;
  onAttach: (file: CloudChatFile) => void;
  onDeleted: (id: string) => void;
  onError: (cause: unknown) => void;
  onUpload?: () => void;
  onBrowseLibrary?: () => void;
};

export function CloudChatFilePanel(props: Props) {
  const { client, initialFileId, fromLine = 1, toLine = fromLine + 99 } = props;
  const [files, setFiles] = useState<CloudChatFile[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [selected, setSelected] = useState<CloudChatFile | null>(null);
  const [source, setSource] = useState<CloudFileSource | null>(null);
  const [image, setImage] = useState("");
  const imageURL = useRef("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const mounted = useRef(true);
  const controller = useRef(new AbortController());
  const generation = useRef(0);
  const currentProps = useRef(props);
  currentProps.current = props;

  function valid() {
    return mounted.current && currentProps.current.isCurrent();
  }
  function clearImage() {
    if (imageURL.current) URL.revokeObjectURL(imageURL.current);
    imageURL.current = "";
    setImage("");
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
    clearImage();
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
    clearImage();
    try {
      const file = await client.get(id, controller.current.signal);
      guard();
      if (!valid() || generation.current !== seq) return;
      setSelected(file);
      if (file.state === "vision_ready" && ["image/png", "image/jpeg"].includes(file.mime)) {
        const result = await client.download(file, controller.current.signal);
        guard();
        result.guard();
        cloudArtifactImageDimensions(new Uint8Array(await result.blob.arrayBuffer()), file.mime);
        if (!valid() || generation.current !== seq) return;
        imageURL.current = URL.createObjectURL(new Blob([result.blob], { type: file.mime }));
        setImage(imageURL.current);
      }
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
      if (imageURL.current) URL.revokeObjectURL(imageURL.current);
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
      clearImage();
      setConfirmDelete(null);
    } catch (cause) {
      if (!controller.current.signal.aborted) report(cause);
    } finally {
      if (valid()) setBusy(false);
    }
  }

  const actions = (file: CloudChatFile) => (
    <div className="flex flex-wrap items-center gap-8px">
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={busy || !props.canAttach || !cloudFileCanReference(file)}
        onClick={() => {
          if (valid()) {
            props.onAttach(file);
            props.onClose();
          }
        }}
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
      title={selected ? selected.name : "文件库"}
      description="查看、引用和下载你的资料，在新的对话中接着使用。"
      closeLabel="关闭文件库"
      onClose={props.onClose}
    >
      <div className="flex flex-wrap items-center gap-8px">
        {!selected ? (
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
        ) : null}
        {props.onUpload ? (
          <Button size="sm" disabled={busy} onClick={props.onUpload} className="gap-2 rounded-full">
            <Upload className="size-4" />
            上传到对话
          </Button>
        ) : null}
        {selected ? (
          <Button
            variant="outline"
            size="sm"
            type="button"
            disabled={busy}
            onClick={() => (props.onBrowseLibrary ? props.onBrowseLibrary() : void loadLibrary())}
          >
            全部文件
          </Button>
        ) : null}
        <Button
          variant="outline"
          size="sm"
          type="button"
          disabled={busy}
          onClick={() =>
            selected
              ? void showFile(selected.id, source?.from_line ?? 1, source?.to_line ?? 100)
              : void loadLibrary()
          }
        >
          刷新状态
        </Button>
        {busy ? (
          <span role="status" className="text-xs text-muted-foreground">
            正在处理…
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {confirmDelete ? (
        <div className="rounded-xl border border-destructive/30 p-12px text-sm" role="alert">
          <p>确认删除原件？已有消息中的该文件和引用将无法再读取。</p>
          <div className="mt-8px flex gap-8px">
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => {
                const file =
                  selected?.id === confirmDelete
                    ? selected
                    : files.find((item) => item.id === confirmDelete);
                if (file) void remove(file);
              }}
            >
              确认删除
            </Button>
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={busy}
              onClick={() => setConfirmDelete(null)}
            >
              保留文件
            </Button>
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <>
            <p className="mb-12px text-sm text-muted-foreground">
              {cloudFileStatus(selected)} · {(selected.size / 1024).toFixed(1)} KiB
            </p>
            {actions(selected)}
            {image ? (
              <img src={image} alt={selected.name} className="cloud-space-original-image" />
            ) : null}
            {source ? (
              <>
                <p className="mt-16px mb-8px text-xs text-muted-foreground">
                  原文第 {source.from_line}–{source.to_line} 行，共 {source.total_lines} 行
                </p>
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
              </>
            ) : selected.state === "vision_ready" ? (
              <p className="mt-16px text-sm text-muted-foreground">
                引用图片后，可由支持视觉的模型理解。此文件没有文字原文。
              </p>
            ) : selected.workspace_loadable ? (
              <p className="mt-16px text-sm text-muted-foreground">
                {selected.mime === "application/zip"
                  ? "ZIP 原件已保存。引用后可在隔离沙箱中读取或解压；这不表示压缩包内的文件已解析，也不会自动运行其中的代码。"
                  : "原件已保存。引用后可在隔离沙箱中读取；这不表示文件已完成文本解析。"}
              </p>
            ) : selected.state !== "ready" ? (
              <p className="mt-16px text-sm text-muted-foreground">
                该文件目前无法供模型理解。你可以下载原件，或稍后刷新解析状态。
              </p>
            ) : null}
          </>
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
