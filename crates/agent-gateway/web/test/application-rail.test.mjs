import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("rail selection is host-owned; hints keep the selected and unselected glyphs intact", async (t) => {
  const env = await createWebDomTestEnv();
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  t.after(async () => {
    await env.act(async () => root.unmount());
    container.remove();
    env.cleanup();
  });
  const { ApplicationRail } = env.loadModule("../../agent-ui/src/application/ApplicationRail.tsx");
  const h = env.React.createElement;
  const selected = [];
  const items = ["对话", "资料库"].map((label) => ({
    id: label, label,
    icon: h("span", { "data-glyph": "outline", "aria-hidden": true }),
    activeIcon: h("span", { "data-glyph": "solid", "aria-hidden": true }),
    onSelect: () => selected.push(label),
  }));
  const render = async (activeId, previewId) => {
    await env.act(async () => {
      root.render(h(ApplicationRail, { brand: "ZeroAgent", items, activeId, previewId }));
      await tick();
    });
  };
  await render("对话");
  const chat = container.querySelector('[aria-label="对话"]');
  const library = container.querySelector('[aria-label="资料库"]');
  assert.equal(container.querySelectorAll('[aria-current="page"]').length, 1);
  assert.equal(chat.querySelector("[data-glyph]").dataset.glyph, "solid");
  assert.equal(library.querySelector("[data-glyph]").dataset.glyph, "outline");
  assert.equal(document.querySelector('[role="tooltip"]'), null, "selected at rest has no hint");

  for (const control of [library, chat]) {
    await env.act(async () => {
      control.dispatchEvent(new window.MouseEvent("mouseenter", { relatedTarget: document.body }));
      control.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 20, clientY: 20 }));
      await new Promise((resolve) => setTimeout(resolve, 420));
    });
    const hint = document.getElementById(control.getAttribute("aria-describedby"));
    assert.ok(hint);
    assert.equal(hint.textContent, control.getAttribute("aria-label"));
    assert.equal(control.getAttribute("title"), null);
    assert.equal(chat.querySelector("[data-glyph]").dataset.glyph, "solid");
    assert.equal(library.querySelector("[data-glyph]").dataset.glyph, "outline");
    assert.deepEqual(selected, [], "hover must not navigate or select a glyph");
    await env.act(async () => {
      control.dispatchEvent(new window.MouseEvent("mouseleave", { relatedTarget: document.body, clientX: 500, clientY: 500 }));
      document.body.dispatchEvent(new window.MouseEvent("mousemove", { bubbles: true, clientX: 500, clientY: 500 }));
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    assert.equal(control.getAttribute("aria-describedby"), null);
  }
  await env.act(async () => { library.click(); await tick(); });
  assert.deepEqual(selected, ["资料库"]);
  assert.equal(chat.getAttribute("aria-current"), "page", "an action alone cannot change host-owned selection");
  await render("资料库");
  assert.equal(chat.getAttribute("aria-current"), null);
  assert.equal(library.getAttribute("aria-current"), "page");
  assert.equal(chat.querySelector("[data-glyph]").dataset.glyph, "outline");
  assert.equal(library.querySelector("[data-glyph]").dataset.glyph, "solid");

  await env.act(async () => {
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    chat.focus(); await tick();
  });
  assert.equal(chat.getAttribute("aria-current"), null, "keyboard focus must not select");
  assert.deepEqual(selected, ["资料库"]);
  await render("资料库", "对话");
  assert.equal(container.querySelector('[aria-label="对话"]'),chat,'preview does not remount the trigger');
  assert.equal(chat.getAttribute('aria-expanded'),'true');assert.equal(library.getAttribute('aria-current'),'page');
  assert.deepEqual(selected,["资料库"],'preview alone cannot select a page');
});

test("rail keeps destinations without a solid variant compatible", async (t) => {
  const env = await createWebDomTestEnv();
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  t.after(async () => { await env.act(async () => root.unmount()); container.remove(); env.cleanup(); });
  const { ApplicationRail } = env.loadModule("../../agent-ui/src/application/ApplicationRail.tsx");
  await env.act(async () => {
    root.render(env.React.createElement(ApplicationRail, {
      brand: "ZeroAgent", activeId: "device",
      items: [{ id: "device", label: "设备", icon: "原图标", onSelect() {} }],
    }));
  });
  assert.equal(container.querySelector('[aria-current="page"]').textContent, "原图标");
});
