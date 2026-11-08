import type {
  AutomationApplyInput,
  AutomationOp,
  AutomationSnapshot,
  CronApplyResponse,
  CronDraftPreview,
  CronDraftPreviewInput,
  CronManualRunReceipt,
  CronOccurrencesResponse,
  CronRunAnchor,
  CronRunProgress,
  CronRunRecord,
  CronTask,
} from "@liveagent/ui/lib/automation/types";
import type { CronTaskFormData } from "@liveagent/ui/pages/settings/CronTaskModal";

export type DeviceScheduleEditorProps = {
  target: string;
  timeZone?: string;
  task?: CronTask;
  name?: string;
  prompt?: string;
  onUseCloud?: (name: string, prompt: string) => void;
  preview: (input: CronDraftPreviewInput, signal?: AbortSignal) => Promise<CronDraftPreview>;
  onSave: (data: CronTaskFormData) => Promise<void>;
  onClose: () => void;
};

export type DeviceScheduleHost = {
  targetId: string;
  label: string;
  list: () => Promise<{ tasks: CronTask[]; next: Record<string, number>; timeZone?: string }>;
  preview: DeviceScheduleEditorProps["preview"];
  runs: (id: string) => Promise<CronRunRecord[]>;
  runAnchor?: (id: string, executionId: string) => Promise<Partial<CronRunAnchor>>;
  runProgress?: (id: string, executionId: string, cursor: number) => Promise<CronRunProgress>;
  toggle: (task: CronTask) => Promise<unknown>;
  remove: (task: CronTask) => Promise<void>;
  runNowOnce: (id: string, executionId: string) => Promise<CronManualRunReceipt>;
  readRunReceipt: (id: string, executionId: string) => Promise<CronManualRunReceipt>;
  cancel?: (task: string, run: string) => Promise<void>;
  save: (data: CronTaskFormData, id: string, existing?: CronTask) => Promise<CronTask>;
};

type CronTransport = {
  fetchSnapshot(): Promise<AutomationSnapshot>;
  cronApply(input: AutomationApplyInput): Promise<CronApplyResponse>;
  cronOccurrences(from: number, to: number): Promise<CronOccurrencesResponse>;
  previewCronDraft?: DeviceScheduleEditorProps["preview"];
  listRuns(id: string, limit: number): Promise<CronRunRecord[]>;
  runAnchor?(id: string, executionId: string): Promise<Partial<CronRunAnchor>>;
  runProgress?(id: string, executionId: string, cursor: number): Promise<CronRunProgress>;
  runNowOnce(id: string, executionId: string): Promise<CronManualRunReceipt>;
  readRunReceipt(id: string, executionId: string): Promise<CronManualRunReceipt>;
  cancelRun(id: string, run: string): Promise<void>;
  canCancelRun(): boolean;
};

export function createDeviceScheduleHost({
  backend,
  targetId,
  label,
  locale,
  requireCurrent,
  fallbackTimeZone = "UTC",
}: {
  backend: CronTransport;
  targetId: string;
  label: string;
  locale: string;
  requireCurrent: () => void;
  fallbackTimeZone?: string;
}): DeviceScheduleHost {
  const text = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);
  const conflict = () =>
    new Error(
      text("任务已更新，请重新打开后再保存。", "The task changed. Reopen it before saving."),
    );
  const unknown = () =>
    new Error(
      text(
        "尚未确认保存结果，请核对任务列表后重试。",
        "The save was not confirmed. Check the task list before trying again.",
      ),
    );
  const comparable = (value: unknown) => JSON.stringify(value === "" ? null : (value ?? null));
  const same = (left: unknown, right: unknown) => comparable(left) === comparable(right);
  const readRunAnchor = backend.runAnchor;
  const readRunProgress = backend.runProgress;
  async function request<T>(operation: () => Promise<T>) {
    requireCurrent();
    const value = await operation();
    requireCurrent();
    return value;
  }
  async function apply(revision: number, op: AutomationOp) {
    const result = await request(() => backend.cronApply({ baseRevision: revision, ops: [op] }));
    if (result.status !== "ok") throw conflict();
    return result.cron;
  }
  async function manualReceipt(
    action: "runNowOnce" | "readRunReceipt",
    taskId: string,
    executionId: string,
  ): Promise<CronManualRunReceipt> {
    return request(async () => {
      try {
        const receipt = await backend[action](taskId, executionId);
        if (receipt?.status === "admitted") {
          if (
            receipt.executionId === executionId &&
            Number.isSafeInteger(receipt.startedAt) &&
            receipt.startedAt > 0
          )
            return receipt;
        } else if (
          receipt?.status === "unsupported" ||
          (action === "readRunReceipt"
            ? receipt?.status === "missing"
            : receipt?.status === "rejected")
        ) {
          return receipt;
        }
        throw new Error("Invalid device run receipt");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (
          /\bE:unknown_request\b|\bunsupported cron action:? ["']?(?:run_now_once|run_receipt)\b|\bcron route not found\b/.test(
            message,
          )
        )
          return { status: "unsupported" };
        throw cause;
      }
    });
  }
  return {
    targetId,
    label,
    preview: (input, signal) =>
      request(async () => {
        if (!backend.previewCronDraft) return { status: "unsupported" };
        try {
          const result = await backend.previewCronDraft(input, signal);
          if (result?.status === "invalid" || result?.status === "unsupported") return result;
          if (
            result?.status === "valid" &&
            typeof result.timeZone === "string" &&
            Number.isInteger(result.utcOffsetSeconds) &&
            Math.abs(result.utcOffsetSeconds) < 86_400 &&
            (result.nextAt === undefined ||
              (Number.isSafeInteger(result.nextAt) &&
                Math.abs(result.nextAt + result.utcOffsetSeconds * 1_000) <= 8.64e15))
          )
            return result;
          throw new Error("Invalid device schedule preview response");
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause);
          if (/\bE:unknown_request\b|\bunsupported cron action:? ["']?preview\b/.test(error))
            return { status: "unsupported" };
          throw cause;
        }
      }),
    async list() {
      const from = Date.now();
      const [{ cron }, planning] = await Promise.all([
        request(() => backend.fetchSnapshot()),
        request(() => backend.cronOccurrences(from, from + 35 * 86_400_000)).catch(() => undefined),
      ]);
      requireCurrent();
      const next: Record<string, number> = {};
      const cutoff = Math.max(from, planning?.now ?? from);
      function rememberNext(id: string, at: number) {
        if (at >= cutoff && (next[id] === undefined || at < next[id])) next[id] = at;
      }
      for (const { taskId, at } of planning?.occurrences ?? []) rememberNext(taskId, at);
      for (const { taskId, firstAt, planned, ran } of planning?.summaries ?? []) {
        // A mixed bucket's first event may be an already-started run.
        if (planned > 0 && ran === 0) rememberNext(taskId, firstAt);
      }
      let timeZone = planning?.timeZone || fallbackTimeZone;
      try {
        new Intl.DateTimeFormat(locale, { timeZone });
      } catch {
        timeZone = fallbackTimeZone;
      }
      return { tasks: cron.tasks, next, timeZone };
    },
    runs: (id) => request(() => backend.listRuns(id, 100)),
    runAnchor: readRunAnchor
      ? (id, executionId) => request(() => readRunAnchor(id, executionId))
      : undefined,
    runProgress: readRunProgress
      ? (id, executionId, cursor) => request(() => readRunProgress(id, executionId, cursor))
      : undefined,
    async toggle(task) {
      const { cron } = await request(() => backend.fetchSnapshot());
      const current = cron.tasks.find((item) => item.id === task.id);
      if (!current || current.enabled !== task.enabled || current.remainingExecutions === 0)
        throw conflict();
      await apply(cron.revision, { op: "update", id: task.id, patch: { enabled: !task.enabled } });
    },
    async remove(task) {
      const { cron } = await request(() => backend.fetchSnapshot());
      const current = cron.tasks.find((item) => item.id === task.id);
      if (!current) return;
      if (current.name !== task.name) throw conflict();
      const runs = await request(() => backend.listRuns(task.id, 100));
      if (runs.some((run) => run.state === "pending" || run.state === "leased")) {
        throw new Error(
          text(
            "请等待本次运行结束，或先取消运行。",
            "Wait for the active run to finish or cancel it first.",
          ),
        );
      }
      await apply(cron.revision, { op: "delete", id: task.id });
    },
    runNowOnce: (id, executionId) => manualReceipt("runNowOnce", id, executionId),
    readRunReceipt: (id, executionId) => manualReceipt("readRunReceipt", id, executionId),
    cancel: backend.canCancelRun()
      ? (id, run) => request(() => backend.cancelRun(id, run))
      : undefined,
    async save(data, id, existing) {
      const { cron } = await request(() => backend.fetchSnapshot());
      const current = cron.tasks.find((item) => item.id === id);
      const entries = Object.entries(data) as [keyof CronTaskFormData, unknown][];
      if (!existing && current) {
        // A lost reply can be retried with the same client-generated ID.
        if (entries.every(([key, value]) => same(current[key], value))) return current;
        throw conflict();
      }
      let result: Awaited<ReturnType<typeof apply>>;
      if (existing) {
        if (!current || existing.id !== id) throw conflict();
        const patch: Record<string, unknown> = {};
        for (const [key, value] of entries) {
          if (same(existing[key], value) || same(current[key], value)) continue;
          if (!same(existing[key], current[key])) throw conflict();
          patch[key] = value ?? null;
        }
        if (!Object.keys(patch).length) return current;
        result = await apply(cron.revision, { op: "update", id, patch });
      } else {
        result = await apply(cron.revision, { op: "create", item: { ...data, id, enabled: true } });
      }
      const saved = result.tasks.find((item) => item.id === id);
      if (!saved) throw unknown();
      return saved;
    },
  };
}
