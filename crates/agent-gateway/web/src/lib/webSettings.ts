import { redactSettingsForWebStorage } from "@liveagent/ui/lib/settings/sync";
import { type AppSettings, getDefaultSettings, normalizeSettings } from "@/lib/settings";
import { desktopStorageKey, gatewayOrigin } from "./desktopRemoteHost";

const WEB_SETTINGS_STORAGE_KEY = "liveagent.gateway.webui.settings.v1";

export type WebSettingsSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; message: string };

export function getWebDefaultSettings(token: string): AppSettings {
  const defaults = getDefaultSettings();
  return normalizeSettings({
    ...defaults,
    system: {
      ...defaults.system,
      executionMode: "tools",
      workdir: "",
    },
    remote: {
      ...defaults.remote,
      enabled: token.trim() !== "",
      gatewayUrl: gatewayOrigin(),
    },
  });
}

export function loadWebSettings(token: string): AppSettings {
  const fallback = getWebDefaultSettings(token);
  try {
    const raw = window.localStorage.getItem(desktopStorageKey(WEB_SETTINGS_STORAGE_KEY));
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as Partial<AppSettings> | null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    const normalized = redactSettingsForWebStorage(
      normalizeSettings({
        ...fallback,
        ...parsed,
        system: parsed.system ?? { ...fallback.system, commandSafetyMode: "always" },
        kbrainWebSearch: undefined,
        remote: {
          ...fallback.remote,
          ...(parsed.remote ?? {}),
          gatewayUrl: fallback.remote.gatewayUrl,
          token: "",
          enabled: token.trim() !== "" || parsed.remote?.enabled === true,
        },
      }),
    );
    persistWebSettings(normalized);
    return normalized;
  } catch {
    return fallback;
  }
}

export function persistWebSettings(settings: AppSettings): void {
  const redacted = redactSettingsForWebStorage({ ...settings, kbrainWebSearch: undefined });
  window.localStorage.setItem(
    desktopStorageKey(WEB_SETTINGS_STORAGE_KEY),
    JSON.stringify({
      ...redacted,
      // Keep the active login token in memory; it is supplied by the current
      // Gateway session again when loading these preferences.
      remote: { ...redacted.remote, token: "" },
    }),
  );
}
