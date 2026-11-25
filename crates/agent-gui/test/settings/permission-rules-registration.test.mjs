import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import { completeSharedTranslations } from "../helpers/translation-namespaces.mjs";

const settings = {
  stt: { provider: "tencent_cloud" },
  system: {
    workspaceProjects: [],
    hiddenWorkspaceProjectPaths: [],
    archivedWorkspaceProjectPaths: [],
  },
  customProviders: [],
  customSettings: { fontScale: { settings: 1 } },
};

const rulesBackend = {
  isKbrain: true,
  getConnection: () => ({ baseUrl: "http://fixture", token: "fixture-token" }),
  getCapabilities: async () => ({ permission_rules: 1 }),
  getSettings: async () => ({}),
  updateSettings: async () => ({}),
  listPermissionRules: async () => ({ rules: [] }),
  addPermissionRule: async (rule) => ({ id: "fixture-rule", ...rule }),
  deletePermissionRule: async () => {},
};

async function withSettings(run) {
  const stubSections = [
    "AgentsSection",
    "AIApprovalSection",
    "CalendarSection",
    "CronSection",
    "DevicePluginsSection",
    "HooksSection",
    "memory/MemoryPanel",
    "RemoteSection",
    "ResourceHubSection",
    "SshSection",
    "SttSection",
    "SystemSettingsForm",
    "SystemToolsSection",
    "UsageStatsSection",
    "WebSearchSection",
  ];
  const env = await createDomTestEnv({
    mocks: {
      ...Object.fromEntries(
        stubSections.map((path) => [
          fileURLToPath(new URL(`../../../agent-ui/src/pages/settings/${path}.tsx`, import.meta.url)),
          { [path.split("/").at(-1)]: () => null },
        ]),
      ),
      "@liveagent/adapters/settingsExtension": {
        createSettingsExtension: () => ({
          surface: "desktop",
          iconClassName: "",
          excludedSearchAnchors: [],
          slots: {},
          sections: [],
        }),
      },
    },
  });
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const { SettingsPage } = env.loadModule("@liveagent/ui/pages/settings/SettingsPage.tsx");
  const sttSettingsService = {};
  try {
    await run({
      act: env.act,
      render(props) {
        return env.act(async () => {
          root.render(
            env.React.createElement(SettingsPage, {
              settings,
              setSettings: () => {},
              saveState: { status: "saved" },
              onBack: () => {},
              sttSettingsService,
              ...props,
            }),
          );
        });
      },
      find: (testId) => host.querySelector(`[data-testid="${testId}"]`),
      rule: () => host.querySelector("[data-permission-rule]")?.getAttribute("data-permission-rule"),
    });
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

test("the local desktop settings entry isolates rules and pending changes across accounts", async () => {
  const makeReply = (rule) => ({
    rules: [{ id: rule, rule, effect: "deny", scope: "user" }],
  });
  let reply = Promise.resolve(makeReply("Read(old-project/**)"));
  const add = Promise.withResolvers();
  const written = [];
  let listRequests = 0;
  const kbrain = {
    ...rulesBackend,
    listPermissionRules() {
      listRequests += 1;
      return reply;
    },
    addPermissionRule(rule) {
      written.push(rule);
      return add.promise;
    },
  };
  await withSettings(async ({ act, render, find, rule }) => {
    await render({ settingsHost: { kbrain, permissionRulesScope: "account-a" } });
    const entry = find("settings-nav-permissions");
    assert.ok(entry);
    assert.equal(find("permission-rules-settings"), null);
    await act(async () => entry.click());
    assert.equal(entry.getAttribute("aria-current"), "page");
    assert.ok(find("permission-rules-settings"));
    assert.equal(rule(), "Read(old-project/**)");

    const input = find("permission-rules-settings").querySelector("[data-permission-rule-input]");
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setValue.call(input, "Edit(old-project/**)");
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    assert.deepEqual(written, [{ rule: "Edit(old-project/**)", effect: "deny", scope: "user" }]);

    const next = Promise.withResolvers();
    reply = next.promise;
    await render({ settingsHost: { kbrain, permissionRulesScope: "account-b" } });
    assert.equal(rule(), undefined);
    await act(async () => next.resolve(makeReply("Edit(new-project/**)")));
    assert.equal(rule(), "Edit(new-project/**)");
    await act(async () => add.resolve({ id: "pending", ...written[0] }));
    assert.equal(listRequests, 2);
    assert.equal(rule(), "Edit(new-project/**)");

    await render({ settingsHost: { kbrain }, runtimeKind: "device_agent" });
    assert.equal(find("settings-nav-permissions"), null);
    assert.equal(find("permission-rules-settings"), null);
  });
});

test("a permission rules deep link requires a local scope and all three adapter methods", async () => {
  const deniedHosts = [
    { settingsHost: { kbrain: rulesBackend } },
    {
      runtimeKind: "web_chat",
      settingsHost: { kbrain: rulesBackend, permissionRulesScope: "account-a" },
    },
    ...["listPermissionRules", "addPermissionRule", "deletePermissionRule"].map((method) => ({
      settingsHost: {
        kbrain: { ...rulesBackend, [method]: undefined },
        permissionRulesScope: "account-a",
      },
    })),
  ];
  await withSettings(async ({ render, find }) => {
    for (const deniedHost of deniedHosts) {
      await render({ ...deniedHost, initialSection: "permissions" });
      assert.equal(find("settings-nav-permissions"), null);
      assert.equal(find("permission-rules-settings"), null);
    }
  });
});

test("both locales carry the same permission rules keys", () => {
  const { "zh-CN": zh, "en-US": en } = completeSharedTranslations(createTsModuleLoader());
  const keys = (table) =>
    Object.keys(table)
      .filter((key) => key === "settings.navPermissions" || key.startsWith("settings.permissions."))
      .sort();
  assert.deepEqual(keys(zh), keys(en));
  assert.ok(keys(zh).length >= 20);
  assert.equal(zh["settings.navPermissions"], "权限");
});
