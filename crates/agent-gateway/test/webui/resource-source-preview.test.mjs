import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

async function setup(t, syntax = async (language) => language) {
  const models = [],
    editors = [];
  const monaco = {
    languageForPath: (name) => (name.endsWith(".py") ? "python" : "plaintext"),
    Range: class {
      constructor(...args) {
        this.values = args;
      }
    },
    editor: {
      ScrollType: { Immediate: 0 },
      setTheme() {},
      setModelLanguage(model, language) {
        model.language = language;
      },
      createModel(text, language) {
        const model = {
          text,
          language,
          disposed: false,
          isDisposed() {
            return this.disposed;
          },
          getLineCount: () => text.split("\n").length,
          getLineMaxColumn: () => 80,
          dispose() {
            this.disposed = true;
          },
        };
        models.push(model);
        return model;
      },
      create(node, options) {
        const pre = document.createElement("pre");
        pre.textContent = options.model.text;
        node.appendChild(pre);
        const instance = {
          getModel: () => options.model,
          options,
          top: 1,
          left: 0,
          disposed: false,
          updates: [],
          updateOptions(next) {
            this.options = { ...this.options, ...next };
            this.updates.push(next);
          },
          revealLineNearTop(line) {
            this.top = line;
          },
          setScrollLeft(left) {
            this.left = left;
          },
          getScrollLeft() {
            return this.left;
          },
          getVisibleRanges() {
            return [{ startLineNumber: this.top }];
          },
          createDecorationsCollection() {},
          dispose() {
            this.disposed = true;
            pre.remove();
          },
        };
        editors.push(instance);
        return instance;
      },
    },
  };
  const env = await createWebDomTestEnv({
    resolveDynamicImports: true,
    mocks: {
      "../../lib/monacoNls": {
        preparePreferredMonacoNlsLocale: async () => {},
        lockMonacoNlsLocale() {},
      },
      "../../lib/monacoWorkers": {},
      "../../lib/sourceSyntax": { prepareSourceSyntax: syntax, refreshSourceSyntax() {} },
      "../../lib/monacoEditor": monaco,
      "../IconSet": new Proxy({}, { get: () => () => null }),
    },
  });
  const host = document.body.appendChild(document.createElement("div")),
    root = env.createRoot(host),
    h = env.React.createElement;
  const { default: Source } = env.loadModule(
    "@liveagent/ui/components/resource-preview/ResourceSourcePreview.tsx",
  );
  const { PreviewIdentityContext } = env.loadModule(
    "@liveagent/ui/components/resource-preview/PreviewChrome.tsx",
  );
  const { ResourcePreviewReadingSession, PreviewReadingTarget } = env.loadModule(
    "@liveagent/ui/components/resource-preview/readingSession.tsx",
  );
  const flush = async () => {
    for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const render = async ({
    visible = true,
    scope = "owner-a",
    identity = "file:1",
    text = "print(1)\n# 中文",
    name = "sample.py",
    paths,
    guard = () => {},
    range,
  } = {}) => {
    await env.act(async () => {
      root.render(
        h(
          ResourcePreviewReadingSession,
          { scope },
          h(
            PreviewReadingTarget,
            { key: identity, identity },
            visible
              ? h(
                  PreviewIdentityContext.Provider,
                  {
                    value: { name, mime: "text/plain", sourcePaths: paths, sourceRange: range },
                  },
                  h(Source, { text, assertCurrent: guard }),
                )
              : null,
          ),
        ),
      );
      await flush();
    });
  };
  const menu = async () =>
    env.act(async () => {
      host
        .querySelector('[aria-label="原文选项"]')
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
        );
      await flush();
    });
  const click = async (text) =>
    env.act(async () => {
      const item = [...document.querySelectorAll('[role^="menuitem"]')].find(
        (n) => n.textContent.trim() === text,
      );
      assert.ok(item, text);
      item.click();
      await flush();
    });
  t.after(async () => {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  });
  return { env, host, models, editors, render, menu, click };
}

test("source presentation keeps originals exact; wrapping updates the same read-only model", async (t) => {
  const app = await setup(t),
    text = '{"spacing":  2, "markup": "<script>never execute</script>"}\r\n';
  const guard = () => {};
  await app.render({ text, guard });
  assert.equal(app.models[0].text, text);
  assert.equal(app.models[0].language, "python");
  assert.equal(app.editors[0].options.readOnly, true);
  assert.equal(app.editors[0].options.domReadOnly, true);
  assert.equal(app.host.querySelector("script"), null);
  await app.menu();
  assert.equal(
    document.querySelector('[role="menuitemcheckbox"]').getAttribute("aria-checked"),
    "false",
  );
  await app.click("自动换行");
  assert.equal(app.editors.length, 1);
  assert.equal(app.editors[0].options.wordWrap, "on");
  assert.equal(app.models[0].disposed, false);
});

test("source view returns to its own line, horizontal offset and wrap while account scope retires snapshots", async (t) => {
  const app = await setup(t),
    guard = () => {},
    text = Array.from({ length: 900 }, (_, i) => String(i)).join("\n");
  await app.render({ text, guard });
  await app.menu();
  await app.click("自动换行");
  app.editors[0].top = 420;
  app.editors[0].left = 120;
  await app.render({ visible: false, text, guard });
  assert.equal(app.models[0].disposed, true);
  assert.equal(app.editors[0].disposed, true);
  await app.render({ text, guard });
  assert.equal(app.editors[1].top, 420);
  assert.equal(app.editors[1].left, 120);
  assert.equal(app.editors[1].options.wordWrap, "on");
  await app.render({ scope: "owner-b", identity: "file:1:b", text, guard });
  assert.equal(app.editors.at(-1).top, 1);
  assert.equal(app.editors.at(-1).left, 0);
  assert.equal(app.editors.at(-1).options.wordWrap, "off");
});

test("source copy advertises only actual paths, copies exact text and respects a retired account guard", async (t) => {
  const app = await setup(t),
    copied = [],
    text = "original\n  unchanged";
  let allowed = true;
  const guard = () => {
    if (!allowed) throw new Error("retired");
  };
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text) => copied.push(text) },
  });
  await app.render({ text, guard });
  await app.menu();
  assert.doesNotMatch(
    document.querySelector('[role="menu"]').textContent,
    /复制路径|复制相对路径/,
  );
  await app.click("复制文件内容");
  assert.deepEqual(copied, [text]);
  assert.match(app.host.querySelector('[role="status"]').textContent, /已复制/);
  await app.render({
    text,
    guard,
    paths: { path: "D:/work/sample.py", relativePath: "sample.py" },
  });
  await app.menu();
  await app.click("复制相对路径");
  assert.equal(copied.at(-1), "sample.py");
  await app.menu();
  allowed = false;
  await app.click("复制文件内容");
  assert.equal(copied.length, 2);
  assert.match(app.host.querySelector('[role="status"]').textContent, /重试/);
});

test("source zoom captures the reader's read-only keyboard input and releases listeners on close", async (t) => {
  const app = await setup(t),
    guard = () => {};
  await app.render({ guard });
  const node = app.host.querySelector(".za-source-editor"),
    input = node.appendChild(document.createElement("textarea"));
  input.readOnly = true;
  const key = new KeyboardEvent("keydown", {
    key: "+",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  await app.env.act(async () => input.dispatchEvent(key));
  assert.equal(key.defaultPrevented, true);
  assert.ok(app.editors[0].options.fontSize > 13);
  const wheel = new Event("wheel", { bubbles: true, cancelable: true });
  Object.defineProperties(wheel, {
    ctrlKey: { value: true },
    deltaY: { value: 500 },
    deltaMode: { value: 0 },
  });
  await app.env.act(async () => node.dispatchEvent(wheel));
  assert.equal(wheel.defaultPrevented, true);
  assert.ok(app.editors[0].options.fontSize >= 9.75);
  await app.render({ visible: false, guard });
  const after = new KeyboardEvent("keydown", {
    key: "+",
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  node.dispatchEvent(after);
  assert.equal(after.defaultPrevented, false);
});

test("source line links are clamped and invalid coordinates cannot crash the viewer", async (t) => {
  const app = await setup(t),
    guard = () => {};
  await app.render({ text: "one\ntwo", guard, range: { fromLine: 999999, toLine: 9999999 } });
  assert.equal(app.editors.at(-1).top, 2);
  await app.render({
    identity: "next",
    text: "one\ntwo",
    guard,
    range: { fromLine: NaN, toLine: Infinity },
  });
  assert.equal(app.editors.at(-1).top, 1);
});

test("late syntax imports cannot recolor a newer resource or a closed model", async (t) => {
  const pending = [];
  const app = await setup(
      t,
      (language) => new Promise((resolve) => pending.push({ language, resolve })),
    ),
    guard = () => {};
  await app.render({ guard, name: "first.py" });
  const first = app.models[0];
  await app.render({ guard, name: "next.rs", identity: "next" });
  const next = app.models.at(-1);
  await app.env.act(async () => {
    pending[0].resolve("python");
    await new Promise(setImmediate);
  });
  assert.equal(first.disposed, true);
  assert.equal(next.language, "plaintext");
  await app.env.act(async () => {
    pending.at(-1).resolve("rust");
    await new Promise(setImmediate);
  });
  assert.equal(next.language, "rust");
  await app.render({ guard, name: "last.vue", identity: "last" });
  const last = app.models.at(-1);
  await app.render({ visible: false, guard });
  await app.env.act(async () => {
    pending.at(-1).resolve("vue");
    await new Promise(setImmediate);
  });
  assert.equal(last.disposed, true);
  assert.equal(last.language, "plaintext");
});

test("failed grammar loads keep the same readable model and retry in place", async (t) => {
  let attempts = 0;
  const app = await setup(t, async (language) => {
      if (attempts++ === 0) throw new Error("offline grammar");
      return language;
    }),
    guard = () => {};
  await app.render({ guard });
  assert.match(app.host.textContent, /高亮加载失败/);
  assert.equal(app.models[0].text, "print(1)\n# 中文");
  await app.env.act(async () => {
    app.host.querySelector(".za-source-syntax-error button").click();
    for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  });
  assert.equal(app.models.length, 1);
  assert.equal(app.models[0].language, "python");
  assert.equal(app.host.querySelector(".za-source-syntax-error"), null);
});
