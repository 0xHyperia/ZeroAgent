import { redactSettingsForWebStorage } from "@liveagent/ui/lib/settings/sync";
import { type AppSettings, getDefaultSettings, normalizeSettings } from "@/lib/settings";
import { desktopStorageKey, gatewayOrigin } from "./desktopRemoteHost";

const WEB_SETTINGS_STORAGE_KEY = "liveagent.gateway.webui.settings.v1";
const RELAY_DISPLAY_PREFERENCES_KEY = "zeroagent.gateway.webui.relay-display.v1";

type RelayDisplayPreferences = Partial<Pick<AppSettings, "locale" | "theme">>;

export function loadRelayDisplayPreferences(): RelayDisplayPreferences {
  try {
    const raw = window.localStorage.getItem(desktopStorageKey(RELAY_DISPLAY_PREFERENCES_KEY));
    if (!raw) return {};
    const { locale, theme } = JSON.parse(raw) ?? {};
    return {
      ...(locale === "en-US" || locale === "zh-CN" ? { locale } : {}),
      ...(theme === "system" || theme === "light" || theme === "dark" ? { theme } : {}),
    };
  } catch {
    return {};
  }
}

export function persistRelayDisplayPreferences(preferences: RelayDisplayPreferences) {
  if (Object.keys(preferences).length === 0) return;
  window.localStorage.setItem(
    desktopStorageKey(RELAY_DISPLAY_PREFERENCES_KEY),
    JSON.stringify({ ...loadRelayDisplayPreferences(), ...preferences }),
  );
}

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
