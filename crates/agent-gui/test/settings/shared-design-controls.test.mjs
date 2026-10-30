import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("shared segments support roving focus, skip disabled choices and do not submit their form", async () => {
  let env;
  env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/ui/tooltip-button": { TooltipButton: ({title, variant, ...props}) => env.React.createElement("button", props) },
  } });
  const { SegmentedControl } = env.loadModule("@liveagent/ui/components/ui/segmented-control.tsx");
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host);
  const changes = []; let submits = 0;
  function Harness() {
    const [value, setValue] = env.React.useState("chat");
    return env.React.createElement("form", { onSubmit: e => { e.preventDefault(); submits++; } }, env.React.createElement(SegmentedControl, {
      value, label: "Mode", options: [{ value: "chat", label: "Chat" }, { value: "unavailable", label: "Unavailable", disabled: true }, { value: "work", label: "Work" }],
      onChange: next => { changes.push(next); setValue(next); },
    }));
  }
  try {
    await env.act(async () => root.render(env.React.createElement(Harness)));
    const chat = host.querySelector('[data-segment="chat"]'), work = host.querySelector('[data-segment="work"]');
    await env.act(async () => { chat.focus(); chat.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    assert.equal(document.activeElement, work); assert.equal(work.tabIndex, 0); assert.equal(chat.tabIndex, -1);
    assert.deepEqual(changes, ["work"]);
    await env.act(async () => work.click()); assert.deepEqual(changes, ["work"], "active segment is idempotent");
    await env.act(async () => work.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    assert.equal(document.activeElement, chat); assert.deepEqual(changes, ["work", "chat"]); assert.equal(submits, 0);
  } finally { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); }
});
