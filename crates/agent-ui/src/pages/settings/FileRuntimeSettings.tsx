import "@liveagent/ui/i18n/namespaces/settings";
import { Button } from "@liveagent/ui/components/ui/button";
import type {
  FileRuntimeControls,
  FileRuntimeManagementAction,
  FileRuntimePhase,
  FileRuntimeSource,
  FileRuntimeStatus,
} from "@liveagent/ui/contracts/fileRuntime";
import { useLocale } from "@liveagent/ui/i18n/index";
import { formatTransferBytes } from "@liveagent/ui/lib/chat/sshManagerDisplay";
import { useEffect, useRef, useState } from "react";
import { AgentActivationSwitch, ConfirmActionPopover, SettingsGroup, SettingsRow } from "./shared";

const runtimeErrors = new Set([
  "download_failed",
  "archive_invalid",
  "verification_failed",
  "storage_unavailable",
  "file_selection_failed",
]);

function isPreparing(phase?: FileRuntimePhase) {
  return phase === "downloading" || phase === "verifying";
}

export function FileRuntimeSettings({ controls }: { controls: FileRuntimeControls }) {
  const { t } = useLocale();
  const [status, setStatus] = useState<FileRuntimeStatus>();
  const [readFailed, setReadFailed] = useState(false);
  const [actionError, setActionError] = useState<"requestFailed" | "restartFailed">();
  const [actionPending, setActionPending] = useState(false);
  const [checked, setChecked] = useState(false);
  const actionLock = useRef(false);
  const actionVersion = useRef(0);
  const preparing = isPreparing(status?.phase);
  const busy = actionPending || preparing;

  useEffect(() => {
    let mounted = true;
    let reading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const check = async () => {
      clearTimeout(timer);
      if (!mounted || document.hidden || reading) return;
      reading = true;
      const version = actionVersion.current;
      let needsPoll = actionPending || preparing;
      try {
        const next = await controls.status();
        if (!mounted || actionVersion.current !== version) return;
        setStatus(next);
        setReadFailed(false);
        needsPoll = actionPending || isPreparing(next.phase);
      } catch {
        if (mounted && actionVersion.current === version) setReadFailed(true);
      } finally {
        reading = false;
        if (mounted && !document.hidden && needsPoll) timer = setTimeout(check, 1_000);
      }
    };
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    void check();
    return () => {
      mounted = false;
      clearTimeout(timer);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [actionPending, controls, preparing]);

  async function runAction(
    action: FileRuntimeSource | FileRuntimeManagementAction | "diagnose" | "restart",
  ) {
    if (actionLock.current || preparing) return;
    actionLock.current = true;
    actionVersion.current += 1;
    setActionPending(true);
    setActionError(undefined);
    setChecked(false);
    try {
      if (action === "restart") {
        await controls.restart?.();
      } else {
        const result =
          action === "diagnose"
            ? await controls.diagnose()
            : action === "offline" || action === "download"
              ? await controls.prepare(action)
              : await controls.manage(action);
        setStatus(result);
        setChecked(action === "diagnose");
        setReadFailed(false);
      }
    } catch {
      setActionError(action === "restart" ? "restartFailed" : "requestFailed");
    } finally {
      actionLock.current = false;
      actionVersion.current += 1;
      setActionPending(false);
    }
  }

  const statusMessage =
    status?.error && runtimeErrors.has(status.error)
      ? t(`settings.fileRuntime.${status.error}`)
      : t(`settings.fileRuntime.${status?.phase ?? (readFailed ? "checkFailed" : "checking")}`);
  const size = status?.download_bytes;
  const downloaded = status?.downloaded_bytes;
  const showProgress = status?.phase === "downloading" && size && size > 0;
  const removal = status?.phase === "pending_removal";
  const restart =
    status?.phase === "pending_restart" ||
    status?.phase === "pending_enable" ||
    status?.phase === "pending_disable" ||
    removal;
  const canInstall = status?.can_import && status.phase !== "pending_restart" && !preparing;
  const canDetach = status?.external && status.can_manage && status.enabled;
  const canRemove = !removal && (status?.can_remove || canDetach);
  const detach = canDetach && !status?.can_remove;
  const details = [
    status?.version && t("settings.fileRuntime.version").replace("{version}", status.version),
    size &&
      status?.can_download &&
      t("settings.fileRuntime.size").replace("{size}", formatTransferBytes(size)),
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <SettingsGroup title={t("settings.fileRuntime.group")} data-settings-anchor="file-runtime">
      <SettingsRow
        title={t("settings.fileRuntime.title")}
        description={
          <div className="space-y-1">
            <p>{t("settings.fileRuntime.description")}</p>
            <p role="status">{statusMessage}</p>
            {status?.external && <p>{t("settings.fileRuntime.externalSource")}</p>}
            {details && <p>{details}</p>}
            {status?.ready &&
              (preparing || status.phase === "failed" || status.phase === "pending_restart") && (
                <p>{t("settings.fileRuntime.previousReady")}</p>
              )}
            {showProgress ? (
              <div className="flex items-center gap-2">
                <progress
                  className="h-1.5 w-32 max-w-full accent-current"
                  aria-label={statusMessage}
                  max={size}
                  value={downloaded === undefined ? undefined : Math.min(downloaded, size)}
                />
                {downloaded !== undefined && <span>{formatTransferBytes(downloaded)}</span>}
              </div>
            ) : null}
            {actionError && <p role="status">{t(`settings.fileRuntime.${actionError}`)}</p>}
            {restart && controls.restart && (
              <Button size="sm" disabled={busy} onClick={() => void runAction("restart")}>
                {t("settings.fileRuntime.restart")}
              </Button>
            )}
          </div>
        }
        control={
          <AgentActivationSwitch
            title={t("settings.fileRuntime.title")}
            checked={status?.enabled === true}
            disabled={!status?.can_manage || busy || removal}
            onToggle={() => void runAction(status?.enabled ? "disable" : "enable")}
          />
        }
      />
      <SettingsRow
        title={t("settings.fileRuntime.checkTitle")}
        description={t(
          checked && status
            ? status.ready
              ? "settings.fileRuntime.checkReady"
              : "settings.fileRuntime.checkNotReady"
            : "settings.fileRuntime.checkDescription",
        )}
        control={
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() => void runAction("diagnose")}
          >
            {t("settings.fileRuntime.check")}
          </Button>
        }
      />
      {status && !preparing && status.phase !== "pending_restart" && (
        <SettingsRow
          title={t(
            status.ready ? "settings.fileRuntime.repair" : "settings.fileRuntime.installTitle",
          )}
          description={t(
            !status.enabled
              ? "settings.fileRuntime.installDisabled"
              : !status.can_import
                ? "settings.fileRuntime.installUnavailable"
                : "settings.fileRuntime.installDescription",
          )}
          control={
            canInstall ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void runAction("offline")}
                >
                  {t("settings.fileRuntime.import")}
                </Button>
                {status.can_download && (
                  <Button size="sm" disabled={busy} onClick={() => void runAction("download")}>
                    {t(
                      status.ready
                        ? "settings.fileRuntime.repair"
                        : status.phase === "failed"
                          ? "settings.fileRuntime.retry"
                          : "settings.fileRuntime.prepare",
                    )}
                  </Button>
                )}
              </div>
            ) : (
              <Button variant="secondary" size="sm" disabled>
                {t(
                  status.ready
                    ? "settings.fileRuntime.repair"
                    : "settings.fileRuntime.installTitle",
                )}
              </Button>
            )
          }
        />
      )}
      {status && !removal && (
        <SettingsRow
          title={t("settings.fileRuntime.removeTitle")}
          description={t(
            detach
              ? "settings.fileRuntime.detachDescription"
              : canRemove
                ? "settings.fileRuntime.removeDescription"
                : "settings.fileRuntime.removeUnavailable",
          )}
          control={
            canRemove ? (
              <ConfirmActionPopover
                title={t(
                  detach
                    ? "settings.fileRuntime.detachConfirmTitle"
                    : "settings.fileRuntime.removeConfirmTitle",
                )}
                description={t(
                  detach
                    ? "settings.fileRuntime.detachDescription"
                    : "settings.fileRuntime.removeConfirmDescription",
                )}
                confirmLabel={t(
                  detach
                    ? "settings.fileRuntime.detachConfirm"
                    : "settings.fileRuntime.removeConfirm",
                )}
                onConfirm={() => void runAction(detach ? "disable" : "remove")}
              >
                {() => (
                  <Button variant={detach ? "secondary" : "destructive"} size="sm" disabled={busy}>
                    {t(detach ? "settings.fileRuntime.detach" : "settings.fileRuntime.remove")}
                  </Button>
                )}
              </ConfirmActionPopover>
            ) : (
              <Button variant="secondary" size="sm" disabled>
                {t("settings.fileRuntime.remove")}
              </Button>
            )
          }
        />
      )}
    </SettingsGroup>
  );
}
