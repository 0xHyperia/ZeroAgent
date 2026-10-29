import { buttonVariants } from "@liveagent/ui/components/ui/button";
import { useEffect, useRef, useState } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import {
  type CloudChatSource,
  type CloudChatSourceExcerpt,
  type CloudChatSourcesClient,
  cloudSourceExternalURL,
} from "@/lib/cloudChatSources";
import { CloudChatResourcePanel } from "./CloudChatResourcePanel";

type Props = {
  client: CloudChatSourcesClient;
  initialSourceId?: string;
  fromLine?: number;
  toLine?: number;
  isCurrent: () => boolean;
  onClose: () => void;
  onDeleted?: (id: string) => void;
  onError?: (cause: unknown) => void;
};
const buttonClass = buttonVariants({ variant: "outline", size: "sm" });

export function CloudChatSourcesPanel(props: Props) {
  const { client, initialSourceId, fromLine = 1, toLine = fromLine + 99 } = props;
  const [items, setItems] = useState<CloudChatSource[]>([]);
  const [nextCursor, setNextCursor] = useState("");
  const [selected, setSelected] = useState<CloudChatSource | null>(null);
  const [excerpt, setExcerpt] = useState<CloudChatSourceExcerpt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const mounted = useRef(true),
    generation = useRef(0);
  const abort = useRef(new AbortController());
  const metadataGuard = useRef<(() => void) | null>(null);
  const currentProps = useRef(props);
  currentProps.current = props;
  function valid() {
    return mounted.current && currentProps.current.isCurrent();
  }
  function report(cause: unknown) {
    if (valid()) {
      setError(cause instanceof Error ? cause.message : "来源暂时不可用。");
      currentProps.current.onError?.(cause);
    }
  }

  async function loadList(append = false) {
    const seq = ++generation.current,
      guard = captureAccountRequestGuard();
    setBusy(true);
    setError("");
    setSelected(null);
    setExcerpt(null);
    setConfirmDelete(false);
    try {
      const page = await client.list({
        before: append ? nextCursor : undefined,
        signal: abort.current.signal,
      });
      guard();
      if (!valid() || generation.current !== seq) return;
      metadataGuard.current = guard;
      setItems((old) =>
        append
          ? [...old, ...page.sources.filter((source) => !old.some((item) => item.id === source.id))]
          : page.sources,
      );
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (generation.current === seq && !abort.current.signal.aborted) report(cause);
    } finally {
      if (valid() && generation.current === seq) setBusy(false);
    }
  }
  async function showSource(id: string, first = 1, last = first + 99) {
    const seq = ++generation.current,
      guard = captureAccountRequestGuard();
    setBusy(true);
    setError("");
    setSelected(null);
    setExcerpt(null);
    setConfirmDelete(false);
    try {
      const source = await client.get(id, abort.current.signal);
      guard();
      if (!valid() || generation.current !== seq) return;
      metadataGuard.current = guard;
      setSelected(source);
      if (source.kind === "page") {
        const content = await client.excerpt(
          id,
          first,
          Math.min(last, first + 199),
          abort.current.signal,
        );
        guard();
        if (!valid() || generation.current !== seq) return;
        if (content.sha256 !== source.sha256 || content.total_lines !== source.line_count)
          throw new Error("来源快照已变化，请刷新后核对。");
        setExcerpt(content);
      }
    } catch (cause) {
      if (generation.current === seq && !abort.current.signal.aborted) report(cause);
    } finally {
      if (valid() && generation.current === seq) setBusy(false);
    }
  }

  // The parent keys this controlled panel to its account/conversation view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: callbacks must not restart the panel's request lifetime
  useEffect(() => {
    mounted.current = true;
    abort.current = new AbortController();
    if (initialSourceId) void showSource(initialSourceId, fromLine, toLine);
    else void loadList();
    return () => {
      mounted.current = false;
      generation.current++;
      abort.current.abort();
    };
  }, [client, initialSourceId, fromLine, toLine]);

  async function remove() {
    if (!selected || !valid()) return;
    const guard = captureAccountRequestGuard();
    setBusy(true);
    setError("");
    try {
      metadataGuard.current?.();
      await client.remove(selected, abort.current.signal);
      guard();
      if (!valid()) return;
      currentProps.current.onDeleted?.(selected.id);
      setItems((old) => old.filter((item) => item.id !== selected.id));
      setSelected(null);
      setExcerpt(null);
      setConfirmDelete(false);
      await loadList();
    } catch (cause) {
      if (!abort.current.signal.aborted) report(cause);
    } finally {
      if (valid()) setBusy(false);
    }
  }
  const external = selected ? cloudSourceExternalURL(selected.final_url || selected.url) : null;
  function checkedView(id: string) {
    try {
      metadataGuard.current?.();
      if (valid()) void showSource(id);
    } catch (cause) {
      report(cause);
    }
  }

  return (
    <CloudChatResourcePanel
      title={selected?.title || (selected ? external?.host : "来源资料库")}
      description="来源是外部资料。删除对话会保留快照，删除来源会使已有引用无法查看。"
      closeLabel="关闭来源资料"
      onClose={props.onClose}
    >
      <div className="flex flex-wrap items-center gap-8px">
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void loadList()}
        >
          全部来源
        </button>
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() =>
            selected
              ? void showSource(selected.id, excerpt?.from_line ?? 1, excerpt?.to_line ?? 100)
              : void loadList()
          }
        >
          刷新资料
        </button>
        {busy ? (
          <span role="status" className="text-xs text-muted-foreground">
            正在读取快照…
          </span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <>
            <p className="mb-8px text-sm text-muted-foreground">
              {selected.kind === "page" ? "网页正文快照" : "搜索摘要，未抓取网页正文"}
              {selected.truncated ? " · 已截断" : ""}
            </p>
            <p className="mb-12px text-xs text-muted-foreground">
              {selected.kind === "page" ? "抓取" : "搜索"}时间：
              {new Date(selected.observed_at).toLocaleString()}
            </p>
            {external ? (
              <a
                className="inline-block max-w-full break-all text-sm text-sky-600 underline-offset-2 hover:underline"
                href={external.href}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(event) => {
                  try {
                    metadataGuard.current?.();
                    if (!valid()) event.preventDefault();
                  } catch {
                    event.preventDefault();
                  }
                }}
              >
                打开{selected.kind === "page" ? "原网页" : "搜索结果网页"} · {external.host}
              </a>
            ) : null}
            {selected.kind === "search_snippet" ? (
              <p className="mt-16px whitespace-pre-wrap break-words rounded-xl border border-border bg-muted/30 p-12px text-sm">
                {selected.snippet || "该搜索结果没有提供摘要。"}
              </p>
            ) : null}
            {excerpt ? (
              <>
                <p className="mt-16px mb-8px text-xs text-muted-foreground">
                  快照第 {excerpt.from_line}–{excerpt.to_line} 行，共 {excerpt.total_lines} 行
                </p>
                <div className="overflow-x-auto rounded-xl border border-border bg-muted/30 p-12px font-mono text-xs">
                  {excerpt.lines.map((line) => (
                    <div key={line.line} className="flex gap-12px">
                      <span className="min-w-40px select-none text-right text-muted-foreground">
                        L{line.line}
                      </span>
                      <pre className="m-0 whitespace-pre-wrap break-all">{line.text || " "}</pre>
                    </div>
                  ))}
                </div>
                <div className="mt-12px flex gap-8px">
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy || excerpt.from_line <= 1}
                    onClick={() =>
                      void showSource(
                        selected.id,
                        Math.max(1, excerpt.from_line - 100),
                        excerpt.from_line - 1,
                      )
                    }
                  >
                    上一段
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy || excerpt.to_line >= excerpt.total_lines}
                    onClick={() =>
                      void showSource(selected.id, excerpt.to_line + 1, excerpt.to_line + 100)
                    }
                  >
                    下一段
                  </button>
                </div>
              </>
            ) : null}
            <div className="mt-16px">
              <button
                type="button"
                className={`${buttonClass} text-destructive`}
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                删除此快照
              </button>
            </div>
            {confirmDelete ? (
              <div
                role="alert"
                className="mt-12px rounded-xl border border-destructive/30 p-12px text-sm"
              >
                <p>已有引用将无法查看此快照。模型已使用的内容仍可能保留在对话中。</p>
                <div className="mt-8px flex gap-8px">
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    确认删除来源
                  </button>
                  <button
                    type="button"
                    className={buttonClass}
                    disabled={busy}
                    onClick={() => setConfirmDelete(false)}
                  >
                    保留快照
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : items.length ? (
          <ul className="m-0 list-none space-y-12px p-0">
            {items.map((source) => (
              <li key={source.id} className="rounded-xl border border-border p-12px">
                <button
                  type="button"
                  className="max-w-full truncate text-left text-sm font-medium hover:underline"
                  disabled={busy}
                  onClick={() => checkedView(source.id)}
                >
                  {source.title || cloudSourceExternalURL(source.final_url || source.url)?.host}
                </button>
                <p className="mt-4px text-xs text-muted-foreground">
                  {source.kind === "page" ? "网页快照" : "搜索摘要"} ·{" "}
                  {cloudSourceExternalURL(source.final_url || source.url)?.host}
                  {source.truncated ? " · 已截断" : ""}
                </p>
              </li>
            ))}
          </ul>
        ) : !busy ? (
          <p className="py-24px text-center text-sm text-muted-foreground">
            尚未保存来源。联网工具实际获取的资料会保留在这里。
          </p>
        ) : null}
      </div>
      {!selected && nextCursor ? (
        <button
          type="button"
          className={buttonClass}
          disabled={busy}
          onClick={() => void loadList(true)}
        >
          加载更多来源
        </button>
      ) : null}
    </CloudChatResourcePanel>
  );
}
