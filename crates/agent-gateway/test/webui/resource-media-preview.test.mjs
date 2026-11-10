import assert from "node:assert/strict";
import test from "node:test";
import { createWebDomTestEnv } from "../helpers/dom-test-env.mjs";

async function mount(t, kind = "video", authority = () => {}, workspace = false) {
  const env = await createWebDomTestEnv();
  const states = new WeakMap();
  const state = (element) => {
    if (!states.has(element)) states.set(element, { paused: true, ended: false, plays: 0, pauses: 0, loads: 0 });
    return states.get(element);
  };
  const prototype = env.dom.window.HTMLMediaElement.prototype;
  for (const [key, getter] of Object.entries({ paused() { return state(this).paused; }, ended() { return state(this).ended; }, duration() { return 120; }, readyState() { return 4; }, buffered() { return { length: 1, start: () => 0, end: () => 60 }; } })) {
    Object.defineProperty(prototype, key, { configurable: true, get: getter });
  }
  for (const key of ["volume", "muted", "playbackRate"]) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    Object.defineProperty(prototype, key, { configurable: true, get: descriptor.get, set(value) { descriptor.set.call(this, value); this.dispatchEvent(new Event(key === "playbackRate" ? "ratechange" : "volumechange")); } });
  }
  prototype.play = function () { const value = state(this); value.plays++; value.paused = false; value.ended = false; this.dispatchEvent(new Event("play")); return value.promise ?? Promise.resolve(); };
  prototype.pause = function () { const value = state(this); value.pauses++; if (!value.paused) { value.paused = true; this.dispatchEvent(new Event("pause")); } };
  prototype.load = function () { state(this).loads++; };
  const Player = env.loadModule("@liveagent/ui/components/resource-preview/ResourceMediaPreview.tsx").default;
  const { PreviewToolbarMount } = env.loadModule("@liveagent/ui/components/resource-preview/PreviewChrome.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  let downloads = 0, retries = 0, disposed = false;
  const render = async (nextKind = kind, key = "one", active = true) => env.act(async () => root.render(env.React.createElement(env.React.StrictMode, null, env.React.createElement(PreviewToolbarMount.Provider, { value: workspace ? { workspaceTab: true, target: active ? host : null } : null }, env.React.createElement(Player, { key, kind: nextKind, url: `blob:${key}`, name: nextKind === "audio" && workspace ? "合成媒体.mp3" : "合成媒体.mp4", assertCurrent: () => authority(), onDownload() { downloads++; }, onRetry() { retries++; } })))));
  const click = async (label) => {
    const button = host.querySelector(`button[aria-label="${label}"]`);
    assert.ok(button, `missing ${label}`);
    await env.act(async () => { button.click(); });
  };
  const unmount = async () => { if (!disposed) { await env.act(async () => root.unmount()); disposed = true; } };
  t.after(async () => { await unmount(); host.remove(); env.cleanup(); });
  await render();
  return { env, host, render, click, unmount, state, get downloads() { return downloads; }, get retries() { return retries; } };
}

function changeRange(app, label, value) {
  const input = document.querySelector(`input[aria-label="${label}"]`);
  assert.ok(input, `missing range ${label}`);
  Object.getOwnPropertyDescriptor(app.env.dom.window.HTMLInputElement.prototype, "value").set.call(input, String(value));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

test("video uses shared controls without autoplay; play, seek, buffering and replay follow decoder events", async (t) => {
  const app = await mount(t);
  const video = app.host.querySelector("video");
  assert.equal(video.controls, false);
  assert.equal(video.autoplay, false);
  assert.equal(app.state(video).plays, 0);
  assert.equal(app.host.querySelector('input[aria-label="播放进度"]').max, "120");
  assert.equal(app.host.querySelector(".za-media-buffer").style.width, "50%");
  await app.click("播放");
  assert.equal(app.state(video).paused, false);
  assert.equal(video.getAttribute("src"), "blob:one", "Strict Effects reinstall the same source");
  const loads = app.state(video).loads;
  await app.render();
  assert.equal(app.state(video).paused, false, "host layout updates keep playback alive");
  assert.equal(app.state(video).loads, loads);
  await app.env.act(async () => video.dispatchEvent(new Event("waiting")));
  assert.match(app.host.textContent, /正在缓冲/);
  await app.env.act(async () => changeRange(app, "播放进度", 72));
  assert.equal(video.currentTime, 72);
  assert.match(app.host.querySelector(".za-media-time").textContent, /1:12 \/ 2:00/);
  await app.env.act(async () => video.dispatchEvent(new Event("seeked")));
  assert.equal(app.host.querySelector(".za-media-buffering"), null);
  await app.click("暂停");
  assert.equal(app.state(video).paused, true);
  await app.env.act(async () => { app.state(video).ended = true; video.currentTime = 120; video.dispatchEvent(new Event("ended")); });
  await app.click("重新播放");
  assert.equal(video.currentTime, 0);
  assert.equal(app.state(video).plays, 2);
});

test("audio shares volume and speed controls; keyboard shortcuts stay inside the focused player", async (t) => {
  const app = await mount(t, "audio");
  const audio = app.host.querySelector("audio");
  assert.equal(audio.controls, false);
  assert.ok(app.host.querySelector(".za-media-audio-cover"));
  assert.equal(app.host.querySelector('button[aria-label="全屏播放"]'), null);
  const player = app.host.querySelector(".za-media-player");
  const key = (element, value) => element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
  await app.env.act(async () => key(document.body, "k"));
  assert.equal(app.state(audio).plays, 0);
  await app.env.act(async () => key(player, "k"));
  assert.equal(app.state(audio).plays, 1);
  await app.env.act(async () => key(player, "ArrowRight"));
  assert.equal(audio.currentTime, 5);
  await app.env.act(async () => key(player, "m"));
  assert.equal(audio.muted, true);
  await app.click("音量");
  await app.env.act(async () => changeRange(app, "音量大小", 0.35));
  assert.equal(audio.volume, 0.35);
  assert.equal(audio.muted, false);
  await app.env.act(async () => key(app.host.querySelector('button[aria-label="播放速度"]'), "ArrowDown"));
  const speed = [...document.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent === "1.5×");
  assert.ok(speed);
  await app.env.act(async () => speed.click());
  assert.equal(audio.playbackRate, 1.5);
  assert.equal(app.host.querySelector('button[aria-label="播放速度"]').textContent, "1.5×");
});

test("workspace media keeps audio metadata, controls and playback scoped to the active tab", async (t) => {
  const app = await mount(t, "audio", () => {}, true);
  const audio = app.host.querySelector("audio");
  assert.match(app.host.querySelector(".za-workspace-audio-identity").textContent, /合成媒体\.mp3.*MP3 音频/);
  assert.ok(app.host.querySelector('.za-workspace-audio-actions button[aria-label="播放"]'));
  assert.ok(app.host.querySelector('.za-workspace-audio-actions button[aria-label="音频选项"]'));
  assert.equal(app.host.querySelector(".za-media-transport button"), null);
  await app.click("播放");
  assert.equal(app.state(audio).paused, false);
  await app.env.act(async () => changeRange(app, "播放进度", 24.5));
  assert.equal(audio.currentTime, 24.5);
  await app.render("audio", "one", false);
  assert.equal(app.state(audio).paused, true);
  assert.equal(app.host.querySelector("audio"), audio);
  assert.equal(audio.currentTime, 24.5);
  await app.render("video", "two");
  const video = app.host.querySelector("video");
  await app.env.act(async () => video.click());
  assert.equal(app.state(video).plays, 1);
  await app.env.act(async () => video.click());
  assert.equal(app.state(video).paused, true);
});

test("source retirement pauses and unloads the decoder; late playback completion cannot touch a replacement", async (t) => {
  const app = await mount(t);
  const video = app.host.querySelector("video");
  let finish;
  app.state(video).promise = new Promise((resolve) => { finish = resolve; });
  const loads = app.state(video).loads;
  await app.click("播放");
  await app.render("audio", "two");
  assert.equal(video.getAttribute("src"), null);
  assert.equal(app.state(video).paused, true);
  assert.equal(app.state(video).loads, loads + 1);
  await app.env.act(async () => { finish(); video.dispatchEvent(new Event("error")); });
  assert.ok(app.host.querySelector("audio"));
  assert.equal(app.host.querySelector(".za-preview-unavailable"), null);
});

test("decode failures keep recovery actions, permission expiry blocks playback and rejected play is retryable", async (t) => {
  let valid = true;
  const app = await mount(t, "video", () => { if (!valid) throw new Error("expired"); });
  const video = app.host.querySelector("video");
  app.state(video).promise = Promise.reject(new DOMException("blocked", "NotAllowedError"));
  await app.click("播放");
  assert.match(app.host.textContent, /播放未能开始/);
  app.state(video).promise = undefined;
  await app.click("暂停");
  await app.click("播放");
  assert.doesNotMatch(app.host.textContent, /播放未能开始/);
  await app.env.act(async () => video.dispatchEvent(new Event("error")));
  assert.match(app.host.textContent, /无法播放此视频/);
  await app.env.act(async () => [...app.host.querySelectorAll("button")].find((button) => button.textContent === "下载原件").click());
  assert.equal(app.downloads, 1);
  await app.render("video", "fresh");
  const fresh = app.host.querySelector("video");
  valid = false;
  await app.click("播放");
  assert.equal(app.state(fresh).plays, 0);
  assert.match(app.host.textContent, /此预览已失效/);
});
