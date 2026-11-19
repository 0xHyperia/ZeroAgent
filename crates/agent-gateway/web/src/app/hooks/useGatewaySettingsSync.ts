import {
  type CronSnapshot,
  feedCronSnapshot,
  feedHooksSnapshot,
  type HooksSnapshot,
  initAutomation,
} from "@liveagent/ui/lib/automation/index";
import { useCatalogLiveVersion } from "@liveagent/ui/lib/models/useThinkingLive";
import { setPreferredMonacoNlsLocale } from "@liveagent/ui/lib/monacoNls";
import { GatewaySettingsSaveLineage } from "@liveagent/ui/lib/settings/gatewaySettingsSaveLineage";
import {
  applyGatewaySettingsSyncPayload,
  type GatewaySettingsSyncUpdatePayload,
  redactSettingsForWebStorage,
} from "@liveagent/ui/lib/settings/sync";
import { applyFontFamilies } from "@liveagent/ui/lib/shared/fontFamily";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Locale, t } from "@/i18n/config";
import { gatewayOrigin } from "@/lib/desktopRemoteHost";
import type { GatewayWebSocketClientLike } from "@/lib/gatewaySocket";
import { GatewaySettingsUpdateError } from "@/lib/gatewaySocketRpc";
import {
  type AppSettings,
  normalizeSettings,
  refreshCatalogDerivedModelLimits,
  resolveEffectiveTheme,
  subscribeToSystemThemePreference,
} from "@/lib/settings";
import { loadToken } from "@/lib/storage";
import { loadWebSettings, persistWebSettings, type WebSettingsSaveState } from "@/lib/webSettings";

import { asErrorMessage } from "../chatEventUtils";
import { hasSettingsSyncChanged, resolveAppWorkspaceProjects } from "../historyUtils";

export function getGatewaySettingsErrorMessage(error: unknown, fallback: string, locale: Locale) {
  if (error instanceof GatewaySettingsUpdateError && error.code === "configuration_changed") {
    return locale === "en-US"
      ? "Settings changed elsewhere. Review the latest settings and submit your edit again."
      : "配置已由其他窗口或后台更新，请核对最新内容后重新提交修改。";
  }
  if (error instanceof GatewaySettingsUpdateError && error.code === "settings_changed") {
    return t("app.settingsSshSettingsChanged", locale);
  }
  return asErrorMessage(error, fallback);
}

export function projectPromptSettingsUpdate(
  update: GatewaySettingsSyncUpdatePayload,
  prev: AppSettings,
  next: AppSettings,
) {
  // Native device configuration commits project prompts with the rest of the
  // versioned batch; only the standalone Gateway uses separate prompt resources.
  if (update.settingsSyncProtocol === "zeroagent.settings-sync.v1") return;
  if (!update.system) return;
  const projects: NonNullable<GatewaySettingsSyncUpdatePayload["projectPrompts"]> = {};
  const before = prev.system.workspaceResourceSettings;
  const after = next.system.workspaceResourceSettings;
  let resourceSelectionChanged = false;
  for (const path of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const selection = (entry: (typeof before)[string] | undefined) => ({
      mode: entry?.mode ?? "inherit",
      skillNames: entry?.skillNames ?? [],
      mcpServerIds: entry?.mcpServerIds ?? [],
    });
    if (JSON.stringify(selection(before[path])) !== JSON.stringify(selection(after[path]))) {
      resourceSelectionChanged = true;
    }
    const prompt = after[path]?.projectPrompt ?? "";
    const strategy = after[path]?.projectPromptStrategy ?? "append";
    if (
      prompt !== (before[path]?.projectPrompt ?? "") ||
      strategy !== (before[path]?.projectPromptStrategy ?? "append")
    ) {
      projects[path] = { prompt, strategy };
    }
  }
  if (Object.keys(projects).length) update.projectPrompts = projects;
  // Project layout belongs to this browser; unrelated system changes must still be validated.
  const sharedSystem = (system: AppSettings["system"]) => {
    const {
      workspaceProjects: _projects,
      workspaceResourceSettings: _resources,
      activeWorkspaceProjectId: _active,
      ...shared
    } = system;
    return shared;
  };
  if (
    JSON.stringify(sharedSystem(prev.system)) === JSON.stringify(sharedSystem(next.system)) &&
    !resourceSelectionChanged &&
    update.systemProxyPasswordUpdate === undefined
  ) {
    delete update.system;
  }
}

export function useGatewaySettingsSync(params: {
  token: string;
  api: GatewayWebSocketClientLike | null;
  activeAgentId: string;
}) {
  const { token, api, activeAgentId } = params;
  // Queued saves and their callbacks belong to the device that originated them.
  const saveScope = useMemo(() => ({ api, token, activeAgentId }), [api, token, activeAgentId]);
  const saveScopeRef = useRef<typeof saveScope | null>(saveScope);
  saveScopeRef.current = saveScope;
  useEffect(() => {
    saveScopeRef.current = saveScope;
    return () => {
      if (saveScopeRef.current === saveScope) saveScopeRef.current = null;
    };
  }, [saveScope]);
  const [settings, setSettingsState] = useState<AppSettings>(() => loadWebSettings(loadToken()));
  const [settingsSyncReady, setSettingsSyncReady] = useState(() => token.trim() === "");
  const [settledSettingsTarget, setSettledSettingsTarget] =
    useState<GatewayWebSocketClientLike | null>(null);
  const [settingsSyncError, setSettingsSyncError] = useState<string | null>(null);
  const [settingsSaveState, setSettingsSaveState] = useState<WebSettingsSaveState>({
    status: "saved",
  });
  const settingsSaveSequenceRef = useRef(0);
  const settingsSnapshotEpoch = useRef(0);
  const settingsSaveChainRef = useRef<Promise<unknown>>(Promise.resolve());
  const saveLineage = useRef(new GatewaySettingsSaveLineage());
  const backendPromptResourcesRef = useRef(false);
  // Mirrors `settings` so setSettings/applyGatewaySettings can read the latest value
  // synchronously without passing a (side-effecting) function into setSettingsState —
  // React 18 StrictMode double-invokes functional state updaters in development,
  // which would otherwise run those side effects (and any non-idempotent work like
  // crypto.randomUUID() inside caller updaters) twice per call.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [systemThemeVersion, setSystemThemeVersion] = useState(0);

  const catalogVersion = useCatalogLiveVersion();
  useEffect(() => {
    if (catalogVersion === 0) return;
    const refreshed = refreshCatalogDerivedModelLimits(settingsRef.current);
    if (refreshed === settingsRef.current) return;
    settingsRef.current = refreshed;
    setSettingsState(refreshed);
  }, [catalogVersion]);

  // Monaco reads NLS globals while the lazy editor module imports monaco-editor.
  setPreferredMonacoNlsLocale(settings.locale);

  useEffect(() => {
    if (settings.theme !== "system") return;
    return subscribeToSystemThemePreference(() => {
      setSystemThemeVersion((version) => version + 1);
    });
  }, [settings.theme]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: system theme notifications intentionally invalidate the computed theme
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolveEffectiveTheme(settings.theme) === "dark");
    root.lang = settings.locale;
  }, [settings.locale, settings.theme, systemThemeVersion]);

  useEffect(() => {
    applyFontFamilies({
      interfaceFontFamily: settings.customSettings.interfaceFontFamily,
      chatFontFamily: settings.customSettings.chatFontFamily,
      codeFontFamily: settings.customSettings.codeFontFamily,
    });
  }, [
    settings.customSettings.interfaceFontFamily,
    settings.customSettings.chatFontFamily,
    settings.customSettings.codeFontFamily,
  ]);

  useEffect(() => {
    setSettingsState((prev) =>
      resolveAppWorkspaceProjects(
        normalizeSettings({
          ...prev,
          remote: {
            ...prev.remote,
            gatewayUrl: gatewayOrigin(),
            token: token.trim(),
            enabled: token.trim() !== "" || prev.remote.enabled,
          },
        }),
      ),
    );
  }, [token]);

  const queueSettingsSave = useCallback(
    (prev: AppSettings, next: AppSettings, fallback: string, syncGateway: boolean) => {
      const isCurrentScope = () => saveScopeRef.current === saveScope;
      if (!isCurrentScope()) return;
      const saveSequence = ++settingsSaveSequenceRef.current;
      setSettingsSaveState({ status: "saving" });
      const redactedNext = redactSettingsForWebStorage(next);
      settingsSaveChainRef.current = settingsSaveChainRef.current
        .catch(() => undefined)
        .then(() => {
          if (isCurrentScope()) persistWebSettings(redactedNext);
        })
        .then(async () => {
          if (!isCurrentScope()) return;
          const target = JSON.stringify([saveScope.activeAgentId, saveScope.token]);
          const gatewayUpdate =
            syncGateway && api ? saveLineage.current.prepare(prev, next, target) : null;
          if (gatewayUpdate && backendPromptResourcesRef.current) {
            projectPromptSettingsUpdate(gatewayUpdate, prev, next);
          }
          if (gatewayUpdate && Object.keys(gatewayUpdate).length > 0) {
            const snapshotEpoch = settingsSnapshotEpoch.current;
            const receipt = await api?.updateSettings(gatewayUpdate);
            if (!isCurrentScope()) return;
            saveLineage.current.accept(prev, next, target, receipt);
            if (
              receipt?.snapshot &&
              settingsSaveSequenceRef.current === saveSequence &&
              settingsSnapshotEpoch.current === snapshotEpoch
            ) {
              const committed = redactSettingsForWebStorage(
                resolveAppWorkspaceProjects(
                  applyGatewaySettingsSyncPayload(settingsRef.current, receipt.snapshot),
                ),
              );
              settingsRef.current = committed;
              setSettingsState(committed);
              persistWebSettings(committed);
            }
            return receipt?.warning;
          }
        })
        .then((warning) => {
          if (isCurrentScope() && settingsSaveSequenceRef.current === saveSequence) {
            setSettingsSaveState(
              warning ? { status: "error", message: warning } : { status: "saved" },
            );
          }
        })
        .catch(async (error) => {
          if (!isCurrentScope()) return;
          saveLineage.current.clear();
          console.error("Failed to persist gateway settings", error);
          if (syncGateway && api) {
            const snapshotEpoch = settingsSnapshotEpoch.current;
            await api
              .getSettings()
              .then((payload) => {
                if (
                  !isCurrentScope() ||
                  settingsSaveSequenceRef.current !== saveSequence ||
                  settingsSnapshotEpoch.current !== snapshotEpoch
                )
                  return;
                const current = settingsRef.current;
                const refreshed = redactSettingsForWebStorage(
                  resolveAppWorkspaceProjects(applyGatewaySettingsSyncPayload(current, payload)),
                );
                settingsRef.current = refreshed;
                persistWebSettings(refreshed);
                setSettingsState(refreshed);
              })
              .catch(() => undefined);
          }
          if (isCurrentScope() && settingsSaveSequenceRef.current === saveSequence) {
            setSettingsSaveState({
              status: "error",
              message: getGatewaySettingsErrorMessage(error, fallback, settingsRef.current.locale),
            });
          }
        });
    },
    [api, saveScope],
  );

  const applyGatewaySettings = useCallback((payload: GatewaySettingsSyncUpdatePayload) => {
    if (Object.hasOwn(payload, "projectPrompts")) backendPromptResourcesRef.current = true;
    // Automation snapshots ride along on the settings-sync channel but are
    // desktop-owned state with their own revision — feed them straight into
    // the automation store instead of the settings state.
    const automation = payload as {
      automationCron?: CronSnapshot;
      automationHooks?: HooksSnapshot;
    };
    if (automation.automationCron) {
      feedCronSnapshot(automation.automationCron);
    }
    if (automation.automationHooks) {
      feedHooksSnapshot(automation.automationHooks);
    }
    const prev = settingsRef.current;
    const rawNext = resolveAppWorkspaceProjects(applyGatewaySettingsSyncPayload(prev, payload));
    const next = redactSettingsForWebStorage(rawNext);
    if (
      !hasSettingsSyncChanged(prev, next) &&
      prev.kbrainWebSearch?.available === next.kbrainWebSearch?.available &&
      prev.kbrainWebSearch?.provider === next.kbrainWebSearch?.provider &&
      prev.configurationRevision === next.configurationRevision &&
      prev.uiPreferencesRevision === next.uiPreferencesRevision &&
      prev.settingsSyncProtocol === next.settingsSyncProtocol
    ) {
      return;
    }
    settingsRef.current = next;
    setSettingsState(next);
    // Gateway/desktop pushes are hydration, not user edits. Persist the
    // already-redacted browser cache directly so opening Settings never
    // flashes “saving” or sends the hydrated value back to the desktop.
    try {
      persistWebSettings(next);
    } catch (error) {
      setSettingsSaveState({
        status: "error",
        message: asErrorMessage(error, "缓存桌面端设置失败。"),
      });
    }
  }, []);

  const setSettings = useCallback(
    (updater: (prev: AppSettings) => AppSettings) => {
      const prev = settingsRef.current;
      const updated = updater(prev);
      if (updated === prev) return;
      const rawNext = resolveAppWorkspaceProjects(normalizeSettings(updated));
      const next = redactSettingsForWebStorage(rawNext);
      settingsRef.current = next;
      setSettingsState(next);
      queueSettingsSave(prev, rawNext, t("app.webSettingsSaveFailed", next.locale), true);
    },
    [queueSettingsSave],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: switching the active agent intentionally starts a fresh settings synchronization
  useEffect(() => {
    backendPromptResourcesRef.current = false;
    if (settingsRef.current.kbrainWebSearch) {
      const next = { ...settingsRef.current, kbrainWebSearch: undefined };
      settingsRef.current = next;
      setSettingsState(next);
    }
    // A slow old device must not block saves to the new device.
    settingsSaveChainRef.current = Promise.resolve();
    settingsSaveSequenceRef.current += 1;
    setSettingsSaveState({ status: "saved" });
    saveLineage.current.clear();
    if (!api) {
      setSettingsSyncReady(token.trim() === "");
      setSettledSettingsTarget(null);
      setSettingsSyncError(null);
      return;
    }

    let cancelled = false;
    setSettingsSyncReady(false);
    setSettingsSyncError(null);
    // Best-effort: the desktop may be offline; the settings-sync push
    // populates the store once it connects.
    void initAutomation().catch(() => undefined);
    const initialSnapshotEpoch = settingsSnapshotEpoch.current;
    const applySyncedSettings = (payload: GatewaySettingsSyncUpdatePayload) => {
      if (cancelled) {
        return;
      }
      settingsSnapshotEpoch.current += 1;
      applyGatewaySettings(payload);
      setSettingsSyncError(null);
    };
    const unsubscribe = api.subscribeSettings(applySyncedSettings);

    void api
      .getSettings()
      .then((payload) => {
        if (!cancelled) {
          // A live WS push that arrived while GET was in flight is newer.
          if (settingsSnapshotEpoch.current === initialSnapshotEpoch) {
            applySyncedSettings(payload);
          }
        }
        if (!cancelled) {
          setSettledSettingsTarget(api);
          setSettingsSyncReady(true);
          setSettingsSyncError(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSettingsSyncError(
            asErrorMessage(error, t("app.desktopSettingsSyncFailed", settingsRef.current.locale)),
          );
          setSettledSettingsTarget(api);
          setSettingsSyncReady(true);
        }
      });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, activeAgentId, applyGatewaySettings, token]);

  return {
    settings,
    setSettings,
    settingsSyncReady,
    settingsSyncTargetReady: Boolean(api && settingsSyncReady && settledSettingsTarget === api),
    settingsSyncError,
    settingsSaveState,
  };
}
