import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("first run can be deferred per account and reopened without provisioning credentials", async (t) => {
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
      "@liveagent/ui/components/IconSet": { Check: () => null, Circle: () => null, Loader2: () => null },
    },
  });
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: window.localStorage });
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  t.after(async () => {
    await env.act(async () => root.unmount());
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else delete globalThis.localStorage;
    env.cleanup();
  });

  const { FirstRunOnboarding } = env.loadModule("src/components/onboarding/FirstRunOnboarding.tsx");
  let closes = 0;
  let opensModels = 0;
  let picks = 0;
  const props = {
    userId: 31,
    autoOpen: true,
    requested: false,
    hasModel: false,
    projectName: "",
    onClose: () => closes++,
    onConfigureModels: () => opensModels++,
    onChooseProject: async () => {
      picks++;
      if (picks === 1) throw new Error("fixture error details");
    },
  };
  const render = async (changes = {}) => {
    const next = { ...props, ...changes };
    await env.act(async () => root.render(env.React.createElement(FirstRunOnboarding, {
      ...next,
      key: next.userId,
    })));
  };
  const dialog = () => document.querySelector('[data-testid="desktop-setup-guide"]');
  async function click(label) {
    const button = [...dialog().querySelectorAll("button")].find((item) =>
      item.textContent.includes(`settings.setupGuide.${label}`),
    );
    assert.ok(button, label);
    await env.act(async () => button.click());
  }

  await render();
  assert.ok(dialog());
  await click("skip");
  assert.equal(closes, 1);
  assert.equal(dialog(), null);
  assert.equal(localStorage.getItem("zeroagent.onboarding.v1.31"), "complete");
  await render({ userId: 32 });
  assert.ok(dialog());
  await render();
  assert.equal(dialog(), null);
  await render({ requested: true });
  await click("chooseProject");
  assert.equal(dialog().querySelector('[role="alert"]')?.textContent, "settings.setupGuide.projectError");
  assert.equal(dialog().textContent.includes("fixture error details"), false);
  await click("chooseProject");
  assert.equal(dialog().querySelector('[role="alert"]'), null);
  await click("configureModels");
  assert.equal(opensModels, 1);
  assert.equal(picks, 2);
  assert.deepEqual(Object.keys(localStorage), ["zeroagent.onboarding.v1.31"]);
});
