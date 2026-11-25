import { invoke } from "@liveagent/app/shims/tauriCore";
import type {
  SttConnectionTestResponse,
  SttSecretField,
  SttSettingsService,
} from "@liveagent/ui/lib/stt/types";
import { type AppSettings, normalizeSttSettings } from "../../lib/settings";

export const desktopSttSettingsService: SttSettingsService = {
  runtime: "desktop",
  secretRevealMode: "value",
  revealSecret(provider, field: SttSecretField) {
    return invoke<string>("settings_reveal_stt_secret", { provider, field });
  },
  async get() {
    const response = await invoke<{
      stt?: AppSettings["stt"];
      nativeRevision: string;
      configurationRevision: string;
    }>("settings_load_all");
    return normalizeSttSettings({
      ...response.stt,
      nativeConfigurationRevision: response.nativeRevision,
      configurationRevision: response.configurationRevision,
    });
  },
  async update(settings) {
    const response = await invoke<{
      stt: AppSettings["stt"];
      nativeRevision: string;
      configurationRevision: string;
    }>("settings_save_canonical_batch", {
      update: {
        expectedRevision: settings.configurationRevision ?? "",
        nativeChanges: { stt: settings },
      },
    }).catch((error: unknown) => {
      if (/ZEROAGENT_(?:NATIVE_)?CONFIGURATION_(CHANGED|VERSION_REQUIRED)/.test(String(error))) {
        throw new Error("配置已更新，请重新加载设置后再保存。");
      }
      throw error;
    });
    return normalizeSttSettings({
      ...response.stt,
      nativeConfigurationRevision: response.nativeRevision,
      configurationRevision: response.configurationRevision,
    });
  },
  async test(provider) {
    return invoke<SttConnectionTestResponse>("settings_test_stt", {
      provider,
    });
  },
};
