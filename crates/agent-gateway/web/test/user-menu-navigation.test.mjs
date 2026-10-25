import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../../../agent-gui/test/helpers/dom-test-env.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function mount(t, mobile = false) {
  const calls = [];
  const env = await createDomTestEnv({
    rootDir: fileURLToPath(new URL("..", import.meta.url)),
    mocks: {
      "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
      "@/lib/mobileRuntime": { isEmbeddedMobileRuntime: () => mobile },
      "@/lib/mobileAppUpdate": { requestMobileAppUpdateCheck: () => calls.push("update") },
    },
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = env.createRoot(container);
  const { UserMenu } = env.loadModule("src/app/UserMenu.tsx");
  function Harness() {
    const [open, onOpenChange] = env.React.useState(false);
    return env.React.createElement(UserMenu, {
      open, onOpenChange, userMenuLabel: "Zero", userAvatarLabel: "Z",
      email: "private@example.test", balance: 123, todayTokens: 321, online: true,
      onRefreshAccount: async () => { calls.push("refresh"); },
      onDismissNavigation: () => calls.push("dismiss"),
      onOpenAccount: () => calls.push("account"),
      onOpenSettings: () => calls.push("settings"),
      onLogout: () => calls.push("logout"),
    });
  }
  t.after(async () => { await env.act(async () => root.unmount()); env.cleanup(); });
  await env.act(async () => root.render(env.React.createElement(Harness)));
  const open = async () => env.act(async () => {
    container.querySelector('[title="account.userMenu"]').click();
    await tick();
  });
  const select = async (label) => env.act(async () => {
    const item = [...document.querySelectorAll('[role="menuitem"]')]
      .find((element) => element.textContent === label);
    assert.ok(item, label);
    item.click();
    await tick();
  });
  return { calls, open, select };
}

test("web footer menu routes account and settings separately without account details", async (t) => {
  const menu = await mount(t);
  await menu.open();
  assert.doesNotMatch(document.body.textContent, /private@example|123|321|account.balance|account.status/);
  await menu.select("settings.navAccount");
  assert.deepEqual(menu.calls, ["refresh", "dismiss", "account"]);
  assert.equal(document.querySelector('[role="menu"]'), null);
  await menu.open();
  await menu.select("tooltip.settings");
  assert.deepEqual(menu.calls.slice(-3), ["refresh", "dismiss", "settings"]);
  await menu.open();
  assert.doesNotMatch(document.body.textContent, /app.checkForUpdates/);
  await menu.select("common.logout");
  assert.equal(menu.calls.at(-1), "logout");
});

test("embedded mobile keeps update and account actions reachable from the same menu", async (t) => {
  const menu = await mount(t, true);
  await menu.open();
  await menu.select("app.checkForUpdates");
  assert.deepEqual(menu.calls, ["refresh", "dismiss", "update"]);
  await menu.open();
  await menu.select("settings.navAccount");
  assert.deepEqual(menu.calls.slice(-3), ["refresh", "dismiss", "account"]);
});
