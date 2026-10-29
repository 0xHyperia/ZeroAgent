import { Button } from "@liveagent/ui/components/ui/button";
import { Textarea } from "@liveagent/ui/components/ui/textarea";
import { useEffect, useId, useState } from "react";
import {
  type CloudAccountGuard,
  type CloudChatProjectsClient,
  type CloudMemory,
  type CloudMemorySettings,
  CloudWorkUnconfirmedError,
} from "@/lib/cloudChatProjects";
import { useCloudWorkPanel } from "./useCloudWorkPanel";

type Props = {
  client: CloudChatProjectsClient;
  captureGuard: CloudAccountGuard;
  onContextChanged?: () => void;
};

export function CloudChatMemoryPanel({ client, captureGuard, onContextChanged }: Props) {
  const memoryInputId = useId();
  const [settings, setSettings] = useState<CloudMemorySettings | null>(null);
  const [items, setItems] = useState<CloudMemory[]>([]);
  const [next, setNext] = useState("");
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<CloudMemory | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const { busy, error, run } = useCloudWorkPanel(captureGuard);

  useEffect(() => {
    void run(async (guard) => {
      const [current, page] = await Promise.all([
        client.getMemorySettings(),
        client.listMemories(),
      ]);
      guard();
      setSettings(current);
      setItems(page.items);
      setNext(page.next_before_id);
    });
  }, [client, run]);

  function refresh() {
    void run(async (guard) => {
      const [current, page] = await Promise.all([
        client.getMemorySettings(),
        client.listMemories(),
      ]);
      guard();
      setSettings(current);
      setItems(page.items);
      setNext(page.next_before_id);
      if (editing) {
        const fresh = page.items.find((item) => item.id === editing.id);
        if (fresh) setEditing(fresh);
      }
      setUnconfirmed(false);
    });
  }
  function replace(memory: CloudMemory) {
    setItems((previous) => previous.map((item) => (item.id === memory.id ? memory : item)));
  }

  return (
    <section aria-label="显式记忆" className="space-y-4 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">已保存的偏好</h2>
        <Button size="sm" variant="outline" disabled={busy} onClick={refresh}>
          刷新列表
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        仅保存你主动添加的内容。开启后，在后续请求中使用已启用的记忆；不会自动提取个人信息。
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="使用显式记忆"
          checked={settings?.enabled ?? false}
          disabled={busy || !settings}
          onChange={(event) => {
            const enabled = event.target.checked;
            if (settings)
              void run(async (guard) => {
                const updated = await client.setMemorySettings(settings, enabled);
                guard();
                setSettings(updated);
                onContextChanged?.();
              });
          }}
        />
        使用显式记忆
      </label>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async (guard) => {
            try {
              const memory = await client.createMemory(draft);
              guard();
              setItems((previous) => [memory, ...previous]);
              setDraft("");
              onContextChanged?.();
            } catch (cause) {
              guard();
              if (cause instanceof CloudWorkUnconfirmedError) setUnconfirmed(true);
              throw cause;
            }
          });
        }}
      >
        <label htmlFor={memoryInputId} className="block space-y-1">
          <span>添加记忆</span>
          <Textarea
            id={memoryInputId}
            aria-label="新记忆内容"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="例如：报告先给结论，再列出依据。"
            disabled={busy}
          />
        </label>
        <Button type="submit" size="sm" disabled={busy || unconfirmed || !draft.trim()}>
          保存记忆
        </Button>
      </form>
      <ul className="space-y-3">
        {items.map((memory) => (
          <li key={memory.id} className="space-y-2 rounded-md border p-3">
            {editing?.id === memory.id ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void run(async (guard) => {
                    const updated = await client.updateMemory(editing, editDraft, editing.enabled);
                    guard();
                    replace(updated);
                    setEditing(null);
                    onContextChanged?.();
                  });
                }}
              >
                <Textarea
                  aria-label="编辑记忆内容"
                  value={editDraft}
                  onChange={(event) => setEditDraft(event.target.value)}
                  disabled={busy}
                />
                <div className="flex gap-2">
                  <Button size="sm" type="submit" disabled={busy || !editDraft.trim()}>
                    保存修改
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    取消编辑
                  </Button>
                </div>
              </form>
            ) : (
              <p className="whitespace-pre-wrap break-words">{memory.content}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  aria-label={`启用记忆 ${memory.content.slice(0, 24)}`}
                  checked={memory.enabled}
                  disabled={busy || editing?.id === memory.id}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    void run(async (guard) => {
                      const updated = await client.updateMemory(memory, memory.content, enabled);
                      guard();
                      replace(updated);
                      onContextChanged?.();
                    });
                  }}
                />
                此条已启用
              </label>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => {
                  setEditing(memory);
                  setEditDraft(memory.content);
                  setConfirmDelete(null);
                }}
              >
                编辑
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setConfirmDelete(memory.id)}
              >
                删除
              </Button>
            </div>
            {confirmDelete === memory.id && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span>删除后不再用于后续请求。</span>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy}
                  onClick={() =>
                    void run(async (guard) => {
                      await client.removeMemory(memory);
                      guard();
                      setItems((previous) => previous.filter((item) => item.id !== memory.id));
                      setConfirmDelete(null);
                      if (editing?.id === memory.id) setEditing(null);
                      onContextChanged?.();
                    })
                  }
                >
                  确认删除记忆
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setConfirmDelete(null)}
                >
                  保留
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {!busy && items.length === 0 && (
        <p className="text-xs text-muted-foreground">还没有保存显式记忆。</p>
      )}
      {next && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(async (guard) => {
              const page = await client.listMemories(next);
              guard();
              setItems((previous) => [...previous, ...page.items]);
              setNext(page.next_before_id);
            })
          }
        >
          加载更多记忆
        </Button>
      )}
    </section>
  );
}
