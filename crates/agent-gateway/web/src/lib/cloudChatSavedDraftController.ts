import {
  type CloudChatSavedDraft,
  type CloudChatSavedDraftsClient,
  CloudSavedDraftError,
  type CloudSavedDraftOperation,
  type CloudSavedDraftSnapshot,
  CloudSavedDraftUnconfirmedError,
  cloudSavedDraftEqual,
  cloudSavedDraftScope,
  parseCloudChatSavedDraft,
} from "./cloudChatSavedDrafts";

export type CloudSavedDraftStatus =
  | "loading"
  | "ready"
  | "dirty"
  | "saving"
  | "unknown"
  | "conflict"
  | "error";
export type CloudSavedDraftState = {
  scope: string;
  status: CloudSavedDraftStatus;
  dirty: boolean;
  error: string;
  updatedAt?: string;
  conflict?: { server: CloudSavedDraftSnapshot | null };
  backgroundPendingCount: number;
};
type Operation = CloudSavedDraftOperation & { draft: CloudChatSavedDraft | null; edit: number };
type Entry = {
  scope: string;
  local: CloudChatSavedDraft | null;
  remote?: CloudSavedDraftSnapshot;
  status: CloudSavedDraftStatus;
  error: string;
  dirty: boolean;
  edit: number;
  invalidCapture?: boolean;
  resetIntent?: boolean;
  conflictRead?: number;
  conflict?: { server: CloudSavedDraftSnapshot | null };
  pending?: Operation;
  timer?: ReturnType<typeof setTimeout>;
  loading?: Promise<boolean>;
  saving?: Promise<boolean>;
};
type Options = {
  client: CloudChatSavedDraftsClient;
  /** Must fence even if an old tab receives a response before React runs effect cleanup. */
  isOwnerCurrent: () => boolean;
  apply: (draft: CloudChatSavedDraft | null, scope: string) => void;
  changed?: (state: CloudSavedDraftState) => void;
  debounceMs?: number;
  operationId?: () => string;
};
function hasContent(value: CloudChatSavedDraft | null) {
  return Boolean(
    value &&
      ((!value.draft.composer?.isEmpty && value.draft.composer) ||
        value.draft.files.length ||
        value.draft.artifacts.length),
  );
}

/** Account-owned coordinator; it never schedules a model run or stores private content in localStorage. */
export class CloudSavedDraftController {
  private entries = new Map<string, Entry>();
  private current = "blank";
  private disposed = false;
  private aborts = new Set<AbortController>();
  constructor(private readonly options: Options) {}

  private alive() {
    return !this.disposed && this.options.isOwnerCurrent();
  }
  private valid(entry: Entry) {
    return this.alive() && this.entries.get(entry.scope) === entry;
  }
  private emit() {
    if (this.alive()) this.options.changed?.(this.getState());
  }
  getState(): CloudSavedDraftState {
    const entry = this.entries.get(this.current);
    return {
      scope: this.current,
      status: entry?.status ?? "loading",
      dirty: entry?.dirty ?? false,
      error: entry?.error ?? "",
      ...(entry?.remote?.updated_at ? { updatedAt: entry.remote.updated_at } : {}),
      ...(entry?.conflict ? { conflict: entry.conflict } : {}),
      backgroundPendingCount: [...this.entries.values()].filter(
        (value) => value.scope !== this.current && (value.dirty || value.pending),
      ).length,
    };
  }
  private stopTimer(entry: Entry) {
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  private schedule(entry: Entry) {
    this.stopTimer(entry);
    if (!this.valid(entry) || entry.conflict || entry.status === "unknown" || !entry.dirty) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.flush(entry.scope);
    }, this.options.debounceMs ?? 700);
  }
  private apply(entry: Entry) {
    if (this.valid(entry) && entry.scope === this.current)
      this.options.apply(structuredClone(entry.local), entry.scope);
  }

  /** Navigation flushes captured edits from the old scope; a GET alone never writes. */
  activate(scope: string, initial?: CloudChatSavedDraft | null): Promise<boolean> {
    if (!this.alive()) return Promise.resolve(false);
    scope = cloudSavedDraftScope(scope);
    const previous = this.entries.get(this.current);
    if (previous && previous.scope !== scope) void this.flush(previous.scope);
    this.current = scope;
    let entry = this.entries.get(scope);
    if (entry) {
      this.apply(entry);
      this.emit();
      return entry.loading ?? Promise.resolve(Boolean(entry.remote));
    }
    entry = {
      scope,
      local: initial ? parseCloudChatSavedDraft(initial) : null,
      status: "loading",
      error: "",
      dirty: false,
      edit: 0,
    };
    this.entries.set(scope, entry);
    this.emit();
    return this.load(entry);
  }
  private load(entry: Entry): Promise<boolean> {
    if (entry.loading) return entry.loading;
    const startedEdit = entry.edit;
    const abort = new AbortController();
    this.aborts.add(abort);
    entry.status = "loading";
    entry.error = "";
    this.emit();
    const work = async () => {
      try {
        const remote = await this.options.client.get(entry.scope, abort.signal);
        if (!this.valid(entry)) return false;
        const previous = entry.remote;
        entry.remote = remote;
        if (entry.invalidCapture) {
          entry.status = "error";
          return false;
        }
        if (entry.resetIntent) {
          entry.resetIntent = false;
          entry.status = "dirty";
          entry.dirty = true;
          return true;
        }
        // A new local edit or a host-owned navigation draft wins over a delayed read.
        if (entry.dirty || entry.edit !== startedEdit || hasContent(entry.local)) {
          if (cloudSavedDraftEqual(entry.local, remote.draft)) {
            entry.dirty = false;
            entry.status = "ready";
          } else if (
            remote.draft !== null &&
            !cloudSavedDraftEqual(remote.draft, previous?.draft ?? null)
          ) {
            entry.dirty = true;
            entry.status = "conflict";
            entry.conflict = { server: remote };
          } else {
            entry.dirty = true;
            entry.status = "dirty";
            // Initial restoration is read-only; only explicit edits trigger autosave.
            if (entry.edit !== startedEdit || startedEdit > 0) this.schedule(entry);
          }
        } else {
          if (remote.draft !== null) {
            entry.local = remote.draft;
            this.apply(entry);
          }
          entry.dirty = false;
          entry.status = "ready";
        }
        return true;
      } catch (cause) {
        if (!this.valid(entry)) return false;
        entry.status = "error";
        entry.error =
          cause instanceof CloudSavedDraftError
            ? cause.message
            : "暂时无法读取草稿，当前输入已保留。";
        return false;
      } finally {
        this.aborts.delete(abort);
        if (this.valid(entry)) {
          entry.loading = undefined;
          this.emit();
        }
      }
    };
    entry.loading = work();
    return entry.loading;
  }

  markDirty(value: CloudChatSavedDraft): void {
    const entry = this.entries.get(this.current);
    if (!entry || !this.valid(entry)) return;
    let next: CloudChatSavedDraft;
    try {
      next = parseCloudChatSavedDraft(value);
    } catch (cause) {
      entry.invalidCapture = true;
      entry.dirty = true;
      entry.status = "error";
      entry.error = cause instanceof Error ? cause.message : "草稿暂时无法同步，当前输入已保留。";
      this.stopTimer(entry);
      this.emit();
      return;
    }
    const recovered = entry.invalidCapture;
    entry.invalidCapture = false;
    if (cloudSavedDraftEqual(next, entry.local) && !recovered) return;
    entry.local = next;
    entry.edit++;
    entry.dirty = true;
    entry.error = "";
    if (!entry.conflict && entry.status !== "unknown") {
      entry.status = entry.saving ? "saving" : "dirty";
      this.schedule(entry);
    }
    this.emit();
  }

  async flush(scope = this.current, reconcile = false): Promise<boolean> {
    const entry = this.entries.get(cloudSavedDraftScope(scope));
    if (!entry || !this.valid(entry)) return false;
    this.stopTimer(entry);
    if (entry.loading) await entry.loading;
    if (
      !this.valid(entry) ||
      entry.invalidCapture ||
      entry.conflict ||
      (entry.status === "unknown" && !reconcile)
    )
      return false;
    if (entry.saving) {
      const saved = await entry.saving;
      return saved && entry.dirty ? this.flush(scope, reconcile) : saved;
    }
    if (!entry.dirty && !entry.pending) return true;
    if (!entry.remote && !(await this.load(entry))) return false;
    if (!entry.remote || !this.valid(entry) || entry.conflict) return false;
    if (!entry.pending)
      entry.pending = {
        expected_version: entry.remote.version,
        client_operation_id: this.options.operationId?.() ?? crypto.randomUUID(),
        draft: structuredClone(entry.local),
        edit: entry.edit,
      };
    const pending = entry.pending;
    const abort = new AbortController();
    this.aborts.add(abort);
    entry.status = "saving";
    entry.error = "";
    this.emit();
    const work = async () => {
      try {
        const remote =
          pending.draft === null
            ? await this.options.client.remove(entry.scope, pending, abort.signal)
            : await this.options.client.put(entry.scope, pending.draft, pending, abort.signal);
        if (!this.valid(entry)) return false;
        if (
          !remote.applied_version ||
          BigInt(remote.applied_version) <= BigInt(pending.expected_version) ||
          BigInt(remote.version) < BigInt(remote.applied_version)
        )
          throw new CloudSavedDraftUnconfirmedError();
        if (
          remote.version !== remote.applied_version ||
          remote.last_operation_id !== pending.client_operation_id
        ) {
          // A replay receipt proves the old write applied, but never authorizes overwriting a newer draft.
          entry.pending = undefined;
          entry.remote = remote;
          entry.conflict = { server: remote };
          entry.status = "conflict";
          entry.dirty = true;
          return false;
        }
        if (!cloudSavedDraftEqual(remote.draft, pending.draft))
          throw new CloudSavedDraftUnconfirmedError();
        entry.remote = remote;
        entry.pending = undefined;
        entry.dirty = entry.edit !== pending.edit;
        entry.status = entry.dirty ? "dirty" : "ready";
        if (entry.dirty) this.schedule(entry);
        return true;
      } catch (cause) {
        if (!this.valid(entry)) return false;
        if (cause instanceof CloudSavedDraftError) {
          entry.pending = undefined;
          if (cause.status === 409) {
            entry.conflict = { server: null };
            entry.status = "conflict";
            await this.refreshConflict(entry);
          } else {
            entry.status = "error";
            entry.error = cause.message;
          }
        } else {
          // Preserve the exact operation/body across transport failures and additional local typing.
          entry.status = "unknown";
          entry.error = "草稿保存结果尚未确认，重试将核对同一次保存。";
        }
        return false;
      } finally {
        this.aborts.delete(abort);
        if (this.valid(entry)) {
          entry.saving = undefined;
          this.emit();
        }
      }
    };
    entry.saving = work();
    return entry.saving;
  }

  private async refreshConflict(entry: Entry) {
    const abort = new AbortController();
    this.aborts.add(abort);
    const read = (entry.conflictRead ?? 0) + 1;
    entry.conflictRead = read;
    try {
      const server = await this.options.client.get(entry.scope, abort.signal);
      if (!this.valid(entry) || !entry.conflict || entry.conflictRead !== read) return false;
      if (entry.remote && BigInt(server.version) < BigInt(entry.remote.version)) return false;
      entry.remote = server;
      entry.conflict = { server };
      entry.error = "";
      return true;
    } catch {
      if (this.valid(entry) && entry.conflictRead === read)
        entry.error = "暂时无法读取另一处的草稿，请重试，当前输入已保留。";
      return false;
    } finally {
      this.aborts.delete(abort);
      this.emit();
    }
  }
  retry(): Promise<boolean> {
    const entry = this.entries.get(this.current);
    if (!entry || !this.valid(entry)) return Promise.resolve(false);
    if (entry.conflict) return this.refreshConflict(entry);
    if (entry.pending) return this.flush(entry.scope, true);
    if (!entry.remote)
      return this.load(entry).then((ok) => (ok && entry.dirty ? this.flush(entry.scope) : ok));
    return this.flush(entry.scope);
  }
  async resolveConflict(choice: "keep-local" | "use-server"): Promise<boolean> {
    const entry = this.entries.get(this.current);
    if (!entry || !this.valid(entry) || !entry.conflict) return false;
    if (!entry.conflict.server && !(await this.refreshConflict(entry))) return false;
    if (!this.valid(entry) || !entry.conflict?.server) return false;
    entry.remote = entry.conflict.server;
    entry.conflict = undefined;
    entry.pending = undefined;
    entry.error = "";
    if (choice === "use-server") {
      entry.invalidCapture = false;
      entry.local = entry.remote.draft;
      entry.edit++;
      entry.dirty = false;
      entry.status = "ready";
      this.apply(entry);
      this.emit();
      return true;
    }
    entry.dirty = true;
    entry.status = "dirty";
    return this.flush(entry.scope);
  }

  /** Called only after an accepted send, with the editor snapshot that was actually sent. */
  clearIfUnchanged(sent: CloudChatSavedDraft, scope = this.current): Promise<boolean> {
    const entry = this.entries.get(cloudSavedDraftScope(scope));
    if (
      !entry ||
      !this.valid(entry) ||
      entry.invalidCapture ||
      !cloudSavedDraftEqual(entry.local, parseCloudChatSavedDraft(sent))
    )
      return Promise.resolve(false);
    entry.local = null;
    entry.edit++;
    entry.dirty = true;
    if (!entry.conflict && entry.status !== "unknown") entry.status = "dirty";
    this.emit();
    return this.flush(entry.scope);
  }
  /** Explicit New conversation: clear only the blank editor, independent of the current route. */
  resetBlank(seed: CloudChatSavedDraft | null = null): Promise<boolean> {
    if (!this.alive()) return Promise.resolve(false);
    let entry = this.entries.get("blank");
    if (!entry) {
      entry = { scope: "blank", local: null, status: "dirty", error: "", dirty: true, edit: 0 };
      this.entries.set("blank", entry);
    }
    this.stopTimer(entry);
    entry.local = seed ? parseCloudChatSavedDraft(seed) : null;
    entry.edit++;
    entry.dirty = true;
    entry.invalidCapture = false;
    entry.resetIntent = !entry.remote;
    if (!entry.conflict && entry.status !== "unknown") entry.status = "dirty";
    this.apply(entry);
    this.emit();
    return this.flush("blank");
  }
  dispose() {
    this.disposed = true;
    for (const entry of this.entries.values()) this.stopTimer(entry);
    for (const abort of this.aborts) abort.abort();
    this.aborts.clear();
    this.entries.clear();
  }
}
