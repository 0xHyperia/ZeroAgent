import "@liveagent/ui/i18n/namespaces/scheduledTasks";
import { useEffect, useMemo, useState } from "react";
import { Button } from "../../components/ui/button";
import { StatusNotice } from "../../components/ui/status-notice";
import { useLocale } from "../../i18n";
import type { CronDraftPreview, CronDraftPreviewInput } from "../../lib/automation/types";

export type PreviewDeviceCron = (
  input: CronDraftPreviewInput,
  signal?: AbortSignal,
) => Promise<CronDraftPreview>;

type Preview = CronDraftPreview | { status: "unavailable" | "loading" | "empty" | "invalid_count" };

export function useWorkbenchCronPreview(
  preview: PreviewDeviceCron | undefined,
  expression: string,
  remaining: string,
) {
  const [attempt, setAttempt] = useState(0);
  const count = remaining ? Number(remaining) : undefined;
  const validCount = count === undefined || (Number.isSafeInteger(count) && count >= 0);
  const request = useMemo(
    () =>
      preview && expression && validCount
        ? { preview, input: { expression, remainingExecutions: count }, attempt }
        : undefined,
    [attempt, count, expression, preview, validCount],
  );
  const [response, setResponse] = useState<{
    request: NonNullable<typeof request>;
    result: Preview;
  }>();
  useEffect(() => {
    if (!request) return;
    const controller = new AbortController();
    const unavailable = { status: "unavailable" } as const;
    let deadline: number;
    const finish = (result: Preview) => {
      window.clearTimeout(deadline);
      if (!controller.signal.aborted) setResponse({ request, result });
    };
    const timer = window.setTimeout(() => {
      deadline = window.setTimeout(() => {
        finish(unavailable);
        controller.abort();
      }, 8_000);
      void request
        .preview(request.input, controller.signal)
        .then(finish, () => finish(unavailable));
    }, 200);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(deadline);
      controller.abort();
    };
  }, [request]);

  const result: Preview =
    request && response?.request === request
      ? response.result
      : {
          status: !preview
            ? "unsupported"
            : request
              ? "loading"
              : !validCount
                ? "invalid_count"
                : "empty",
        };
  return { result, retry: () => setAttempt((value) => value + 1) };
}

function formatOffset(seconds: number) {
  const hours = Math.floor(Math.abs(seconds) / 3600);
  const minutes = Math.floor((Math.abs(seconds) % 3600) / 60);
  return `UTC${seconds >= 0 ? "+" : "−"}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function WorkbenchCronPreview({
  result,
  retry,
  paused,
}: {
  result: Preview;
  retry: () => void;
  paused?: boolean;
}) {
  const { locale, t } = useLocale();
  const text = (zh: string, en: string) => (locale === "zh-CN" ? zh : en);

  if (result.status === "unsupported") {
    return (
      <StatusNotice
        compact
        tone="warning"
        message={text("此设备暂不支持预览下次运行", "This device cannot preview the next run")}
        description={text("请更新设备上的 ZeroAgent。", "Update ZeroAgent on this device.")}
      />
    );
  }
  if (
    result.status === "invalid" ||
    result.status === "invalid_count" ||
    result.status === "unavailable"
  ) {
    const unavailable = result.status === "unavailable";
    return (
      <StatusNotice
        compact
        tone="error"
        message={text("无法预览下次运行", "Unable to preview the next run")}
        description={
          unavailable
            ? text("草稿已保留。", "Your draft is still here.")
            : result.status === "invalid_count"
              ? t("settings.cronRemainingExecutionsInvalid")
              : text("请检查时间和重复规则。", "Check the time and repeat rule.")
        }
        actions={
          unavailable && (
            <Button type="button" variant="ghost" className="min-h-11 md:min-h-9" onClick={retry}>
              {text("重试预览", "Retry preview")}
            </Button>
          )
        }
      />
    );
  }
  let detail = text("请填写运行规则", "Enter a schedule");
  if (result.status === "loading") detail = text("正在计算", "Calculating");
  if (result.status === "valid") {
    if (result.nextAt === undefined) {
      detail = text("没有后续运行", "No future run");
    } else {
      // The response already has the device's offset at that instant. The
      // browsing device's current zone (and the future DST offset) may differ.
      const localClock = result.nextAt + result.utcOffsetSeconds * 1_000;
      const date = new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }).format(localClock);
      const zone =
        result.timeZone !== "Local" ? result.timeZone : formatOffset(result.utcOffsetSeconds);
      detail = `${date} · ${zone}`;
    }
  }
  return (
    <p role="status" className="px-2 text-xs text-muted-foreground">
      {paused ? text("恢复后下次运行", "Next run after resuming") : text("下次运行", "Next run")} ·{" "}
      {detail}
    </p>
  );
}
