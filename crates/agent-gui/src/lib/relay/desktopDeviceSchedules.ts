import { createDeviceScheduleHost } from "@/lib/deviceScheduleHost";
import { backend } from "../automation/backend";
import { readKBrainCronRunProgress } from "../automation/kbrainCron";
import { isKBrainBackendEnabled } from "../host";
import { nativeSessionHandle, nativeSessionSummary } from "./nativeSession";

export function desktopDeviceSchedules(owner: number, locale = "zh-CN") {
  const handle = nativeSessionHandle();
  return createDeviceScheduleHost({
    backend: {
      ...backend,
      runProgress: isKBrainBackendEnabled() ? readKBrainCronRunProgress : undefined,
    },
    targetId: "local",
    label: locale === "zh-CN" ? "此电脑" : "This computer",
    locale,
    fallbackTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    requireCurrent: () => {
      if (!handle || nativeSessionHandle() !== handle || nativeSessionSummary()?.user.id !== owner)
        throw new Error(locale === "zh-CN" ? "账户已变更。" : "The account changed.");
    },
  });
}
