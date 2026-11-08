import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const { LazyCollapse } = env.loadModule("@liveagent/ui/components/chat/LazyCollapse.tsx");

function renderCollapse(root, { open, retainWhileClosed = false }) {
  act(() => {
    root.render(
      React.createElement(
        LazyCollapse,
        { open, retainWhileClosed },
        () => React.createElement("div", { "data-heavy-body": "" }, "Heavy body"),
      ),
    );
  });
}

async function waitForCollapseAnimation() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
}

test("collapse animates in both directions and releases settled content afterward", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderCollapse(root, { open: false, retainWhileClosed: true });
  assert.equal(container.querySelector("[data-heavy-body]"), null);

  renderCollapse(root, { open: true });
  assert.match(container.firstElementChild.className, /\bh-min\b/);
  assert.notEqual(container.querySelector("[data-lazy-collapse-content]"), null);
  assert.notEqual(container.querySelector("[data-heavy-body]"), null);

  renderCollapse(root, { open: false });
  assert.match(container.firstElementChild.className, /pointer-events-none/);
  assert.notEqual(container.querySelector("[data-heavy-body]"), null);

  await waitForCollapseAnimation();
  assert.equal(container.querySelector("[data-heavy-body]"), null);

  act(() => root.unmount());
});

test("active content remains mounted after the close animation", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderCollapse(root, { open: true, retainWhileClosed: true });
  renderCollapse(root, { open: false, retainWhileClosed: true });
  await waitForCollapseAnimation();
  assert.notEqual(container.querySelector("[data-heavy-body]"), null);
  assert.equal(container.firstElementChild.hasAttribute("inert"), true);

  renderCollapse(root, { open: false, retainWhileClosed: false });
  await waitForCollapseAnimation();
  assert.equal(container.querySelector("[data-heavy-body]"), null);

  act(() => root.unmount());
});

test("closing an active disclosure returns its inner keyboard focus to the controlling button", () => {
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const triggerRef = React.createRef();
  const draw = (open) => act(() => root.render(React.createElement(React.Fragment, null,
    React.createElement("button", { ref: triggerRef, "aria-controls": "activity-details" }, "Tool output"),
    React.createElement(LazyCollapse, { id: "activity-details", triggerRef, open, retainWhileClosed: true },
      () => React.createElement("button", { id: "activity-action" }, "Open source")),
    React.createElement("button", { id: "outside-activity" }, "Continue"),
  )));
  draw(true);
  const source = document.getElementById("activity-action");
  source.focus();
  assert.equal(document.activeElement, source);
  draw(false);
  assert.equal(document.activeElement, triggerRef.current);
  assert.equal(document.getElementById("activity-details").hasAttribute("inert"), true);
  assert.equal(document.getElementById("activity-action"), source);

  draw(true);
  const outside = document.getElementById("outside-activity");
  outside.focus();
  draw(false);
  assert.equal(document.activeElement, outside);
  act(() => root.unmount());
  container.remove();
});

test.after(() => env.cleanup());
