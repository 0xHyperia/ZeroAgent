import {
  applyGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncPayload,
  buildGatewaySettingsSyncUpdatePayload,
  type GatewaySettingsUpdateReceipt,
} from "./sync";
import type { AppSettings } from "./types";

function fingerprint(settings: AppSettings): string {
  const {
    settingsSyncProtocol: _protocol,
    configurationRevision: _revision,
    uiPreferencesRevision: _uiRevision,
    ...data
  } = buildGatewaySettingsSyncPayload(settings);
  return JSON.stringify(data, (_key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
}

/** Version inheritance belongs to this save queue, never to the latest GET/push. */
export class GatewaySettingsSaveLineage {
  private previous?: {
    target: string;
    readRevision?: string;
    readUiRevision?: string;
    revision: string;
    uiRevision: string;
    fingerprint: string;
  };

  clear() {
    this.previous = undefined;
  }

  prepare(prev: AppSettings, next: AppSettings, target: string) {
    const update = buildGatewaySettingsSyncUpdatePayload(prev, next, {
      includeProviderApiKeyUpdates: true,
    });
    const saved = this.previous;
    if (
      Object.keys(update).length &&
      prev.settingsSyncProtocol &&
      saved?.target === target &&
      [saved.readRevision, saved.revision].includes(prev.configurationRevision) &&
      [saved.readUiRevision, saved.uiRevision].includes(prev.uiPreferencesRevision) &&
      fingerprint(prev) === saved.fingerprint
    ) {
      update.configurationRevision = saved.revision;
      update.uiPreferencesRevision = saved.uiRevision;
    }
    return update;
  }

  accept(
    prev: AppSettings,
    next: AppSettings,
    target: string,
    receipt: GatewaySettingsUpdateReceipt | void,
  ) {
    this.clear();
    const snapshot = receipt?.snapshot;
    if (
      !snapshot?.configurationRevision ||
      !snapshot.uiPreferencesRevision ||
      snapshot.settingsSyncProtocol !== "zeroagent.settings-sync.v1"
    )
      return;
    const actual = applyGatewaySettingsSyncPayload(next, snapshot);
    if (fingerprint(actual) !== fingerprint(next)) return;
    this.previous = {
      target,
      readRevision: prev.configurationRevision,
      readUiRevision: prev.uiPreferencesRevision,
      revision: snapshot.configurationRevision,
      uiRevision: snapshot.uiPreferencesRevision,
      fingerprint: fingerprint(next),
    };
  }
}
