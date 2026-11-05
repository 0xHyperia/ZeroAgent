import { invoke } from "@liveagent/app/shims/tauriCore";
import {
  buildGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncUpdatePayload,
} from "@liveagent/ui/lib/settings/sync";
import type { Locale } from "../../i18n/config";
import { isKBrainBackendEnabled, isKBrainBrowserHost } from "../host";
import { createKBrainClient, type KBrainBackendConfiguration } from "../kbrain/client";
import { KBRAIN_CONFIGURATION_PROTOCOL } from "../kbrain/configurationVersion";
import { kBrainStorageScope } from "../kbrain/mapping";
import { fromKBrainMcpSettings, toKBrainMcpSettings } from "../kbrain/mcp";
import { createKBrainPromptClient, type KBrainPromptSnapshot } from "../kbrain/prompts";
import {
  appProvidersFromKBrain,
  kBrainSettingsUpdateForCatalogRefresh,
  kBrainSettingsUpdateForMissingInputModalities,
  kBrainSettingsUpdateFromAppSettings,
  loadKBrainProviderSettings,
  saveKBrainProviderSettings,
} from "../kbrain/providerSettings";
import {
  getConfiguredKBrainConnection,
  getKBrainRuntimeConnection,
} from "../kbrain/runtimeConnection";
import type { KBrainSettingsDocument } from "../kbrain/types";
import { SettingsStorageError, type SettingsStorageErrorCode } from "./errors";
import {
  type AppSettings,
  type ChatRuntimeControls,
  type CustomProvider,
  getDefaultSettings,
  normalizeSettings,
  resolveWorkspaceProjects,
  type Theme,
  workspaceProjectPathKey,
} from "./index";

const LOCAL_UI_SETTINGS_STORAGE_KEY = "liveagent.ui-settings.v1";
const BROWSER_SETTINGS_STORAGE_KEY = "liveagent.kbrain-browser-settings.v1";

function settingsStorageKey(key: string): string {
  const connection = getKBrainRuntimeConnection();
  return connection?.managedLocal ? `${key}:${kBrainStorageScope()}` : key;
}

type CanonicalBackendDocuments = {
  settings: KBrainSettingsDocument;
  mcp: unknown;
  prompts: KBrainPromptSnapshot;
  skills?: { settings: AppSettings["skills"] };
};

type PersistedSettingsResponse = {
  uiRevision?: string;
  uiPreferences?: Record<string, unknown> | null;
  nativeRevision?: string;
  configurationRevision?: string;
  backend?: CanonicalBackendDocuments;
  providers?: unknown | null;
  system?: unknown | null;
  mcp?: unknown | null;
  agents?: unknown | null;
  ssh?: unknown | null;
  remote?: unknown | null;
  stt?: unknown | null;
  memory?: unknown | null;
  modelFailover?: unknown | null;
  defaultWorkdir?: unknown | null;
};

export type SettingsSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string };

type NativeBatchResponse = {
  nativeRevision: string;
  ssh?: unknown;
  stt?: unknown;
  warning?: string | null;
};

type CanonicalBatchResponse = NativeBatchResponse & {
  configurationRevision: string;
  backend: CanonicalBackendDocuments;
};

export type PersistSettingsResult = {
  uiPreferencesRevision?: string;
  skills?: AppSettings["skills"];
  backendConfigurationVersion?: string;
  configurationRevision?: string;
  mcp?: AppSettings["mcp"];
  agents?: AppSettings["agents"];
  nativeConfigurationRevision?: string;
  warning?: string;
  customProviders?: AppSettings["customProviders"];
  ssh?: AppSettings["ssh"];
  stt?: AppSettings["stt"];
  conflict?: "ssh_settings_changed";
  /**
   * K-brain rejected the provider payload itself (validation, 4xx). Re-sending it can only fail
   * again, so it is not retried; customProviders then holds K-brain's current records so the UI
   * drops the rejected edit instead of showing data that was never saved.
   */
  providerError?: SettingsStorageError;
};

function isPermanentProviderValidationError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return status === 400 || status === 409 || status === 413 || status === 422;
}

async function invokeSettingsCommand<T>(
  code: SettingsStorageErrorCode,
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new SettingsStorageError(code, error);
  }
}

function writeLocalUiSettings(
  settings: Pick<
    AppSettings,
    | "skills"
    | "chatRuntimeControls"
    | "customSettings"
    | "updates"
    | "selectedModel"
    | "theme"
    | "locale"
    | "closeWindowBehavior"
    | "retryErrorSettings"
  >,
) {
  const payload = {
    skills: settings.skills,
    chatRuntimeControls: settings.chatRuntimeControls,
    customSettings: settings.customSettings,
    updates: settings.updates,
    selectedModel: settings.selectedModel,
    theme: settings.theme,
    locale: settings.locale,
    closeWindowBehavior: settings.closeWindowBehavior,
    retryErrorSettings: settings.retryErrorSettings,
  };
  localStorage.setItem(settingsStorageKey(LOCAL_UI_SETTINGS_STORAGE_KEY), JSON.stringify(payload));
}

function stableStringify(value: unknown) {
  return JSON.stringify(value);
}

function hasChanged(prev: unknown, next: unknown) {
  return stableStringify(prev) !== stableStringify(next);
}

function normalizeDefaultWorkdir(input: unknown): string {
  return typeof input === "string" ? input.trim() : "";
}

function settingsObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function browserUiSettings(input: unknown) {
  const raw = settingsObject(input);
  const system = settingsObject(raw.system);
  const custom = settingsObject(raw.customSettings);
  const dock = settingsObject(custom.rightDock);
  const controls = settingsObject(raw.chatRuntimeControls);
  // Project dock state is an open-ended bag; runtime prompts and proxy settings
  // also belong to the backend, not this browser's presentation preferences.
  const normalized = normalizeSettings({
    customProviders: [],
    system: {
      executionMode: system.executionMode,
      workdir: system.workdir,
      defaultTimeZone: system.defaultTimeZone,
    } as AppSettings["system"],
    customSettings: {
      chatSidebar: custom.chatSidebar,
      sidebarShortcuts: custom.sidebarShortcuts,
      chatTranscript: custom.chatTranscript,
      rightDock: { width: dock.width },
      composerContextDisplay: custom.composerContextDisplay,
      interfaceFontFamily: custom.interfaceFontFamily ?? custom.fontFamily,
      chatFontFamily: custom.chatFontFamily,
      codeFontFamily: custom.codeFontFamily,
      fontScale: custom.fontScale,
      promptClarifyEnabled: custom.promptClarifyEnabled,
    } as AppSettings["customSettings"],
    chatRuntimeControls: {
      thinkingEnabled: controls.thinkingEnabled,
      reasoning: controls.reasoning,
      nativeWebSearchEnabled: controls.nativeWebSearchEnabled,
      planModeEnabled: controls.planModeEnabled,
    } as ChatRuntimeControls,
    theme: raw.theme as Theme,
    locale: (raw.locale ?? getDefaultSettings().locale) as Locale,
  });
  return {
    system: {
      executionMode: normalized.system.executionMode,
      workdir: normalized.system.workdir,
      defaultTimeZone: normalized.system.defaultTimeZone,
    },
    customSettings: normalized.customSettings,
    chatRuntimeControls: normalized.chatRuntimeControls,
    theme: normalized.theme,
    locale: normalized.locale,
  };
}

function readBrowserPersistedSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(settingsStorageKey(BROWSER_SETTINGS_STORAGE_KEY));
    const readObject = (value: string | null) => {
      try {
        return settingsObject(value ? JSON.parse(value) : undefined);
      } catch {
        return {};
      }
    };
    const browser = readObject(raw);
    const safe = browserUiSettings(browser);
    localStorage.setItem(settingsStorageKey(BROWSER_SETTINGS_STORAGE_KEY), JSON.stringify(safe));
    return normalizeSettings({
      ...safe,
      system: { ...getDefaultSettings().system, ...safe.system },
      customProviders: [],
    });
  } catch (error) {
    throw new SettingsStorageError("load_failed", error);
  }
}

function writeBrowserPersistedSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(
      settingsStorageKey(BROWSER_SETTINGS_STORAGE_KEY),
      JSON.stringify(browserUiSettings(settings)),
    );
  } catch (error) {
    throw new SettingsStorageError("save_failed", error);
  }
}

function systemForNativePersistence(system: AppSettings["system"]): AppSettings["system"] {
  if (isKBrainBackendEnabled()) {
    const workspaceResourceSettings = Object.fromEntries(
      Object.entries(system.workspaceResourceSettings).map(([path, entry]) => {
        const {
          projectPrompt: _projectPrompt,
          projectPromptStrategy: _projectPromptStrategy,
          ...nativeEntry
        } = entry;
        return [path, nativeEntry];
      }),
    ) as AppSettings["system"]["workspaceResourceSettings"];
    return { ...system, workspaceResourceSettings };
  }
  return system;
}

function promptTemplatesFromKBrain(snapshot: KBrainPromptSnapshot): AppSettings["agents"] {
  return (Array.isArray(snapshot.globalTemplates) ? snapshot.globalTemplates : []).map(
    (template) => ({
      id: template.id,
      name: template.name,
      description: template.description ?? "",
      prompt: template.prompt,
      enabled: template.enabled === true,
    }),
  );
}

async function loadKBrainPromptSettings(
  workdirs: string[],
): Promise<{ agents: AppSettings["agents"]; projects: Record<string, unknown> }> {
  const client = createKBrainPromptClient();
  const global = await client.get();
  const projects: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(global.projectPrompts ?? {})) {
    const project = value ?? {};
    const path =
      typeof project.workdir === "string" && project.workdir.trim() ? project.workdir : key;
    projects[workspaceProjectPathKey(path)] = {
      projectPrompt: typeof project.prompt === "string" ? project.prompt : "",
      projectPromptStrategy: project.strategy === "replace" ? "replace" : "append",
    };
  }
  for (const workdir of [...new Set(workdirs.map((value) => value.trim()).filter(Boolean))]) {
    const key = workspaceProjectPathKey(workdir);
    if (projects[key]) continue;
    try {
      const snapshot = await client.get(workdir);
      projects[key] = {
        projectPrompt: snapshot.projectPrompt,
        projectPromptStrategy: snapshot.projectPromptStrategy,
      };
    } catch (error) {
      if ((error as { status?: number }).status !== 400) throw error;
    }
  }
  return { agents: promptTemplatesFromKBrain(global), projects };
}

function applyKBrainProjectPrompts(
  system: AppSettings["system"],
  projects: Record<string, unknown>,
): AppSettings["system"] {
  const workspaceResourceSettings: AppSettings["system"]["workspaceResourceSettings"] =
    Object.fromEntries(
      Object.entries(system.workspaceResourceSettings).map(([path, entry]) => [
        workspaceProjectPathKey(path),
        { ...entry, projectPrompt: "", projectPromptStrategy: "append" as const },
      ]),
    );
  for (const [path, value] of Object.entries(projects)) {
    const workdir = workspaceProjectPathKey(path);
    const current = workspaceResourceSettings[workdir];
    const prompt =
      value && typeof value === "object"
        ? (value as { projectPrompt?: unknown; projectPromptStrategy?: unknown })
        : {};
    workspaceResourceSettings[workdir] = {
      ...current,
      projectPrompt: typeof prompt.projectPrompt === "string" ? prompt.projectPrompt : "",
      projectPromptStrategy: prompt.projectPromptStrategy === "replace" ? "replace" : "append",
    } as AppSettings["system"]["workspaceResourceSettings"][string];
  }
  return { ...system, workspaceResourceSettings };
}

function applyDefaultWorkdirToSystem(system: unknown, defaultWorkdir: string): unknown {
  if (!defaultWorkdir) return system;
  const obj =
    system && typeof system === "object" && !Array.isArray(system)
      ? { ...(system as Record<string, unknown>) }
      : {};
  const workdir = typeof obj.workdir === "string" ? obj.workdir.trim() : "";
  if (!workdir) {
    obj.workdir = defaultWorkdir;
  }
  return obj;
}

export type PersistedSettingsLoadResult = {
  settings: AppSettings;
  defaultWorkdir: string;
};

// 旧配置的中转模型没有输入模态，K-brain 会把它们当成纯文本、丢弃 Read 到的图片。
// 每次加载时对账补齐；失败只记日志，绝不影响设置加载。
async function backfillKBrainInputModalities(
  document: KBrainSettingsDocument,
  providers: CustomProvider[],
) {
  const selectedModel =
    document.defaultProvider && document.defaultModel
      ? { customProviderId: document.defaultProvider, model: document.defaultModel }
      : undefined;
  const update = kBrainSettingsUpdateForMissingInputModalities(providers, selectedModel);
  if (!update) return { document, providers };
  try {
    const saved = await saveKBrainProviderSettings(update);
    return { document: saved, providers: appProvidersFromKBrain(saved) };
  } catch (error) {
    console.warn("ZeroAgent engine catalog metadata backfill failed", error);
    return { document, providers };
  }
}

async function loadCurrentKBrainProviders() {
  // Provider settings come only from the active canonical backend.
  const document = await loadKBrainProviderSettings();
  const providers = appProvidersFromKBrain(document);
  return document.configurationProtocol === KBRAIN_CONFIGURATION_PROTOCOL
    ? { document, providers }
    : backfillKBrainInputModalities(document, providers);
}

async function loadNativeConfiguration(
  canReconcileCatalog: () => boolean,
): Promise<PersistedSettingsResponse> {
  const load = () =>
    invokeSettingsCommand<PersistedSettingsResponse>("load_failed", "settings_load_all");
  const snapshot = await load();
  if (!snapshot.backend || !snapshot.configurationRevision)
    throw new SettingsStorageError("load_failed", "Configuration snapshot returned no version");
  const update = kBrainSettingsUpdateForCatalogRefresh(snapshot.backend.settings);
  if (!update || !canReconcileCatalog()) return snapshot;
  try {
    await invoke("settings_save_canonical_batch", {
      update: { expectedRevision: snapshot.configurationRevision, settings: update },
    });
  } catch (error) {
    console.warn("ZeroAgent engine catalog metadata backfill failed", error);
  }
  // A backfill, conflict or failed write can advance the version. Read data and version together.
  return load();
}

function projectPromptsFromSnapshot(snapshot: KBrainPromptSnapshot): Record<string, unknown> {
  const projects: Record<string, unknown> = {};
  for (const project of Object.values(snapshot.projectPrompts ?? {})) {
    if (typeof project?.workdir !== "string" || !project.workdir.trim()) continue;
    projects[workspaceProjectPathKey(project.workdir)] = {
      projectPrompt: project.prompt ?? "",
      projectPromptStrategy: project.strategy === "replace" ? "replace" : "append",
    };
  }
  return projects;
}

export async function loadPersistedSettingsWithDefaults(
  canReconcileCatalog: () => boolean = () => true,
): Promise<PersistedSettingsLoadResult> {
  const defaults = getDefaultSettings();
  const persisted = isKBrainBrowserHost()
    ? undefined
    : await loadNativeConfiguration(canReconcileCatalog);
  let kbrainSettings: Awaited<ReturnType<typeof loadCurrentKBrainProviders>>;
  try {
    kbrainSettings = persisted?.backend
      ? {
          document: persisted.backend.settings,
          providers: appProvidersFromKBrain(persisted.backend.settings),
        }
      : await loadCurrentKBrainProviders();
  } catch (error) {
    throw new SettingsStorageError("load_failed", error);
  }
  const customProviders = kbrainSettings.providers;
  const selectedModel =
    kbrainSettings.document.defaultProvider && kbrainSettings.document.defaultModel
      ? {
          customProviderId: kbrainSettings.document.defaultProvider,
          model: kbrainSettings.document.defaultModel,
        }
      : undefined;
  if (isKBrainBrowserHost()) {
    const local = readBrowserPersistedSettings();
    if (kbrainSettings.document.configurationProtocol === KBRAIN_CONFIGURATION_PROTOCOL) {
      try {
        const client = createKBrainClient();
        let snapshot = await client.getConfiguration();
        if (!snapshot.configurationVersion)
          throw new Error("Configuration response returned no read version");
        const backfill = kBrainSettingsUpdateForCatalogRefresh(snapshot.settings);
        if (backfill && canReconcileCatalog()) {
          try {
            await client.updateConfiguration({ settings: backfill }, snapshot.configurationVersion);
          } catch (error) {
            console.warn("ZeroAgent engine catalog metadata backfill failed", error);
          }
          snapshot = await client.getConfiguration();
          if (!snapshot.configurationVersion)
            throw new Error("Configuration response returned no read version");
        }
        httpSaveLineage = undefined;
        return { settings: browserSettingsFromConfiguration(local, snapshot), defaultWorkdir: "" };
      } catch (error) {
        throw new SettingsStorageError("load_failed", error);
      }
    }
    let promptSettings: { agents: AppSettings["agents"]; projects: Record<string, unknown> };
    try {
      promptSettings = await loadKBrainPromptSettings([local.system.workdir]);
    } catch (error) {
      throw new SettingsStorageError("load_failed", error);
    }
    const browserSettings = normalizeSettings({
      ...local,
      customProviders,
      selectedModel,
      agents: promptSettings.agents,
      system: applyKBrainProjectPrompts(local.system, promptSettings.projects),
    });
    return {
      settings: await loadKBrainMcpSettings(browserSettings),
      defaultWorkdir: "",
    };
  }
  const localUi = { ...defaults, ...persisted?.uiPreferences };
  if (!persisted?.backend || !persisted.configurationRevision) {
    throw new SettingsStorageError("load_failed", "Configuration snapshot returned no version");
  }
  nativeSaveLineage = undefined;
  uiSaveLineage = undefined;
  const defaultWorkdir = normalizeDefaultWorkdir(persisted?.defaultWorkdir);

  let settings = normalizeSettings({
    uiPreferencesRevision: persisted.uiRevision,
    configurationRevision: persisted.configurationRevision,
    nativeConfigurationRevision: persisted.nativeRevision,
    system: applyDefaultWorkdirToSystem(
      persisted?.system ?? defaults.system,
      defaultWorkdir,
    ) as AppSettings["system"],
    // K-brain is authoritative for provider records on both browser and native hosts.
    customProviders,
    mcp: fromKBrainMcpSettings(persisted.backend.mcp, defaults.mcp),
    agents: promptTemplatesFromKBrain(persisted.backend.prompts),
    ssh: (persisted?.ssh ?? defaults.ssh) as AppSettings["ssh"],
    remote: (persisted?.remote ?? defaults.remote) as AppSettings["remote"],
    stt: {
      ...((persisted?.stt ?? defaults.stt) as AppSettings["stt"]),
      nativeConfigurationRevision: persisted.nativeRevision,
    },
    memory: (persisted?.memory ?? defaults.memory) as AppSettings["memory"],
    skills: persisted.backend.skills?.settings ?? localUi.skills,
    chatRuntimeControls: localUi.chatRuntimeControls,
    customSettings: localUi.customSettings,
    updates: localUi.updates,
    selectedModel,
    modelFailover: (persisted?.modelFailover ??
      defaults.modelFailover) as AppSettings["modelFailover"],
    retryErrorSettings: localUi.retryErrorSettings as AppSettings["retryErrorSettings"],
    theme: localUi.theme as AppSettings["theme"],
    locale: localUi.locale as AppSettings["locale"],
    closeWindowBehavior: localUi.closeWindowBehavior as AppSettings["closeWindowBehavior"],
  });

  settings = normalizeSettings({
    ...settings,
    system: applyKBrainProjectPrompts(
      settings.system,
      projectPromptsFromSnapshot(persisted.backend.prompts),
    ),
  });
  return {
    settings: {
      ...settings,
      system: resolveWorkspaceProjects(settings.system, defaultWorkdir),
    },
    defaultWorkdir,
  };
}

export async function loadPersistedSettings(): Promise<AppSettings> {
  return (await loadPersistedSettingsWithDefaults()).settings;
}

let failedProviderSave: AppSettings | undefined;
let uiSaveLineage:
  | {
      connection: string;
      readRevision: string;
      committedRevision: string;
      intendedFingerprint: string;
    }
  | undefined;

function nativeUiPreferences(settings: {
  skills: unknown;
  chatRuntimeControls: unknown;
  customSettings: unknown;
  updates: unknown;
  retryErrorSettings: unknown;
  theme: unknown;
  locale: unknown;
  closeWindowBehavior: unknown;
}): Record<string, unknown> {
  return {
    skills: settings.skills,
    chatRuntimeControls: settings.chatRuntimeControls,
    customSettings: settings.customSettings,
    updates: settings.updates,
    retryErrorSettings: settings.retryErrorSettings,
    theme: settings.theme,
    locale: settings.locale,
    closeWindowBehavior: settings.closeWindowBehavior,
  };
}

async function persistNativeUiPreferences(
  prev: AppSettings,
  next: AppSettings,
  connection: string,
): Promise<string | undefined> {
  const before = nativeUiPreferences(prev);
  const after = nativeUiPreferences(next);
  const changes = Object.fromEntries(
    Object.entries(after).filter(([key, value]) => hasChanged(before[key], value)),
  );
  if (!Object.keys(changes).length) return undefined;
  const readRevision = prev.uiPreferencesRevision ?? "";
  const lineage = uiSaveLineage;
  const expectedRevision =
    lineage?.connection === connection &&
    (readRevision === lineage.readRevision || readRevision === lineage.committedRevision) &&
    JSON.stringify(before) === lineage.intendedFingerprint
      ? lineage.committedRevision
      : readRevision;
  try {
    const saved = await invoke<{ uiRevision: string }>("settings_save_ui_preferences", {
      update: { expectedRevision, changes },
    });
    if (!saved?.uiRevision) throw new Error("UI preference save returned no version");
    uiSaveLineage = {
      connection,
      readRevision,
      committedRevision: saved.uiRevision,
      intendedFingerprint: JSON.stringify(after),
    };
    return saved.uiRevision;
  } catch (error) {
    uiSaveLineage = undefined;
    throw new SettingsStorageError(
      /ZEROAGENT_UI_PREFERENCES_(CHANGED|VERSION_REQUIRED)/.test(String(error))
        ? "native_settings_changed"
        : "save_failed",
      error,
    );
  }
}
let nativeSaveLineage:
  | {
      connection: string;
      readRevision: string;
      committedRevision: string;
      intendedFingerprint: string;
    }
  | undefined;

function sttForNativePersistence(stt: AppSettings["stt"]) {
  const {
    nativeConfigurationRevision: _revision,
    configurationRevision: _configurationRevision,
    ...data
  } = stt;
  return data;
}

function nativePreferencesFingerprint(settings: AppSettings): string {
  return JSON.stringify([
    systemForNativePersistence(settings.system),
    settings.ssh,
    settings.remote,
    settings.memory,
    settings.modelFailover,
    sttForNativePersistence(settings.stt),
    settings.customProviders,
    settings.selectedModel ?? null,
    settings.mcp,
    settings.agents,
    settings.skills,
    Object.entries(settings.system.workspaceResourceSettings).map(([path]) => [
      path,
      projectPromptFields(settings, path),
    ]),
  ]);
}

function nativeSaveRevision(prev: AppSettings, connection: string): string {
  const readRevision = prev.configurationRevision ?? "";
  const lineage = nativeSaveLineage;
  // Only a queued edit whose entire baseline equals our last successful intended
  // snapshot can inherit that write's version. A separate stale editor keeps its own.
  if (
    lineage?.connection === connection &&
    (readRevision === lineage.readRevision || readRevision === lineage.committedRevision) &&
    nativePreferencesFingerprint(prev) === lineage.intendedFingerprint
  ) {
    return lineage.committedRevision;
  }
  return readRevision;
}
let providerSaveConnection: string | undefined;
let rejectedProviderSave:
  | { fingerprint: string; baseline: AppSettings; authoritative?: AppSettings["customProviders"] }
  | undefined;

function providerSaveFingerprint(settings: AppSettings): string {
  return JSON.stringify([settings.customProviders, settings.selectedModel ?? null]);
}

function projectPromptFields(settings: AppSettings, path: string) {
  const entry = settings.system.workspaceResourceSettings[path];
  return {
    prompt: entry?.projectPrompt ?? "",
    strategy: entry?.projectPromptStrategy ?? "append",
  } as const;
}

async function loadKBrainMcpSettings(settings: AppSettings): Promise<AppSettings> {
  if (!isKBrainBackendEnabled()) return settings;
  try {
    const client = createKBrainClient();
    const document = await client.getMcpSettings();
    return normalizeSettings({
      ...settings,
      mcp: fromKBrainMcpSettings(document, settings.mcp),
    });
  } catch (error) {
    throw new SettingsStorageError("load_failed", error);
  }
}

async function persistKBrainPrompts(prev: AppSettings, next: AppSettings): Promise<void> {
  const client = createKBrainPromptClient();
  if (hasChanged(prev.agents, next.agents)) {
    await client.replaceTemplates(next.agents);
  }
  const paths = new Set([
    ...Object.keys(prev.system.workspaceResourceSettings),
    ...Object.keys(next.system.workspaceResourceSettings),
  ]);
  for (const path of paths) {
    const before = projectPromptFields(prev, path);
    const after = projectPromptFields(next, path);
    if (!hasChanged(before, after)) continue;
    await client.setProject(path, after.prompt, after.strategy);
  }
}

// Runs a synchronous local write as a task so it shares error reporting with backend saves:
// a throwing localStorage write must not escape while backend requests are still in flight.
function settleLocalWrite(write: () => void): Promise<void> {
  try {
    write();
    return Promise.resolve();
  } catch (error) {
    return Promise.reject(
      error instanceof SettingsStorageError
        ? error
        : new SettingsStorageError("save_failed", error),
    );
  }
}

// Waits for every domain to finish so one failure cannot cancel another domain's write, then
// reports the first failure in submission order (backend diagnostics are pushed first).
async function settleTasks(tasks: Promise<unknown>[]): Promise<void> {
  const outcomes = await Promise.allSettled(tasks);
  const failed = outcomes.find((outcome) => outcome.status === "rejected");
  if (failed) throw failed.reason;
}

async function persistCanonicalSettings(
  prev: AppSettings,
  next: AppSettings,
): Promise<PersistSettingsResult> {
  const connection = getConfiguredKBrainConnection();
  const connectionKey = JSON.stringify([connection?.baseUrl, connection?.token]);
  const changes: Record<string, unknown> = {};
  if (
    hasChanged(systemForNativePersistence(prev.system), systemForNativePersistence(next.system))
  ) {
    changes.system = systemForNativePersistence(next.system);
  }
  if (hasChanged(prev.ssh, next.ssh)) {
    const update = buildGatewaySettingsSyncUpdatePayload(prev, next, {
      includeProviderApiKeyUpdates: true,
    });
    changes.sshPatch = update.sshPatch ?? {};
    if (update.sshSecretUpdates) changes.sshSecretUpdates = update.sshSecretUpdates;
  }
  if (hasChanged(prev.remote, next.remote)) changes.remote = next.remote;
  if (hasChanged(prev.memory, next.memory)) changes.memory = next.memory;
  if (hasChanged(prev.modelFailover, next.modelFailover))
    changes.modelFailover = next.modelFailover;
  if (hasChanged(sttForNativePersistence(prev.stt), sttForNativePersistence(next.stt))) {
    changes.stt = sttForNativePersistence(next.stt);
  }

  const update: Record<string, unknown> = {
    expectedRevision: nativeSaveRevision(prev, connectionKey),
    nativeChanges: changes,
  };
  if (
    hasChanged(prev.customProviders, next.customProviders) ||
    hasChanged(prev.selectedModel, next.selectedModel)
  )
    update.settings = kBrainSettingsUpdateFromAppSettings(prev, next);
  if (hasChanged(prev.skills, next.skills)) update.skills = next.skills;
  if (hasChanged(prev.mcp, next.mcp)) update.mcp = toKBrainMcpSettings(next.mcp);
  if (hasChanged(prev.agents, next.agents)) update.templates = next.agents;
  const paths = new Set([
    ...Object.keys(prev.system.workspaceResourceSettings),
    ...Object.keys(next.system.workspaceResourceSettings),
  ]);
  const projects = [...paths]
    .filter((path) => hasChanged(projectPromptFields(prev, path), projectPromptFields(next, path)))
    .map((workdir) => ({ workdir, ...projectPromptFields(next, workdir) }));
  if (projects.length) update.projects = projects;
  const result: PersistSettingsResult = {};
  const changed = Object.keys(changes).length > 0 || Object.keys(update).length > 2;
  const tasks: Promise<unknown>[] = [];
  if (changed)
    tasks.push(
      invoke<CanonicalBatchResponse>("settings_save_canonical_batch", { update })
        .then((response) => {
          if (!response?.configurationRevision || !response.nativeRevision || !response.backend)
            throw new Error("Configuration save returned no versioned snapshot");
          result.configurationRevision = response.configurationRevision;
          result.nativeConfigurationRevision = response.nativeRevision;
          result.customProviders = appProvidersFromKBrain(response.backend.settings);
          if (update.mcp)
            result.mcp = normalizeSettings({
              mcp: fromKBrainMcpSettings(response.backend.mcp, next.mcp),
            }).mcp;
          if (update.templates) result.agents = promptTemplatesFromKBrain(response.backend.prompts);
          if (update.skills) result.skills = response.backend.skills?.settings ?? next.skills;
          if (response.warning) result.warning = response.warning;
          if (response.ssh)
            result.ssh = normalizeSettings({ ssh: response.ssh as AppSettings["ssh"] }).ssh;
          result.stt = normalizeSettings({
            stt: {
              ...((response.stt ?? next.stt) as AppSettings["stt"]),
              nativeConfigurationRevision: response.nativeRevision,
              configurationRevision: response.configurationRevision,
            },
          }).stt;
          nativeSaveLineage = {
            connection: connectionKey,
            readRevision: prev.configurationRevision ?? "",
            committedRevision: response.configurationRevision,
            intendedFingerprint: nativePreferencesFingerprint(next),
          };
        })
        .catch((error) => {
          nativeSaveLineage = undefined;
          const conflict = /ZEROAGENT_(?:NATIVE_)?CONFIGURATION_(CHANGED|VERSION_REQUIRED)/.test(
            String(error),
          );
          throw new SettingsStorageError(
            conflict ? "native_settings_changed" : "save_failed",
            error,
          );
        }),
    );
  // Presentation preferences still save if the canonical configuration is rejected.
  tasks.push(
    persistNativeUiPreferences(prev, next, connectionKey).then((revision) => {
      if (revision) result.uiPreferencesRevision = revision;
    }),
  );
  tasks.push(settleLocalWrite(() => writeLocalUiSettings(next)));
  await settleTasks(tasks);
  return result;
}

function browserSettingsFromConfiguration(
  local: AppSettings,
  snapshot: KBrainBackendConfiguration,
): AppSettings {
  const document = snapshot.settings;
  return normalizeSettings({
    ...local,
    backendConfigurationVersion: snapshot.configurationVersion,
    skills: snapshot.skills?.settings ?? local.skills,
    customProviders: appProvidersFromKBrain(document),
    selectedModel:
      document.defaultProvider && document.defaultModel
        ? { customProviderId: document.defaultProvider, model: document.defaultModel }
        : undefined,
    mcp: fromKBrainMcpSettings(snapshot.mcp, local.mcp),
    agents: promptTemplatesFromKBrain(snapshot.prompts),
    system: applyKBrainProjectPrompts(local.system, projectPromptsFromSnapshot(snapshot.prompts)),
  });
}

let httpSaveLineage:
  | {
      connection: string;
      readRevision: string;
      committedRevision: string;
      intendedFingerprint: string;
    }
  | undefined;
function backendConfigurationFingerprint(settings: AppSettings) {
  return JSON.stringify([
    settings.customProviders,
    settings.selectedModel,
    settings.mcp,
    settings.agents,
    Object.keys(settings.system.workspaceResourceSettings).map((path) => [
      path,
      projectPromptFields(settings, path),
    ]),
  ]);
}
async function persistHttpConfiguration(
  prev: AppSettings,
  next: AppSettings,
): Promise<PersistSettingsResult> {
  const connection = getConfiguredKBrainConnection();
  const connectionKey = JSON.stringify([connection?.baseUrl, connection?.token]);
  const lineage = httpSaveLineage;
  let expected = prev.backendConfigurationVersion ?? "";
  if (
    lineage?.connection === connectionKey &&
    (expected === lineage.readRevision || expected === lineage.committedRevision) &&
    backendConfigurationFingerprint(prev) === lineage.intendedFingerprint
  )
    expected = lineage.committedRevision;
  const update: Record<string, unknown> = {};
  if (
    hasChanged(prev.customProviders, next.customProviders) ||
    hasChanged(prev.selectedModel, next.selectedModel)
  )
    update.settings = kBrainSettingsUpdateFromAppSettings(prev, next);
  if (hasChanged(prev.mcp, next.mcp)) update.mcp = toKBrainMcpSettings(next.mcp);
  if (hasChanged(prev.agents, next.agents)) update.templates = next.agents;
  const paths = new Set([
    ...Object.keys(prev.system.workspaceResourceSettings),
    ...Object.keys(next.system.workspaceResourceSettings),
  ]);
  const projects = [...paths]
    .filter((path) => hasChanged(projectPromptFields(prev, path), projectPromptFields(next, path)))
    .map((workdir) => ({ workdir, ...projectPromptFields(next, workdir) }));
  if (projects.length) update.projects = projects;
  const result: PersistSettingsResult = {};
  const tasks: Promise<unknown>[] = [];
  if (Object.keys(update).length)
    tasks.push(
      createKBrainClient()
        .updateConfiguration(update, expected)
        .then((snapshot) => {
          if (!snapshot.configurationVersion)
            throw new Error("Configuration save returned no read version");
          const saved = browserSettingsFromConfiguration(next, snapshot);
          result.backendConfigurationVersion = snapshot.configurationVersion;
          result.customProviders = saved.customProviders;
          if (update.mcp) result.mcp = saved.mcp;
          if (update.templates) result.agents = saved.agents;
          httpSaveLineage = {
            connection: connectionKey,
            readRevision: prev.backendConfigurationVersion ?? "",
            committedRevision: snapshot.configurationVersion,
            intendedFingerprint: backendConfigurationFingerprint(next),
          };
        })
        .catch((error) => {
          httpSaveLineage = undefined;
          throw new SettingsStorageError(
            [412, 428].includes((error as { status?: number }).status ?? 0)
              ? "native_settings_changed"
              : "save_failed",
            error,
          );
        }),
    );
  tasks.push(settleLocalWrite(() => writeBrowserPersistedSettings(next)));
  await settleTasks(tasks);
  return result;
}

export async function persistSettings(
  prev: AppSettings,
  next: AppSettings,
): Promise<PersistSettingsResult> {
  if (!isKBrainBrowserHost()) return persistCanonicalSettings(prev, next);
  if (prev.backendConfigurationVersion || next.backendConfigurationVersion)
    return persistHttpConfiguration(prev, next);
  const tasks: Promise<unknown>[] = [];
  const result: PersistSettingsResult = {};
  const connection = getConfiguredKBrainConnection();
  const connectionKey = JSON.stringify([connection?.baseUrl, connection?.token]);
  if (providerSaveConnection !== connectionKey) {
    providerSaveConnection = connectionKey;
    failedProviderSave = undefined;
    rejectedProviderSave = undefined;
  }
  const recovery = rejectedProviderSave;
  if (recovery && providerSaveFingerprint(next) === recovery.fingerprint) {
    // Queued unrelated saves still contain the rejected optimistic provider snapshot.
    const restore = async () => {
      recovery.authoritative ??= appProvidersFromKBrain(await loadKBrainProviderSettings());
      result.customProviders = recovery.authoritative;
    };
    tasks.push(
      restore().catch((error) => {
        throw new SettingsStorageError("save_failed", error);
      }),
    );
  }
  const staleRejectedProviders = recovery && providerSaveFingerprint(next) === recovery.fingerprint;
  const providersChanged =
    hasChanged(prev.customProviders, next.customProviders) ||
    hasChanged(prev.selectedModel ?? null, next.selectedModel ?? null);
  // Provider records go to K-brain. A failure there must not stop the other domains from
  // saving: it used to throw before the local UI write, and failedProviderSave then made every
  // later save retry and throw again, so theme/locale/font changes were never persisted.
  if (!staleRejectedProviders && (providersChanged || failedProviderSave)) {
    const baseline =
      failedProviderSave ??
      (recovery
        ? {
            ...recovery.baseline,
            customProviders: recovery.authoritative ?? recovery.baseline.customProviders,
          }
        : prev);
    tasks.push(
      saveKBrainProviderSettings(kBrainSettingsUpdateFromAppSettings(baseline, next)).then(
        (document) => {
          result.customProviders = appProvidersFromKBrain(document);
          failedProviderSave = undefined;
          rejectedProviderSave = undefined;
        },
        async (error) => {
          if (!isPermanentProviderValidationError(error)) {
            // Transient (offline, 5xx): keep the baseline so the next save retries this change.
            failedProviderSave = baseline;
            throw new SettingsStorageError("save_failed", error);
          }
          // A rejected payload used to become the retry baseline, so every later save, even a
          // theme switch, re-sent it and reported the same failure until the app restarted.
          failedProviderSave = undefined;
          result.providerError = new SettingsStorageError("save_failed", error);
          const rejected = {
            fingerprint: providerSaveFingerprint(next),
            baseline,
            authoritative: undefined as AppSettings["customProviders"] | undefined,
          };
          rejectedProviderSave = rejected;
          try {
            result.customProviders = appProvidersFromKBrain(await loadKBrainProviderSettings());
            rejected.authoritative = result.customProviders;
          } catch {
            // The next queued save retries the read, never the rejected payload.
          }
        },
      ),
    );
  }

  if (
    isKBrainBackendEnabled() &&
    (hasChanged(prev.agents, next.agents) ||
      hasChanged(prev.system.workspaceResourceSettings, next.system.workspaceResourceSettings))
  ) {
    tasks.push(
      persistKBrainPrompts(prev, next).catch((error) => {
        throw new SettingsStorageError("save_failed", error);
      }),
    );
  }

  if (isKBrainBackendEnabled() && hasChanged(prev.mcp, next.mcp)) {
    tasks.push(
      createKBrainClient()
        .updateMcpSettings(toKBrainMcpSettings(next.mcp))
        .catch((error) => {
          throw new SettingsStorageError("save_failed", error);
        }),
    );
  }

  if (isKBrainBrowserHost()) {
    // The calendar time zone is owned by K-brain and saved by its own picker as a preference
    // ("" follows the system). Pushing a resolved zone from here would freeze "automatic".
    tasks.push(settleLocalWrite(() => writeBrowserPersistedSettings(next)));
    await settleTasks(tasks);
    return result;
  }

  return result;
}

export async function publishGatewaySettingsSync(settings: AppSettings): Promise<void> {
  if (isKBrainBrowserHost()) return;
  await invokeSettingsCommand("gateway_sync_failed", "gateway_publish_settings_sync", {
    payload: buildGatewaySettingsSyncPayload(settings),
  });
}
