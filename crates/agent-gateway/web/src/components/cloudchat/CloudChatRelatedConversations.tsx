import { MessageSquare } from "@liveagent/ui/components/IconSet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@liveagent/ui/components/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import { captureAccountRequestGuard } from "@/lib/accountRequest";
import type { createCloudChatConversationsClient } from "@/lib/cloudChatConversations";

export type ReaderConversationsClient = Pick<
  ReturnType<typeof createCloudChatConversationsClient>,
  "get"
>;

/** Titles are read through the current account's metadata endpoint, never inferred from a file. */
export function CloudChatRelatedConversations(props: {
  ids: readonly string[];
  client?: ReaderConversationsClient;
  isCurrent: () => boolean;
  onOpen?: (id: string) => void;
}) {
  const key = JSON.stringify([...new Set(props.ids.filter(Boolean))].slice(0, 20));
  const [rows, setRows] = useState<{ id: string; title: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [failed, setFailed] = useState(false);
  const { client } = props;
  const currentProps = useRef(props);
  currentProps.current = props;
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision explicitly retries an unavailable title without changing the reader.
  useEffect(() => {
    const controller = new AbortController();
    const guard = captureAccountRequestGuard();
    const isCurrent = () => currentProps.current.isCurrent();
    setRows([]);
    setLoading(true);
    setFailed(false);
    void (async () => {
      if (!client) return;
      const ids: string[] = JSON.parse(key);
      const results = await Promise.allSettled(ids.map((id) => client.get(id, controller.signal)));
      guard();
      if (controller.signal.aborted || !isCurrent()) return;
      setRows(
        results.flatMap((result) =>
          result.status === "fulfilled"
            ? [{ id: result.value.id, title: result.value.title.trim() || "未命名对话" }]
            : [],
        ),
      );
      setFailed(results.some((result) => result.status === "rejected"));
    })()
      .catch(() => {
        if (!controller.signal.aborted && isCurrent()) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted && isCurrent()) setLoading(false);
      });
    return () => controller.abort();
  }, [key, client, revision]);
  if (!props.ids.some(Boolean) || !client || !props.onOpen) return null;
  return (
    <section className="cloud-reader-related" aria-label="关联对话">
      <h4>关联对话</h4>
      {loading ? (
        <div className="cloud-reader-related-loading" role="status" aria-label="正在加载关联对话" />
      ) : (
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              <Tooltip>
                <TooltipTrigger
                  render={<button type="button" onClick={() => props.onOpen?.(row.id)} />}
                >
                  <MessageSquare className="size-4 shrink-0" />
                  <span className="truncate">{row.title}</span>
                </TooltipTrigger>
                <TooltipContent>{row.title}</TooltipContent>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      {!loading && failed ? (
        <button
          type="button"
          className="cloud-reader-related-retry"
          onClick={() => setRevision((old) => old + 1)}
        >
          重新读取关联对话
        </button>
      ) : null}
    </section>
  );
}
