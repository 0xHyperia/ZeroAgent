import type { CloudChatDraft } from "./cloudChatDrafts";
import {
  type CloudChatPendingInput,
  type CloudChatPendingItem,
  type CloudChatPendingQueue,
  CloudChatPendingSubmitUnknownError,
  CloudChatQueueError,
  type createCloudChatQueueClient,
} from "./cloudChatQueue";
import type { CloudChatRun } from "./cloudChatRuns";

export type CloudChatQueueClient = ReturnType<typeof createCloudChatQueueClient>;
export type CloudChatQueueUnknown =
  | { kind: "enqueue"; item: CloudChatPendingInput }
  | { kind: "submit"; item: CloudChatPendingItem }
  | { kind: "mutation"; itemId?: string };
export type CloudChatQueueSnapshot = {
  queue: CloudChatPendingQueue | null;
  loading: boolean;
  busy: boolean;
  paused: boolean;
  error: string;
  editingItem: CloudChatPendingItem | null;
  unknown: CloudChatQueueUnknown | null;
};
export type CloudChatQueueHost = {
  onAccepted: (run: CloudChatRun, item?: CloudChatPendingItem) => void | Promise<void>;
  onEdit?: (item: CloudChatPendingItem) => void | Promise<void>;
  captureDraft?: () => CloudChatDraft;
  restoreDraft?: (draft: CloudChatDraft) => void | Promise<void>;
};
const active = (run: CloudChatRun | null) =>
  !!run && ["queued", "running", "cancelling"].includes(run.state);
const message = (error: unknown) =>
  error instanceof Error ? error.message : "暂时无法更新尚未发送列表，请重试。";
const uncertain = (error: unknown) => !(error instanceof CloudChatQueueError && error.status < 500);

function stableJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJSON).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, field]) => `${JSON.stringify(key)}:${stableJSON(field)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
/** Compare server-normalized content before acknowledging a lost enqueue receipt. */
function sameEnqueuedInput(left: CloudChatPendingInput, right: CloudChatPendingInput) {
  const logical = (item: CloudChatPendingInput) => {
    const params = item.model_parameters ?? {};
    const content = Array.isArray(item.content)
      ? item.content.map((part) =>
          part?.type === "file_reference"
            ? { type: part.type, file_id: part.file_id }
            : part?.type === "artifact_reference"
              ? { type: part.type, version_id: part.version_id }
              : part,
        )
      : item.content;
    return {
      content,
      model: item.model.trim(),
      provider: item.provider_key_id || 0,
      reasoning: item.reasoning_effort || "",
      presentation: item.presentation,
      research: item.public_research?.topic.trim() || "",
      composer: item.composer?.segments ?? null,
      parameters: {
        request_format: params.request_format || "openai-completions",
        time_zone: params.time_zone || "UTC",
        locale: params.locale || "und",
        context_window: params.context_window || 0,
        max_output_tokens:
          params.max_output_tokens ||
          (params.context_window ? Math.min(8192, Math.floor(params.context_window / 4)) : 0),
        provider_cache_mode: params.provider_cache_mode || "auto",
        model_cache_mode: params.model_cache_mode || "",
        input_modalities: params.input_modalities || ["text", "image"],
      },
    };
  };
  return stableJSON(logical(left)) === stableJSON(logical(right));
}

export function cloudChatQueuedPreviews(items: readonly CloudChatPendingItem[]) {
  return items.map((item) => {
    const content = Array.isArray(item.content) ? item.content : [];
    const text =
      item.composer?.text ||
      (typeof item.content === "string"
        ? item.content
        : content
            .filter((part) => part && part.type === "text" && typeof part.text === "string")
            .map((part) => part.text)
            .join("\n"));
    return {
      id: item.client_item_id,
      previewText: text.slice(0, 240) || "附带资料的消息",
      fileCount: content.filter(
        (part) => part && ["file_reference", "artifact_reference"].includes(part.type),
      ).length,
    };
  });
}

/** One account/conversation controller. Reads never enable dispatch. No retry timer exists. */
export class CloudChatQueueController {
  private snapshot: CloudChatQueueSnapshot = {
    queue: null,
    loading: false,
    busy: false,
    paused: true,
    error: "",
    editingItem: null,
    unknown: null,
  };
  private listeners = new Set<() => void>();
  private mounted = false;
  private run: CloudChatRun | null = null;
  private blocked = false;
  private awaitingRunId: string | null = null;
  private beforeEditing: CloudChatDraft | null = null;
  private deferredEditDraft: CloudChatDraft | null = null;
  private readEpoch = 0;
  private acceptedForHost: { run: CloudChatRun; item?: CloudChatPendingItem } | null = null;

  constructor(
    readonly conversationId: string,
    private client: CloudChatQueueClient,
    private host: CloudChatQueueHost,
  ) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  setHost(host: CloudChatQueueHost) {
    this.host = host;
  }
  setClient(client: CloudChatQueueClient) {
    this.client = client;
  }
  private patch(next: Partial<CloudChatQueueSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
  activate() {
    this.mounted = true;
    this.patch({ paused: true });
    if (this.deferredEditDraft && !this.snapshot.busy) void this.restoreDeferredDraft();
    else void this.refresh();
  }
  private async restoreDeferredDraft() {
    const draft = this.deferredEditDraft;
    if (!draft || !this.mounted) return;
    this.patch({ busy: true });
    try {
      await this.host.restoreDraft?.(structuredClone(draft));
      if (this.deferredEditDraft === draft) this.deferredEditDraft = null;
    } catch (error) {
      this.patch({ error: message(error) });
    } finally {
      this.patch({ busy: false });
    }
    if (this.mounted && !this.deferredEditDraft) await this.refresh();
  }
  suspend(notify = true) {
    this.mounted = false;
    this.readEpoch++;
    if (notify) this.patch({ paused: true, loading: false });
    else this.snapshot = { ...this.snapshot, paused: true, loading: false };
    // A write may already have reached the server. Its receipt is retained in this scope.
  }
  setRuntime(run: CloudChatRun | null, blocked: boolean) {
    const previous = this.run;
    this.run = run?.conversation_id === this.conversationId ? run : null;
    this.blocked = blocked;
    if (this.run && !active(this.run)) {
      if (this.awaitingRunId === this.run.id) this.awaitingRunId = null;
      if (
        this.run.state !== "completed" &&
        (previous?.id !== this.run.id || previous.state !== this.run.state)
      )
        this.pause();
    }
    this.kick();
  }
  private canAct() {
    return this.mounted && !this.snapshot.busy && !this.snapshot.loading && !this.deferredEditDraft;
  }
  private canDispatch() {
    return (
      this.canAct() &&
      !this.blocked &&
      !active(this.run) &&
      !this.awaitingRunId &&
      !this.snapshot.unknown &&
      !this.snapshot.editingItem &&
      !this.acceptedForHost
    );
  }
  private kick() {
    if (this.snapshot.paused || !this.canDispatch()) return;
    const first = this.snapshot.queue?.items[0];
    if (first) void this.submit(first);
    else this.patch({ paused: true });
  }
  pause = () => {
    this.patch({ paused: true });
  };
  resume = async () => {
    if (!this.canAct() || this.snapshot.unknown || this.snapshot.editingItem) return false;
    if (this.acceptedForHost) {
      const receipt = this.acceptedForHost;
      this.patch({ busy: true, error: "", paused: true });
      try {
        await this.host.onAccepted(receipt.run, receipt.item);
        if (!this.mounted) return false;
        this.acceptedForHost = null;
      } catch (error) {
        this.patch({ error: message(error) });
        return false;
      } finally {
        this.patch({ busy: false });
      }
    }
    if (!this.snapshot.queue || this.blocked) return false;
    this.patch({ paused: false, error: "" });
    this.kick();
    return true;
  };

  refresh = async () => {
    this.pause();
    if (!this.mounted || this.snapshot.busy) return false;
    if (this.deferredEditDraft) {
      await this.restoreDeferredDraft();
      return !this.deferredEditDraft;
    }
    const epoch = ++this.readEpoch;
    this.patch({ loading: true, error: "" });
    try {
      const queue = await this.client.list(this.conversationId);
      if (epoch !== this.readEpoch || !this.mounted) return false;
      this.patch({ queue });
      return true;
    } catch (error) {
      if (epoch === this.readEpoch && this.mounted) this.patch({ error: message(error) });
      return false;
    } finally {
      if (epoch === this.readEpoch) this.patch({ loading: false });
    }
  };

  enqueue = async (input: CloudChatPendingInput) => {
    if (
      !this.canAct() ||
      !this.snapshot.queue ||
      this.snapshot.unknown ||
      this.snapshot.editingItem
    )
      return false;
    const item = structuredClone(input);
    const expectedVersion = this.snapshot.queue.version;
    this.patch({ busy: true, error: "", paused: false });
    try {
      const queue = await this.client.enqueue(this.conversationId, expectedVersion, item);
      this.patch({ queue });
      return true;
    } catch (error) {
      this.patch({
        paused: true,
        error: uncertain(error)
          ? "排队结果尚未确认，草稿已保留。请先核对这条消息。"
          : message(error),
        unknown: uncertain(error) ? { kind: "enqueue", item } : null,
      });
      return false;
    } finally {
      this.patch({ busy: false });
      this.kick();
    }
  };

  beginEdit = async (id: string) => {
    if (!this.canAct() || this.snapshot.unknown || this.snapshot.editingItem) return false;
    const item = this.snapshot.queue?.items.find((entry) => entry.client_item_id === id);
    if (!item || !this.host.onEdit) return false;
    this.pause();
    const currentDraft = this.host.captureDraft?.();
    this.beforeEditing = currentDraft ? structuredClone(currentDraft) : null;
    const epoch = this.readEpoch;
    this.patch({ busy: true, error: "", editingItem: structuredClone(item) });
    try {
      await this.host.onEdit(structuredClone(item));
      if (epoch !== this.readEpoch || !this.mounted) {
        // The host may have intentionally ignored a late resource read after navigation.
        // Do not relabel the ordinary composer as an edit of this queued message on return.
        this.beforeEditing = null;
        this.patch({ editingItem: null });
        return false;
      }
      return this.mounted;
    } catch (error) {
      this.patch({ error: message(error), editingItem: null });
      return false;
    } finally {
      this.patch({ busy: false });
    }
  };
  private async finishEdit() {
    const previous = this.beforeEditing;
    if (previous && this.mounted) await this.host.restoreDraft?.(structuredClone(previous));
    else if (previous) this.deferredEditDraft = previous;
    this.beforeEditing = null;
    this.patch({ editingItem: null });
  }
  cancelEdit = async () => {
    if (!this.canAct() || this.snapshot.unknown) return false;
    this.patch({ busy: true });
    try {
      await this.finishEdit();
      return true;
    } catch (error) {
      this.patch({ error: message(error) });
      return false;
    } finally {
      this.patch({ busy: false });
    }
  };
  saveEdit = async (input: CloudChatPendingInput) => {
    const item = this.snapshot.editingItem;
    if (
      !this.canAct() ||
      this.snapshot.unknown ||
      !item ||
      item.client_item_id !== input.client_item_id
    )
      return false;
    this.patch({ busy: true, error: "", paused: true });
    let saved = false;
    try {
      const queue = await this.client.edit(
        this.conversationId,
        item.client_item_id,
        item.version,
        structuredClone(input),
      );
      saved = true;
      this.patch({ queue });
      await this.finishEdit();
      return true;
    } catch (error) {
      this.patch({
        error: message(error),
        unknown:
          !saved && uncertain(error) ? { kind: "mutation", itemId: item.client_item_id } : null,
      });
      return false;
    } finally {
      this.patch({ busy: false });
    }
  };

  private async mutate(action: () => Promise<CloudChatPendingQueue>, itemId?: string) {
    if (!this.canAct() || this.snapshot.unknown || this.snapshot.editingItem) return false;
    this.patch({ busy: true, error: "" });
    try {
      this.patch({ queue: await action() });
      return true;
    } catch (error) {
      this.patch({
        paused: true,
        error: message(error),
        unknown: uncertain(error) ? { kind: "mutation", itemId } : null,
      });
      return false;
    } finally {
      this.patch({ busy: false });
      this.kick();
    }
  }
  remove = async (id: string) => {
    const item = this.snapshot.queue?.items.find((entry) => entry.client_item_id === id);
    if (!item) return false;
    return this.mutate(() => this.client.remove(this.conversationId, id, item.version), id);
  };
  reorder = async (ids: string[]) => {
    const version = this.snapshot.queue?.version;
    if (version === undefined) return false;
    return this.mutate(() => this.client.reorder(this.conversationId, version, ids));
  };
  moveUp = async (id: string) => {
    const ids = this.snapshot.queue?.items.map((item) => item.client_item_id) ?? [];
    const index = ids.indexOf(id);
    if (index < 1) return false;
    [ids[index - 1], ids[index]] = [ids[index], ids[index - 1]];
    return this.reorder(ids);
  };

  runNow = async (id: string) => {
    if (!this.canDispatch()) return false;
    const item = this.snapshot.queue?.items.find((entry) => entry.client_item_id === id);
    if (!item) return false;
    // Send this item without interrupting or cancelling an existing task.
    return this.submit(item);
  };
  private async accepted(run: CloudChatRun, item?: CloudChatPendingItem) {
    if (active(run)) this.awaitingRunId = run.id;
    else if (run.state !== "completed") this.pause();
    // Retain the receipt until the host has attached history/subscription successfully.
    this.acceptedForHost = { run, item };
    if (this.mounted) {
      await this.host.onAccepted(run, item);
      if (this.mounted) this.acceptedForHost = null;
    }
  }
  private async submit(item: CloudChatPendingItem) {
    if (!this.canDispatch()) return false;
    this.patch({ busy: true, error: "" });
    let accepted = false;
    try {
      const run = await this.client.submit(this.conversationId, item.client_item_id, item.version);
      accepted = true;
      // This GET only refreshes persisted order; failure cannot make the accepted item resendable.
      await this.accepted(run, item);
      const queue = await this.client.list(this.conversationId);
      this.patch({ queue });
      return true;
    } catch (error) {
      this.patch({
        paused: true,
        error: accepted ? "消息已发送，请刷新列表后继续。" : message(error),
        unknown:
          !accepted && error instanceof CloudChatPendingSubmitUnknownError
            ? { kind: "submit", item: structuredClone(item) }
            : accepted
              ? { kind: "mutation" }
              : null,
      });
      return false;
    } finally {
      this.patch({ busy: false });
      this.kick();
    }
  }

  /** Only GETs while uncertain; absence is not proof that an in-flight write failed. */
  reconcileUnknown = async (): Promise<CloudChatPendingItem | CloudChatRun | null> => {
    const unknown = this.snapshot.unknown;
    if (!this.canAct() || !unknown) return null;
    this.patch({ busy: true, error: "", paused: true });
    try {
      const queue = await this.client.list(this.conversationId);
      this.patch({ queue });
      if (unknown.kind === "mutation") {
        this.patch({ unknown: null });
        // Editing keeps the user's text; refreshed CAS is available for explicit save.
        const editingItem = this.snapshot.editingItem;
        if (editingItem) {
          const fresh = queue.items.find(
            (item) => item.client_item_id === editingItem.client_item_id,
          );
          if (fresh) this.patch({ editingItem: fresh });
          else
            this.patch({
              error: "这条待发消息已在其他页面移除。当前编辑仍为你保留，可取消编辑返回原草稿。",
            });
        }
        return null;
      }
      const id = unknown.item.client_item_id;
      const pending = queue.items.find((item) => item.client_item_id === id);
      if (unknown.kind === "enqueue" && pending) {
        const unchanged = sameEnqueuedInput(unknown.item, pending);
        this.patch({
          unknown: null,
          error: unchanged ? "" : "这条消息已在其他页面修改，当前草稿仍为你保留。",
        });
        return unchanged ? pending : null;
      }
      const run = await this.client.findSubmitted(this.conversationId, id);
      if (run) {
        const source = unknown.kind === "submit" ? unknown.item : pending;
        await this.accepted(run, source);
        this.patch({ unknown: null });
        return run;
      }
      this.patch({
        error: "结果仍未确认，原消息与请求标识已保留。请稍后再次核对。",
      });
      return null;
    } catch (error) {
      this.patch({ error: message(error) });
      return null;
    } finally {
      this.patch({ busy: false });
    }
  };
}
