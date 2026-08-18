import { useCallback, useEffect, useRef, useState } from "react";
import { Download, Loader2, RefreshCw } from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@liveagent/ui/components/ui/dialog";
import {
  checkMobileAppUpdate,
  downloadMobileAppUpdate,
  MOBILE_APP_VERSION,
  MOBILE_UPDATE_CHECK_EVENT,
  type MobileAppUpdate,
} from "../../lib/mobileAppUpdate";
import { isEmbeddedMobileRuntime, MOBILE_BACK_EVENT, mobileHaptic } from "../../lib/mobileRuntime";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const SNOOZE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const LAST_CHECK_KEY = "zeroagent.mobile-update.last-check";
const SNOOZE_KEY = "zeroagent.mobile-update.snooze";

type CheckFeedback = "latest" | "error" | null;

function readSnooze() {
  try {
    return JSON.parse(localStorage.getItem(SNOOZE_KEY) || "null") as {
      version?: string;
      until?: number;
    } | null;
  } catch {
    localStorage.removeItem(SNOOZE_KEY);
    return null;
  }
}

export function MobileAppExperience() {
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [update, setUpdate] = useState<MobileAppUpdate | null>(null);
  const [feedback, setFeedback] = useState<CheckFeedback>(null);
  const [feedbackMessage, setFeedbackMessage] = useState("");
  const checkInFlight = useRef(false);

  const runCheck = useCallback(async (manual: boolean) => {
    if (!isEmbeddedMobileRuntime() || checkInFlight.current) return;
    checkInFlight.current = true;
    setChecking(manual);
    if (manual) setFeedback(null);
    try {
      const next = await checkMobileAppUpdate();
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      if (next) {
        const snooze = readSnooze();
        if (manual || snooze?.version !== next.version || Number(snooze.until) <= Date.now()) {
          setUpdate(next);
          mobileHaptic(18);
        }
      } else if (manual) {
        setFeedback("latest");
        setFeedbackMessage(`当前 v${MOBILE_APP_VERSION} 已是最新版本`);
      }
    } catch (cause) {
      if (manual) {
        setFeedback("error");
        setFeedbackMessage(cause instanceof Error ? cause.message : "检查更新失败");
      }
    } finally {
      checkInFlight.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!isEmbeddedMobileRuntime()) return;
    const lastCheck = Number(localStorage.getItem(LAST_CHECK_KEY) || 0);
    const delay = Date.now() - lastCheck >= CHECK_INTERVAL_MS ? 1_500 : CHECK_INTERVAL_MS;
    const timer = window.setTimeout(() => void runCheck(false), delay);
    const handleManualCheck = () => void runCheck(true);
    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const checkedAt = Number(localStorage.getItem(LAST_CHECK_KEY) || 0);
      if (Date.now() - checkedAt >= CHECK_INTERVAL_MS) void runCheck(false);
    };
    window.addEventListener(MOBILE_UPDATE_CHECK_EVENT, handleManualCheck);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(MOBILE_UPDATE_CHECK_EVENT, handleManualCheck);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [runCheck]);

  useEffect(() => {
    if (!isEmbeddedMobileRuntime()) return;
    const handleBack = (event: Event) => {
      if (!update && !feedback) return;
      event.preventDefault();
      setUpdate(null);
      setFeedback(null);
    };
    window.addEventListener(MOBILE_BACK_EVENT, handleBack, { capture: true });
    return () => {
      window.removeEventListener(MOBILE_BACK_EVENT, handleBack, { capture: true });
    };
  }, [feedback, update]);

  if (!isEmbeddedMobileRuntime()) return null;

  const snoozeUpdate = () => {
    if (!update) return;
    localStorage.setItem(
      SNOOZE_KEY,
      JSON.stringify({
        version: update.version,
        until: Date.now() + SNOOZE_INTERVAL_MS,
      }),
    );
    setUpdate(null);
  };

  return (
    <>
      <Dialog open={Boolean(update)} onOpenChange={(open) => !open && snoozeUpdate()}>
        {update ? (
          <DialogContent
            layout="bottom-sheet-mobile"
            className="mobile-update-sheet"
            closeDisabled={downloading}
            closeLabel="稍后更新"
            showCloseButton
          >
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0 pr-10">
                <p className="text-xs font-medium text-primary">发现新版本 v{update.version}</p>
                <DialogTitle className="mt-1 truncate text-base leading-normal">
                  {update.title}
                </DialogTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  当前版本 v{update.currentVersion}
                </p>
              </div>
            </div>
            <div className="mobile-update-notes">{update.notes}</div>
            <div className="mt-5 flex gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-11 flex-1"
                onClick={snoozeUpdate}
              >
                稍后
              </Button>
              <Button
                type="button"
                className="h-11 flex-[1.5] gap-2"
                disabled={downloading}
                onClick={() => {
                  setDownloading(true);
                  void downloadMobileAppUpdate(update)
                    .then(() => setUpdate(null))
                    .catch((cause) => {
                      setUpdate(null);
                      setFeedback("error");
                      setFeedbackMessage(
                        cause instanceof Error ? cause.message : "无法打开安装包下载地址",
                      );
                    })
                    .finally(() => setDownloading(false));
                }}
              >
                {downloading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {downloading ? "正在打开" : "下载更新"}
              </Button>
            </div>
          </DialogContent>
        ) : null}
      </Dialog>

      {checking ? (
        <div className="mobile-runtime-toast">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在检查更新
        </div>
      ) : feedback ? (
        <button
          type="button"
          className={`mobile-runtime-toast ${feedback === "error" ? "text-destructive" : ""}`}
          onClick={() => setFeedback(null)}
        >
          <RefreshCw className="h-4 w-4" />
          <span className="min-w-0 truncate">{feedbackMessage}</span>
        </button>
      ) : null}
    </>
  );
}
