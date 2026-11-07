import {
  type CronRunRecord,
  isCronRunActive,
  type ScheduledRunPreview,
} from "@liveagent/ui/lib/automation/types";
import { useEffect, useEffectEvent, useState } from "react";
import type { DeviceScheduleHost } from "../../lib/deviceScheduleHost";

const MAX_PREVIEW_LENGTH = 256 * 1024;

export function useScheduledRunPreview(
  owner: number,
  device: DeviceScheduleHost | undefined,
  run: CronRunRecord | undefined,
): ScheduledRunPreview | undefined {
  const [preview, setPreview] = useState<{ key: string; value: ScheduledRunPreview }>();
  const { id, taskId, runId, sessionId } = run ?? {};
  const key =
    device?.runProgress && id && taskId && runId && sessionId
      ? JSON.stringify([owner, device.targetId, taskId, id, sessionId, runId])
      : undefined;
  const active = !!run && isCronRunActive(run);
  const readProgress = useEffectEvent((task: string, execution: string, cursor: number) =>
    device?.runProgress?.(task, execution, cursor),
  );

  useEffect(() => {
    if (!active || !key || !taskId || !id) return;
    let retired = false;
    let timer: number;
    let cursor = 0;
    let text = "";
    let truncated = false;
    let prompt: ScheduledRunPreview["prompt"];
    async function poll(task: string, execution: string, scope: string) {
      let delay = 650;
      try {
        const chunk = await readProgress(task, execution, cursor);
        if (retired || !chunk) return;
        if (
          chunk.sessionId !== sessionId ||
          chunk.runId !== runId ||
          !Number.isSafeInteger(chunk.cursor) ||
          chunk.cursor < cursor
        ) {
          throw new Error("The scheduled reply cursor does not match the selected run");
        }
        const advanced = chunk.cursor > cursor;
        if (advanced) {
          const remaining = MAX_PREVIEW_LENGTH - text.length;
          let delta = chunk.text.slice(0, remaining);
          // A bounded preview must not leave half of a Unicode character.
          if (delta.length < chunk.text.length) delta = delta.replace(/[\uD800-\uDBFF]$/, "");
          text += delta;
          truncated ||= Boolean(chunk.truncated || delta.length < chunk.text.length);
          prompt ??= chunk.prompt;
          cursor = chunk.cursor;
        }
        const value = { text, done: chunk.done, truncated, prompt };
        setPreview((prior) =>
          prior?.key === scope &&
          prior.value.text === value.text &&
          prior.value.done === value.done &&
          prior.value.truncated === value.truncated &&
          prior.value.prompt === value.prompt
            ? prior
            : { key: scope, value },
        );
        if (chunk.done) return;
        if (chunk.more && advanced) delay = 50;
      } catch {
        // Keep the last visible text on disconnect. The next read uses the same cursor.
        delay = 4000;
      }
      if (!retired) timer = window.setTimeout(() => void poll(task, execution, scope), delay);
    }
    void poll(taskId, id, key);
    return () => {
      retired = true;
      window.clearTimeout(timer);
    };
  }, [active, id, key, runId, sessionId, taskId]);

  return key && preview?.key === key ? preview.value : undefined;
}
