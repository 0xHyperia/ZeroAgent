import { ShieldCheck } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { StatusNotice } from "@liveagent/ui/components/ui/status-notice";
import { createUuid } from "@liveagent/ui/lib/shared/id";
import { type RefObject, useEffect, useId, useRef, useState } from "react";
import {
  type cloudSchedules,
  type ScheduleApprovalDecision,
  type ScheduleApprovalReceipt,
  ScheduleEndpointUnavailableError,
  type ScheduleInput,
  ScheduleRequestError,
} from "../../lib/cloudSchedules";

type Phase =
  | "idle"
  | "submitting"
  | "checking"
  | "unconfirmed"
  | "sign-in"
  | "check-unavailable"
  | "pending"
  | "approve"
  | "reject"
  | "unavailable";

export function ScheduleRunApprovalCard({
  client,
  storageKey,
  taskId,
  runId,
  input,
  prompt,
  triggerLabel,
  disabledReason,
  recorded,
  titleRef,
  text,
  onSubmitting,
  onResolved,
}: {
  client: Pick<typeof cloudSchedules, "decide" | "readApprovalDecision">;
  storageKey: string;
  taskId: string;
  runId: string;
  input?: ScheduleInput;
  prompt?: string;
  triggerLabel?: string;
  disabledReason?: string;
  recorded?: Exclude<ScheduleApprovalReceipt, "pending">;
  titleRef: RefObject<HTMLHeadingElement | null>;
  text: (zh: string, en: string) => string;
  onSubmitting: () => void;
  onResolved: (outcome: Exclude<ScheduleApprovalReceipt, "pending">, restoreFocus: boolean) => void;
}) {
  const titleId = useId();
  const contentId = useId();
  const [phase, setPhase] = useState<Phase>(
    () => recorded ?? (sessionStorage.getItem(storageKey) ? "unconfirmed" : "idle"),
  );
  const active = useRef(true);
  const inFlight = useRef(false);
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const busy = phase === "submitting" || phase === "checking";
  const decisionVisible =
    !!input && (phase === "idle" || phase === "pending" || phase === "submitting");
  const checkVisible = ["unconfirmed", "checking", "check-unavailable", "sign-in"].includes(phase);
  const descriptions: Partial<Record<Phase, string>> = {
    submitting: text("正在提交决定…", "Submitting decision…"),
    checking: text("正在核对原决定…", "Checking the original decision…"),
    unconfirmed: text(
      "决定尚未确认。请先核对本次运行。",
      "The decision is unconfirmed. Check this run before deciding again.",
    ),
    "check-unavailable": text(
      "暂时读不到审批回执。请稍后再核对。",
      "The approval receipt is unavailable. Try checking again later.",
    ),
    "sign-in": text(
      "请重新登录后核对，原决定仍可查找。",
      "Sign in again to check the original decision.",
    ),
    pending: text("已核对，本次运行仍待审批。", "Checked. This run still awaits approval."),
    approve: text(
      "已记录批准。执行状态将单独更新。",
      "Approval recorded. Execution status updates separately.",
    ),
    reject: text(
      "已记录拒绝，本次运行不会执行。",
      "Rejection recorded. This run will not execute.",
    ),
    unavailable: text("本次运行已无法审批。", "This run is no longer available for approval."),
  };
  const description = descriptions[phase] ?? (decisionVisible ? disabledReason : undefined);

  async function resolve(decision?: ScheduleApprovalDecision) {
    if (inFlight.current || (decision ? disabledReason || !decisionVisible : !checkVisible)) return;
    const stored = sessionStorage.getItem(storageKey);
    const marker = decision ? createUuid() : stored;
    if (decision && stored) {
      setPhase("unconfirmed");
      return;
    }
    if (decision && marker) sessionStorage.setItem(storageKey, marker);
    inFlight.current = true;
    setPhase(decision ? "submitting" : "checking");
    const settled = () => marker !== null && sessionStorage.getItem(storageKey) === marker;
    const focusInCard = () => Boolean(card.current?.contains(document.activeElement));
    try {
      let outcome: ScheduleApprovalReceipt;
      if (decision) {
        onSubmitting();
        await client.decide(taskId, runId, decision);
        outcome = decision;
      } else {
        outcome = (await client.readApprovalDecision(taskId, runId)).decision;
        if (!["approve", "reject", "pending", "unavailable"].includes(outcome))
          throw new Error("Invalid approval receipt");
      }
      if (outcome === "pending" && !input) {
        if (active.current) setPhase("check-unavailable");
        return;
      }
      if (settled()) sessionStorage.removeItem(storageKey);
      if (!active.current) return;
      setPhase(outcome);
      if (outcome === "pending") {
        if (focusInCard()) titleRef.current?.focus({ preventScroll: true });
      } else {
        onResolved(outcome, focusInCard());
      }
    } catch (cause) {
      if (!active.current) return;
      if (
        !decision &&
        cause instanceof ScheduleRequestError &&
        !(cause instanceof ScheduleEndpointUnavailableError) &&
        cause.status === 404
      ) {
        if (settled()) sessionStorage.removeItem(storageKey);
        setPhase("unavailable");
        onResolved("unavailable", focusInCard());
        return;
      }
      if (focusInCard() && decision) titleRef.current?.focus({ preventScroll: true });
      const signIn =
        cause instanceof ScheduleRequestError &&
        (cause.status === 401 || cause.reason === "authorization_required");
      setPhase(signIn ? "sign-in" : decision ? "unconfirmed" : "check-unavailable");
    } finally {
      inFlight.current = false;
    }
  }

  const resourceCount = Array.isArray(input?.run.content)
    ? input.run.content.filter((part) => part.type !== "text").length
    : 0;
  return (
    <section
      ref={card}
      aria-labelledby={titleId}
      className="min-w-0 space-y-4 rounded-2xl border border-border bg-background p-4 sm:p-5"
    >
      <header className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <ShieldCheck className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 space-y-0.5">
          <h3 ref={titleRef} id={titleId} tabIndex={-1} className="font-medium outline-none">
            {input
              ? text("审阅本次运行", "Review this run")
              : text("本次审批回执", "Approval receipt")}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {triggerLabel ? `${triggerLabel} · ` : ""}
            {text("决定只适用于本次运行", "Your decision applies only to this run")}
          </p>
        </div>
      </header>
      {prompt && (
        <div className="space-y-1.5">
          <p id={contentId} className="text-xs font-medium text-muted-foreground">
            {text("本次任务说明", "Instructions for this run")}
          </p>
          <div
            role="region"
            aria-labelledby={contentId}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Long instructions must be keyboard-scrollable.
            tabIndex={0}
            className="max-h-52 overflow-y-auto overscroll-contain whitespace-pre-wrap rounded-xl bg-muted/60 px-3 py-2.5 text-sm leading-relaxed focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset [overflow-wrap:anywhere]"
          >
            {prompt}
          </div>
        </div>
      )}
      {input && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <div className="min-w-0">
            <dt className="text-xs text-muted-foreground">{text("模型", "Model")}</dt>
            <dd className="[overflow-wrap:anywhere]">{input.run.model}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">
              {text("关联资料", "Attached resources")}
            </dt>
            <dd>{resourceCount}</dd>
          </div>
          {input.run.public_research && (
            <div className="col-span-2 min-w-0">
              <dt className="text-xs text-muted-foreground">
                {text("公开检索主题", "Public search topic")}
              </dt>
              <dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">
                {input.run.public_research.topic}
              </dd>
            </div>
          )}
        </dl>
      )}
      {description && (
        <StatusNotice
          compact
          busy={busy}
          tone={checkVisible && !busy ? "warning" : "info"}
          message={description}
        />
      )}
      {(decisionVisible || checkVisible) && (
        <footer className="flex flex-wrap justify-end gap-2 border-t border-border/60 pt-3">
          {decisionVisible ? (
            <>
              <Button
                variant="outline"
                className="min-h-11 aria-disabled:opacity-50 md:min-h-9"
                aria-disabled={busy || !!disabledReason}
                onClick={() => void resolve("reject")}
              >
                {text("拒绝本次", "Reject this run")}
              </Button>
              <Button
                className="min-h-11 aria-disabled:opacity-50 md:min-h-9"
                aria-disabled={busy || !!disabledReason}
                onClick={() => void resolve("approve")}
              >
                {text("批准本次运行", "Approve this run")}
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              className="min-h-11 aria-disabled:opacity-50 md:min-h-9"
              aria-disabled={busy}
              onClick={() => void resolve()}
            >
              {text("核对决定", "Check decision")}
            </Button>
          )}
        </footer>
      )}
    </section>
  );
}
