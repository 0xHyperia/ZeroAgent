import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const enumSpec = (key, values) => ({ key, label: key, type: "string", required: false, enum: values });
const target = (parameters) => ({
  id: "t", name: "Provider · model", enabled: true, parameters,
  capabilities: { operations: ["generate"], maxCount: 1, maxInputs: 0 },
});
const openai = target([enumSpec("size", ["1024x1024", "1536x1024", "1024x1536"]), enumSpec("quality", ["low", "high"])]);
const google = target([enumSpec("aspectRatio", ["1:1", "16:9", "9:16"]), enumSpec("imageSize", ["1K", "2K"])]);

async function picker(props) {
  const env = await createDomTestEnv({ mocks: { "../../components/IconSet": new Proxy({}, { get: () => () => null }) } });
  const { ImageSizePicker, describeImageSize } = env.loadModule("@liveagent/ui/features/image-studio/ImageSizePicker");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const changes = [];
  let currentProps = props;
  const render = async (next = {}) => {
    currentProps = { ...currentProps, ...next };
    await env.act(async () => root.render(env.React.createElement(ImageSizePicker, { onFramingChange: () => {}, ...currentProps, onChange: (v) => changes.push(v) })));
  };
  await render();
  return { env, host, changes, render, describeImageSize, trigger: host.querySelector("button") };
}

test("footer summary follows the declared size contract", async () => {
  const { describeImageSize } = await picker({ target: openai, values: {} });
  assert.equal(describeImageSize(openai, { size: "1536x1024" }), "当前尺寸 1536x1024");
  assert.equal(describeImageSize(google, { aspectRatio: "16:9", imageSize: "2K" }), "比例 16:9 · 分辨率 2K");
  assert.equal(describeImageSize(target([]), {}), "尺寸由模型自动决定");
});

test("models without size parameters frame through the prompt with a generic ratio/resolution choice", async () => {
  const framings = [];
  const { env, trigger, describeImageSize } = await picker({
    target: target([]), values: {}, framing: { ratio: "16:9" }, onFramingChange: (f) => framings.push(f),
  });
  assert.equal(trigger.disabled, false);
  assert.match(trigger.textContent, /16:9/);
  await env.act(async () => trigger.click());
  const ratios = document.querySelector('[role="radiogroup"][aria-label="画面比例"]');
  assert.deepEqual([...ratios.querySelectorAll("label")].map((l) => l.textContent.trim()),
    ["自动", "21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"]);
  const tiers = document.querySelector('[role="radiogroup"][aria-label="分辨率"]');
  await env.act(async () => [...tiers.querySelectorAll("label")].find((l) => l.textContent.trim() === "2K").querySelector("input").click());
  assert.deepEqual(framings.at(-1), { ratio: "16:9", tier: "2K" });
  assert.match(document.body.textContent, /附加在提示词末尾/);
  assert.equal(describeImageSize(target([]), {}, { ratio: "16:9", tier: "2K" }), "比例 16:9 · 分辨率 2K · 约 2048x1152 · 写入提示词");
});

test("WxH sizes become wide-to-tall ratios; picking writes the exact size and auto clears it", async () => {
  const { env, trigger, changes } = await picker({ target: openai, values: { size: "1536x1024", quality: "high" } });
  assert.match(trigger.textContent, /3:2/);
  assert.match(trigger.textContent, /1\.5K/);
  await env.act(async () => trigger.click());
  const group = document.querySelector('[role="radiogroup"][aria-label="画面比例"]');
  assert.ok(group, "ratio grid renders when opened");
  assert.deepEqual([...group.querySelectorAll("label")].map((l) => l.textContent.trim()), ["自动", "3:2", "1:1", "2:3"]);
  const pick = async (label) => {
    const input = [...group.querySelectorAll("label")].find((l) => l.textContent.trim() === label).querySelector("input");
    await env.act(async () => input.click());
  };
  await pick("2:3");
  assert.deepEqual(changes.at(-1), { size: "1024x1536", quality: "high" });
  await pick("自动");
  assert.deepEqual(changes.at(-1), { quality: "high" }, "auto removes only the size key");
  assert.match(document.body.textContent, /更多参数/, "remaining parameters stay reachable");
});

test("auto and duplicate-ratio sizes use separate ratio and supported resolution controls", async () => {
  const sized = target([enumSpec("size", ["auto", "256x256", "1024x1024", "1536x1024"])]);
  const { env, trigger, changes, render, describeImageSize } = await picker({ target: sized, values: { size: "auto" } });
  assert.match(trigger.textContent, /自动比例/);
  assert.equal(describeImageSize(sized, { size: "auto" }), "尺寸由模型自动决定");
  await env.act(async () => trigger.click());
  const group = document.querySelector('[role="radiogroup"][aria-label="画面比例"]');
  const labels = [...group.querySelectorAll("label")].map((l) => l.textContent.trim());
  assert.deepEqual(labels, ["自动", "3:2", "1:1"]);
  assert.doesNotMatch(document.body.textContent, /附加在提示词末尾/, "an auto size is still a size parameter");
  const pick = async (label) => {
    const input = [...group.querySelectorAll("label")].find((l) => l.textContent.trim() === label).querySelector("input");
    await env.act(async () => input.click());
  };
  await pick("1:1");
  assert.deepEqual(changes.at(-1), { size: "256x256" });
  await render({ values: changes.at(-1) });
  const tiers = document.querySelector('[role="radiogroup"][aria-label="分辨率"]');
  assert.deepEqual([...tiers.querySelectorAll("label")].map(l => l.textContent.trim()), ["自动", "256 像素", "1K"]);
  await env.act(async () => [...tiers.querySelectorAll("label")].find(l => l.textContent.trim() === "1K").querySelector("input").click());
  assert.deepEqual(changes.at(-1), { size: "1024x1024" });
  await render({ values: changes.at(-1) });
  assert.match(document.body.textContent, /1024/);
  const sizedPicker = await picker({ target: sized, values: { size: "1024x1024" } });
  await sizedPicker.env.act(async () => sizedPicker.trigger.click());
  const autoInput = [...document.querySelectorAll('[role="radiogroup"][aria-label="画面比例"]')].at(-1)
    .querySelector("label input");
  await sizedPicker.env.act(async () => autoInput.click());
  assert.deepEqual(sizedPicker.changes.at(-1), { size: "auto" }, "a declared auto is sent, not dropped");
});

test("fixed-size models keep all three UI sections and never invent a ratio/resolution combination", async () => {
  const { env, trigger, changes, render } = await picker({ target: openai, values: { size: "1024x1024", quality: "high" } });
  await env.act(async () => trigger.click());
  const radios = label => document.querySelector(`[role="radiogroup"][aria-label="${label}"]`);
  const labels = group => [...group.querySelectorAll("label")].map(l => l.textContent.trim());
  assert.deepEqual(labels(radios("分辨率")), ["自动", "1K"]);
  assert.match(document.body.textContent, /尺寸/);
  await env.act(async () => [...radios("画面比例").querySelectorAll("label")].find(l => l.textContent.trim() === "3:2").querySelector("input").click());
  assert.deepEqual(changes.at(-1), { size: "1536x1024", quality: "high" });
  await render({ values: changes.at(-1) });
  assert.deepEqual(labels(radios("分辨率")), ["自动", "1.5K"]);
  assert.match(document.body.textContent, /1536/);
  assert.doesNotMatch(document.body.textContent, /估算|2K|4K/);
  assert.equal(changes.at(-1).imageSize, undefined, "a size-only API never receives an invented resolution field");
});

test("aspect and resolution models expose only declared choices and mark derived dimensions as estimates", async () => {
  const { env, trigger, changes } = await picker({ target: google, values: { aspectRatio: "16:9", imageSize: "2K" } });
  await env.act(async () => trigger.click());
  assert.match(document.body.textContent, /尺寸（估算）/);
  assert.match(document.body.textContent, /2048/);
  assert.match(document.body.textContent, /1152/);
  const tiers = document.querySelector('[role="radiogroup"][aria-label="分辨率"]');
  assert.deepEqual([...tiers.querySelectorAll("label")].map(l => l.textContent.trim()), ["自动", "1K", "2K"]);
  await env.act(async () => [...tiers.querySelectorAll("label")].find(l => l.textContent.trim() === "1K").querySelector("input").click());
  assert.deepEqual(changes.at(-1), { aspectRatio: "16:9", imageSize: "1K" });
});

test("more parameters use Chinese labels/options and retain their original wire values", async () => {
  const model = target([
    ...openai.parameters,
    enumSpec("output_format", ["png", "jpeg", "webp"]),
    enumSpec("background", ["auto", "opaque", "transparent"]),
    { key: "output_compression", label: "Output compression", type: "integer", minimum: 0, maximum: 100 },
  ]);
  const { env, trigger, changes, render } = await picker({ target: model, values: { quality: "low" } });
  await env.act(async () => trigger.click());
  for (const label of ["图像质量", "图片格式", "背景", "输出压缩"]) assert.ok([...document.querySelectorAll("label")].some(l => l.textContent.trim() === label));
  assert.doesNotMatch(document.body.textContent, /quality|output_format|background|Output compression/);
  const quality = [...document.querySelectorAll("label")].find(l => l.textContent.trim() === "图像质量");
  const input = document.getElementById(quality.htmlFor);
  assert.deepEqual([...input.options].map(o => o.textContent), ["默认", "低", "高"]);
  await env.act(async () => {
    input.value = "1";
    input.dispatchEvent(new env.dom.window.Event("change", { bubbles: true }));
  });
  assert.deepEqual(changes.at(-1), { quality: "high" });
  await render({ values: changes.at(-1) });
  const background = [...document.querySelectorAll("label")].find(l => l.textContent.trim() === "背景");
  const backgroundInput = document.getElementById(background.htmlFor);
  assert.deepEqual([...backgroundInput.options].map(o => o.textContent), ["默认", "自动", "不透明", "透明"]);
  await env.act(async () => {
    backgroundInput.value = "2";
    backgroundInput.dispatchEvent(new env.dom.window.Event("change", { bubbles: true }));
  });
  assert.deepEqual(changes.at(-1), { quality: "high", background: "transparent" });
});

test("a model without an independent resolution enum still keeps the size section without invented choices", async () => {
  const { env, trigger } = await picker({ target: target([enumSpec("aspectRatio", ["1:1", "16:9"])]), values: {} });
  await env.act(async () => trigger.click());
  assert.match(document.body.textContent, /分辨率/);
  assert.match(document.body.textContent, /由模型决定/);
  assert.match(document.body.textContent, /尺寸（估算）/);
  assert.equal(document.querySelector('[role="radiogroup"][aria-label="分辨率"]'), null);
});

test("required native size contracts never offer an unset automatic value", async () => {
  const required = target([{ ...openai.parameters[0], required: true }]);
  const { env, trigger } = await picker({ target: required, values: { size: "1024x1024" } });
  await env.act(async () => trigger.click());
  for (const name of ["画面比例", "分辨率"]) {
    const group = document.querySelector(`[role="radiogroup"][aria-label="${name}"]`);
    assert.ok(group);
    assert.ok(![...group.querySelectorAll("label")].some(l => l.textContent.trim() === "自动"));
  }
});

test("automatic aspect ratios never invent dimensions for a selected resolution", async () => {
  const autoAspect = target([enumSpec("aspectRatio", ["auto", "1:1"]), enumSpec("imageSize", ["1.5K", "2K"])]);
  const { env, trigger } = await picker({ target: autoAspect, values: { aspectRatio: "auto", imageSize: "2K" } });
  await env.act(async () => trigger.click());
  assert.doesNotMatch(document.body.textContent, /NaN|undefined|2048/);
});
