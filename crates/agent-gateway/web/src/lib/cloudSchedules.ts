import type { TranscriptMessageJump } from "@liveagent/ui/lib/transcript-virtual/useTranscriptMessageJump";
import { accountFetch, captureAccountRequestGuard } from "./accountRequest";

export type ScheduleRule = {
  frequency: "once" | "daily" | "weekly" | "monthly" | "interval";
  start: string;
  time_zone: string;
  interval_minutes?: number;
  weekdays?: number[];
  count?: number;
  end_date?: string;
};

export const SCHEDULE_CONTENT_PART_LIMIT = 32;

export type ScheduleContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | { type: "file_reference"; file_id: string }
      | { type: "artifact_reference"; version_id: string }
      | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
    >;

export type ScheduleInput = {
  name: string;
  rule: ScheduleRule;
  new_conversation: boolean;
  project_id?: string;
  archive_successful_runs?: boolean;
  notification?: "attention" | "all" | "none";
  require_approval?: boolean;
  run: {
    model: string;
    provider_key_id?: number;
    reasoning_effort?: string;
    model_parameters?: Record<string, unknown>;
    public_research?: { topic: string };
    content: ScheduleContent;
  };
};

export type Schedule = ScheduleInput & {
  id: string;
  revision: number;
  enabled: boolean;
  next_at: string | null;
  admitted: number;
  blocked?: string;
  latest_state?: string;
};

export type ScheduleRun = {
  id: string;
  trigger_at: string;
  state: string;
  manual: boolean;
  conversation_id?: string;
  run_id?: string;
  output?: string;
  error_code?: string;
  archived?: boolean;
  approval?: ScheduleInput;
};

export type ScheduleApprovalDecision = "approve" | "reject";
export type ScheduleApprovalReceipt = ScheduleApprovalDecision | "pending" | "unavailable";

export type CloudTaskConversationSelection = {
  id: string;
  runId?: string;
  occurrenceId?: string;
  followLatest?: boolean;
  jump?: TranscriptMessageJump;
};

export class ScheduleRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

export class ScheduleEndpointUnavailableError extends ScheduleRequestError {}

export function createCloudSchedulesClient(
  transport = accountFetch,
  captureGuard = captureAccountRequestGuard,
) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const guard = captureGuard();
    const headers = new Headers(init?.headers);
    headers.set("Accept", "application/json");
    const response = await transport(path, { ...init, headers });
    const payload = response.headers.get("Content-Type")?.includes("application/json")
      ? await response.json()
      : undefined;
    guard();
    if (response.status !== 204 && payload === undefined)
      throw new ScheduleEndpointUnavailableError(
        "Cloud schedules endpoint is unavailable",
        response.ok ? 502 : response.status,
      );
    if (!response.ok)
      throw new ScheduleRequestError(
        payload?.message || payload?.error || `HTTP ${response.status}`,
        response.status,
        typeof payload?.reason === "string" ? payload.reason : undefined,
      );
    return payload as T;
  }

  const base = "/api/web-chat/schedules";
  const body = (method: string, payload: unknown) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  return {
    deviceSummary: (device: string, signal?: AbortSignal) =>
      request<{
        tasks: {
          id: string;
          name: string;
          status: "enabled" | "paused" | "completed";
          next_at?: number;
        }[];
      }>(`/api/web-chat/device-schedules/${encodeURIComponent(device)}`, { signal }),
    list: (signal?: AbortSignal) =>
      request<{ tasks: Schedule[]; enabled: boolean }>(base, { signal }),
    runs: (id: string, signal?: AbortSignal) =>
      request<{ runs: ScheduleRun[] }>(`${base}/${encodeURIComponent(id)}/runs`, { signal }),
    readRun: (task: string, run: string, signal?: AbortSignal) =>
      request<{ run: ScheduleRun }>(
        `${base}/${encodeURIComponent(task)}/runs/${encodeURIComponent(run)}`,
        { signal },
      ),
    remove: (id: string) =>
      request<void>(`${base}/${encodeURIComponent(id)}`, { method: "DELETE" }),
    preview: (rule: ScheduleRule, admitted: number, signal: AbortSignal) =>
      request<{ next_at: string | null }>(`${base}/preview`, {
        ...body("POST", { rule, admitted }),
        signal,
      }),
    save: (task: ScheduleInput, enabled: boolean, requestId: string, existing?: Schedule) =>
      request<Schedule>(
        existing ? `${base}/${encodeURIComponent(existing.id)}` : base,
        body(existing ? "PUT" : "POST", {
          task,
          enabled,
          request_id: requestId,
          revision: existing?.revision,
        }),
      ),
    run: (id: string, requestId: string) =>
      request<{ id: string }>(
        `${base}/${encodeURIComponent(id)}/run-now`,
        body("POST", { request_id: requestId }),
      ),
    readRunReceipt: (id: string, requestId: string) =>
      request<{ status: "admitted"; id: string } | { status: "missing" }>(
        `${base}/${encodeURIComponent(id)}/run-now?request_id=${encodeURIComponent(requestId)}`,
      ),
    cancel: (id: string) =>
      request(`/api/web-chat/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
    cancelPending: (task: string, run: string) =>
      request<void>(`${base}/${encodeURIComponent(task)}/runs/${encodeURIComponent(run)}/cancel`, {
        method: "POST",
      }),
    readApprovalDecision: (task: string, run: string) =>
      request<{ decision: ScheduleApprovalReceipt }>(
        `${base}/${encodeURIComponent(task)}/runs/${encodeURIComponent(run)}/approval`,
      ),
    decide: (task: string, run: string, decision: ScheduleApprovalDecision) =>
      request<void>(
        `${base}/${encodeURIComponent(task)}/runs/${encodeURIComponent(run)}/approval`,
        body("POST", { decision }),
      ),
  };
}

export const cloudSchedules = createCloudSchedulesClient();
