import { NavigationUpdateButton } from "@liveagent/ui/application/NavigationUpdateButton";
import { Loader2, RefreshCw } from "@liveagent/ui/components/IconSet";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  checkMobileAppUpdate,
  downloadMobileAppUpdate,
  MOBILE_APP_VERSION,
  MOBILE_UPDATE_CHECK_EVENT,
  type MobileAppUpdate,
} from "../../lib/mobileAppUpdate";
import { isEmbeddedMobileRuntime, MOBILE_BACK_EVENT, mobileHaptic } from "../../lib/mobileRuntime";
import { MobileUpdateDialog } from "./MobileUpdateDialog";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const LAST_CHECK_KEY = "zeroagent.mobile-update.last-check";
type CheckFeedback = "latest" | "error" | null;
type NavigationUpdate = { label: string; busy: boolean; open: () => void };
const MobileUpdateContext = createContext<NavigationUpdate | null>(null);

/** Presentation in either CloudChat or device navigation; ordinary Web stays empty. */
export function MobileSidebarUpdate() {
  const update = useContext(MobileUpdateContext);
  return update ? (
    <NavigationUpdateButton label={update.label} busy={update.busy} onClick={update.open} />
  ) : null;
}

export function MobileAppExperience({ children }: { children: ReactNode }) {
  const [checking, setChecking] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [update, setUpdate] = useState<MobileAppUpdate | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
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
      setUpdate(next);
      if (next && manual) {
        setUpdateOpen(true);
        mobileHaptic(18);
      } else if (!next && manual) {
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
      if (!updateOpen && !feedback) return;
      event.preventDefault();
      if (!downloading) setUpdateOpen(false);
      setFeedback(null);
    };
    window.addEventListener(MOBILE_BACK_EVENT, handleBack, { capture: true });
    return () => window.removeEventListener(MOBILE_BACK_EVENT, handleBack, { capture: true });
  }, [downloading, feedback, updateOpen]);

  const closeUpdate = () => {
    if (!downloading) setUpdateOpen(false);
  };
  const download = () => {
    if (!update || downloading) return;
    setDownloading(true);
    void downloadMobileAppUpdate(update)
      .then(() => setUpdateOpen(false))
      .catch((cause) => {
        setUpdateOpen(false);
        setFeedback("error");
        setFeedbackMessage(cause instanceof Error ? cause.message : "无法打开安装包下载地址");
      })
      .finally(() => setDownloading(false));
  };

  return (
    <MobileUpdateContext.Provider
      value={
        update
          ? {
              label: downloading ? "正在打开更新下载" : `有可用更新 · v${update.version}`,
              busy: downloading,
              open: () => {
                mobileHaptic(12);
                setUpdateOpen(true);
              },
            }
          : null
      }
    >
      {children}
      <MobileUpdateDialog
        update={update}
        open={updateOpen}
        downloading={downloading}
        onClose={closeUpdate}
        onDownload={download}
      />
      {checking ? (
        <div className="mobile-runtime-toast" role="status">
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
    </MobileUpdateContext.Provider>
  );
}
