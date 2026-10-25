import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// Models only the IPC boundary. Native validation, locking, private fields and
// compensation are exercised by the Rust integration tests.
export function nativeConfigurationFixture(getConnection, native = {}) {
  let sequence = 0;
  const uiProfiles = new Map();
  function uiState() {
    const connection = getConnection();
    const key = connection.storageId ?? connection.baseUrl;
    if (!uiProfiles.has(key)) uiProfiles.set(key, {sequence:0,preferences:{}});
    return {key,...uiProfiles.get(key)};
  }
  const uiVersion = (state) => `za-ui-v1-${state.key}-${state.sequence}`;
  async function request(path, body) {
    const connection = getConnection();
    const response = await fetch(connection.baseUrl + path, {
      method: body === undefined ? "GET" : "PUT",
      headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`backend save diagnostic (${response.status})`);
    return response.json();
  }
  async function load() {
    const backend = {
      settings: await request("/v1/settings"),
      mcp: await request("/v1/mcp"),
      prompts: await request("/v1/prompts"),
    };
    const digest = createHash("sha256").update(JSON.stringify([sequence, backend, native])).digest("hex");
    const ui = uiState();
    return { ...structuredClone(native), uiRevision: uiVersion(ui), uiPreferences: structuredClone(ui.preferences), nativeRevision: `za-native-v1-fixture-${sequence}`,
      configurationRevision: `za-config-v1-fixture-${digest}`, backend };
  }
  return async (command, args) => {
    if (command === "settings_load_all") return load();
    if (command === "settings_save_ui_preferences") {
      const ui = uiState();
      if (args.update.expectedRevision !== uiVersion(ui)) throw new Error("ZEROAGENT_UI_PREFERENCES_CHANGED");
      Object.assign(ui.preferences, structuredClone(args.update.changes));
      ui.sequence += 1;
      uiProfiles.set(ui.key,ui);
      return {uiRevision: uiVersion(ui), uiPreferences: structuredClone(ui.preferences)};
    }
    assert.equal(command, "settings_save_canonical_batch");
    const before = await load();
    const update = args.update;
    if (update.expectedRevision !== before.configurationRevision) throw new Error("ZEROAGENT_CONFIGURATION_CHANGED");
    sequence += 1;
    if (update.settings) await request("/v1/settings", update.settings);
    if (update.mcp) await request("/v1/mcp", update.mcp);
    if (update.templates) await request("/v1/prompts/templates", {
      templates: update.templates, baseRevision: (await request("/v1/prompts")).revision,
    });
    for (const project of update.projects ?? []) await request("/v1/prompts/project", project);
    Object.assign(native, structuredClone(update.nativeChanges ?? {}));
    return load();
  };
}
