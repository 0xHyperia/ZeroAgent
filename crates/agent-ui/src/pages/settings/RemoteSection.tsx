import {
  type AppSettings,
  MAX_REMOTE_HEARTBEAT_INTERVAL_SECONDS,
  MIN_REMOTE_HEARTBEAT_INTERVAL_SECONDS,
} from "@liveagent/app/lib/settings";
import type { SettingsSectionProps } from "@liveagent/app/pages/settings/types";
import { invoke } from "@liveagent/app/shims/tauriCore";
import { listen } from "@liveagent/app/shims/tauriEvent";
import { Wifi, WifiOff } from "@liveagent/ui/components/IconSet";
import { CopyButton } from "@liveagent/ui/components/ui/copy-button";
import { Input } from "@liveagent/ui/components/ui/input";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import {
  normalizeIntegerDraftInput,
  parseIntegerDraftValue,
} from "@liveagent/ui/pages/settings/remoteInput";
import {
  AgentActivationSwitch,
  SettingsGroup,
  SettingsRow,
} from "@liveagent/ui/pages/settings/shared";
import { useCallback, useEffect, useState } from "react";

function RemoteToggleRow({
  title,
  description,
  checked,
  onToggle,
}: {
  title: string;
  description: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <SettingsRow
      title={title}
      description={description}
      control={<AgentActivationSwitch checked={checked} title={title} onToggle={onToggle} />}
    />
  );
}

type GatewayRuntimeStatus = {
  online: boolean;
  enabled: boolean;
  configured: boolean;
  gatewayUrl?: string;
  sessionId?: string | null;
  connectedSince?: number | null;
  lastHeartbeat?: number | null;
  lastError?: string | null;
  /** 当前链路协议："v2"（WebSocket+Protobuf）或 "v1"（弃用的 WebSocket 回退）。 */
  protocol?: string | null;
};

function updateRemoteSettings(
  setSettings: SettingsSectionProps["setSettings"],
  patch: Partial<AppSettings["remote"]>,
) {
  setSettings((prev) => ({
    ...prev,
    remote: {
      ...prev.remote,
      ...patch,
    },
  }));
}

function usePositiveIntegerDraft(
  value: number,
  options: { min?: number; max?: number },
  onCommit: (nextValue: number) => void,
) {
  const [draft, setDraft] = useState(() => String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const handleChange = useCallback(
    (rawValue: string) => {
      const nextDraft = normalizeIntegerDraftInput(rawValue);
      setDraft(nextDraft);

      const parsed = parseIntegerDraftValue(nextDraft, options);
      if (parsed !== null && parsed !== value) {
        onCommit(parsed);
      }
    },
    [onCommit, options, value],
  );

  const handleBlur = useCallback(() => {
    const parsed = parseIntegerDraftValue(draft, options);
    if (parsed === null) {
      setDraft(String(value));
      return;
    }

    setDraft(String(parsed));
    if (parsed !== value) {
      onCommit(parsed);
    }
  }, [draft, onCommit, options, value]);

  return {
    draft,
    handleBlur,
    handleChange,
  };
}

function formatTimestamp(locale: string, value?: number | null) {
  if (!value) return "—";
  const timestampMs = value > 1_000_000_000_000 ? value : value * 1000;
  return new Date(timestampMs).toLocaleString(locale);
}

export function RemoteSection(props: SettingsSectionProps & { surface?: "desktop" | "web" }) {
  const { settings, setSettings } = props;
  const { locale, t } = useLocale();
  const remoteHeartbeatDraft = usePositiveIntegerDraft(
    settings.remote.heartbeatInterval,
    {
      min: MIN_REMOTE_HEARTBEAT_INTERVAL_SECONDS,
      max: MAX_REMOTE_HEARTBEAT_INTERVAL_SECONDS,
    },
    (heartbeatInterval) =>
      updateRemoteSettings(setSettings, {
        heartbeatInterval,
      }),
  );
  const [status, setStatus] = useState<GatewayRuntimeStatus>({
    online: false,
    enabled: settings.remote.enabled,
    configured: false,
  });
  const remoteConfigured =
    settings.remote.gatewayUrl.trim() !== "" && settings.remote.agentId.trim() !== "";

  useEffect(() => {
    let cancelled = false;

    void invoke<GatewayRuntimeStatus>("gateway_status")
      .then((next) => {
        if (!cancelled) {
          setStatus(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setStatus((prev) => ({
            ...prev,
            online: false,
            enabled: settings.remote.enabled,
            configured: remoteConfigured,
            gatewayUrl: settings.remote.gatewayUrl.trim(),
            sessionId: null,
            connectedSince: null,
            lastHeartbeat: null,
          }));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [remoteConfigured, settings.remote.enabled, settings.remote.gatewayUrl]);

  useEffect(() => {
    let cancelled = false;
    let dispose: (() => void) | null = null;

    void listen<GatewayRuntimeStatus>("gateway:status", (event) => {
      if (!cancelled) {
        setStatus(event.payload);
      }
    }).then((unlisten) => {
      dispose = unlisten;
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  // The settings switch is authoritative while the Rust runtime catches up.
  const isConnected = settings.remote.enabled && status.enabled && Boolean(status.online);

  const connectedProtocol = status.protocol?.trim();
  const statusError =
    settings.remote.enabled && !isConnected ? status.lastError?.trim() : undefined;
  const unauthorized = statusError?.toLowerCase() === "unauthorized";
  const statusText = !settings.remote.enabled
    ? t("settings.remoteDisabled")
    : isConnected
      ? connectedProtocol
        ? t("settings.remoteConnectedProtocol").replace("{protocol}", connectedProtocol)
        : t("settings.remoteConnected")
      : unauthorized
        ? t("settings.remoteUnauthorized")
        : statusError
          ? t("settings.remoteConnectionFailed")
          : t("settings.remoteDisconnected");
  const StatusIcon = isConnected ? Wifi : WifiOff;

  return (
    <div className="space-y-6">
      <SettingsGroup title={t("settings.remoteGatewayConnection")}>
        <SettingsRow
          title={t("settings.remoteEnable")}
          description={t("settings.remoteDesc")}
          control={
            <div className="flex flex-wrap items-center gap-3">
              <span
                role="status"
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium",
                  isConnected
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : statusError
                      ? "bg-amber-500/10 text-amber-800 dark:text-amber-300"
                      : "bg-settings-tile-hover text-muted-foreground",
                )}
                title={statusError}
              >
                <StatusIcon className="size-3.5 shrink-0" aria-hidden="true" />
                {statusText}
              </span>
              <AgentActivationSwitch
                checked={settings.remote.enabled}
                title={t("settings.remoteEnable")}
                onToggle={() =>
                  updateRemoteSettings(setSettings, { enabled: !settings.remote.enabled })
                }
              />
            </div>
          }
        />
        <RemoteToggleRow
          title={t("settings.remoteAutoReconnect")}
          description={t("settings.remoteAutoReconnectHint")}
          checked={settings.remote.autoReconnect}
          onToggle={() =>
            updateRemoteSettings(setSettings, { autoReconnect: !settings.remote.autoReconnect })
          }
        />
        <SettingsRow
          title={<label htmlFor="remote-heartbeat">{t("settings.remoteHeartbeat")}</label>}
          description={<span id="remote-heartbeat-hint">{t("settings.remoteHeartbeatHint")}</span>}
          control={
            <div className="flex items-center gap-2">
              <Input
                id="remote-heartbeat"
                type="text"
                inputMode="numeric"
                aria-describedby="remote-heartbeat-hint remote-heartbeat-unit"
                value={remoteHeartbeatDraft.draft}
                onBlur={remoteHeartbeatDraft.handleBlur}
                onChange={(event) => remoteHeartbeatDraft.handleChange(event.target.value)}
                placeholder="30"
                className="w-20 tabular-nums max-[640px]:h-11 max-[640px]:text-base"
              />
              <span id="remote-heartbeat-unit" className="text-xs text-muted-foreground">
                {t("settings.remoteHeartbeatUnit")}
              </span>
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.remoteWebPermissions")}>
        <RemoteToggleRow
          title={t("settings.remoteWebTerminal")}
          description={t("settings.remoteWebTerminalHint")}
          checked={settings.remote.enableWebTerminal}
          onToggle={() =>
            updateRemoteSettings(setSettings, {
              enableWebTerminal: !settings.remote.enableWebTerminal,
            })
          }
        />
        <RemoteToggleRow
          title={t("settings.remoteWebSshTerminal")}
          description={t("settings.remoteWebSshTerminalHint")}
          checked={settings.remote.enableWebSshTerminal}
          onToggle={() =>
            updateRemoteSettings(setSettings, {
              enableWebSshTerminal: !settings.remote.enableWebSshTerminal,
            })
          }
        />
        <RemoteToggleRow
          title={t("settings.remoteWebGit")}
          description={t("settings.remoteWebGitHint")}
          checked={settings.remote.enableWebGit}
          onToggle={() =>
            updateRemoteSettings(setSettings, { enableWebGit: !settings.remote.enableWebGit })
          }
        />
        <RemoteToggleRow
          title={t("settings.remoteWebTunnels")}
          description={t("settings.remoteWebTunnelsHint")}
          checked={settings.remote.enableWebTunnels}
          onToggle={() =>
            updateRemoteSettings(setSettings, {
              enableWebTunnels: !settings.remote.enableWebTunnels,
            })
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.remoteAuth")}>
        <SettingsRow
          className="flex-col items-stretch gap-3"
          title={<label htmlFor="remote-agent-id">{t("settings.remoteAgentId")}</label>}
          description={<span id="remote-agent-id-hint">{t("settings.remoteAgentIdHint")}</span>}
          control={
            <div className="flex w-full min-w-0 items-center gap-2">
              <Input
                id="remote-agent-id"
                type="text"
                readOnly
                aria-describedby="remote-agent-id-hint"
                value={settings.remote.agentId}
                className="min-w-0 font-mono text-sm max-[640px]:h-11 max-[640px]:text-base"
              />
              <CopyButton
                value={settings.remote.agentId}
                label={t("settings.remoteCopyAgentId")}
                copiedLabel={t("chat.markdown.copied")}
                className="size-9 max-[640px]:size-11"
              />
            </div>
          }
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.remoteConnectionStatus")}>
        <SettingsRow
          title={t("settings.remoteConnectedSince")}
          control={
            <span className="text-sm tabular-nums text-muted-foreground">
              {formatTimestamp(locale, status.connectedSince)}
            </span>
          }
        />
        <SettingsRow
          title={t("settings.remoteLastHeartbeat")}
          control={
            <span className="text-sm tabular-nums text-muted-foreground">
              {formatTimestamp(locale, status.lastHeartbeat)}
            </span>
          }
        />
      </SettingsGroup>
    </div>
  );
}
