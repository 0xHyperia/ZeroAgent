import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createWebDomTestEnv } from "../../test/helpers/dom-test-env.mjs";

const body = "# Library cover\n\nA real, verified original.";
const resource = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Library.md", mime: "text/markdown", size: Buffer.byteLength(body),
  sha256: createHash("sha256").update(body).digest("hex"), state: "ready",
};
const item = {
  ...resource, target_id: resource.id, kind: "file", updated_at: "2026-11-03T00:00:00Z",
};

async function mount(t, initial = {}, component = "cover") {
  let env;
  env = await createWebDomTestEnv({
    resolveDynamicImports: true,
    mocks: {
      "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
      "../IconSet": new Proxy({}, { get: () => () => null }),
      // Keep the production verified read and lifecycle, without loading a format renderer in JSDOM.
      "./ResourcePreviewContent": { __esModule: true, default: () =>
        env.React.createElement("div", { "data-rendered-cover": true }, "Verified cover") },
    },
  });
  const previousObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  const observers = new Set();
  globalThis.IntersectionObserver = class {
    nodes = new Set();
    constructor(callback) { this.callback = callback; observers.add(this); }
    observe(node) { this.nodes.add(node); }
    disconnect() { this.nodes.clear(); observers.delete(this); }
  };
  const host = document.body.appendChild(document.createElement("div")), root = env.createRoot(host);
  const reads = { metadata: 0, originals: 0, sites: 0 };
  let owner = 1;
  const captureGuard = () => {
    const at = owner;
    return () => { if (owner !== at) throw new Error("Account changed"); };
  };
  const files = {
    get: async () => { reads.metadata++; return resource; },
    download: async () => { reads.originals++; return { blob: new Blob([body]), guard: captureGuard() }; },
  };
  const artifacts = { sites: { cover: async () => { reads.sites++; return "<p>Site cover</p>"; } } };
  const Component = component === "cover"
    ? env.loadModule("src/components/cloudchat/CloudSpaceCover.tsx").CloudSpaceCover
    : env.loadModule("@liveagent/ui/components/resource-preview/ResourcePreview").ResourceThumbnail;
  let props = component === "cover"
    ? { item, showPreview: false, files, artifacts, captureGuard, ...initial }
    : { resource: { ...resource, identity: "original:1" },
      load: async () => { reads.originals++; return { blob: new Blob([body]), assertCurrent: captureGuard() }; }, ...initial };
  const flush = async () => env.act(async () => {
    for (let step = 0; step < 8; step++) await new Promise(resolve => setImmediate(resolve));
  });
  const update = async next => {
    props = { ...props, ...next };
    await env.act(async () => root.render(env.React.createElement(Component, props)));
    await flush();
  };
  const intersect = async (node, visible) => {
    assert.ok(node, "Intersection target exists");
    await env.act(async () => {
      for (const observer of [...observers]) if (observer.nodes.has(node))
        observer.callback([{ target: node, isIntersecting: visible }]);
    });
    await flush();
  };
  await update({});
  t.after(async () => {
    await env.act(async () => root.unmount()); host.remove(); env.cleanup();
    if (previousObserver) Object.defineProperty(globalThis, "IntersectionObserver", previousObserver);
    else delete globalThis.IntersectionObserver;
  });
  const rendered = () => host.querySelector("[data-rendered-cover]");
  // SHA-256 verification and the lazy renderer can settle independently of React's current turn.
  const waitForRendered = async () => {
    await env.waitFor(rendered, "verified original to reach the format renderer");
    return rendered();
  };
  return { host, reads, props: () => props, update, intersect, flush, waitForRendered,
    retire: () => owner++, rendered };
}

test("list covers never read originals, while a grid starts only near the viewport", async t => {
  const app = await mount(t);
  await app.intersect(app.host.querySelector(".cloud-space-cover"), true);
  assert.deepEqual(app.reads, { metadata: 0, originals: 0, sites: 0 });
  assert.ok(app.host.querySelector(".cloud-space-cover-icon"));
  assert.equal(app.host.querySelector(".cloud-space-cover-preview").dataset.hidden, "true");
  await app.intersect(app.host.querySelector(".cloud-space-cover"), false);
  await app.update({ showPreview: true });
  assert.equal(app.reads.metadata, 0);
  await app.intersect(app.host.querySelector(".cloud-space-cover"), true);
  assert.equal(app.reads.metadata, 1);
  await app.intersect(app.host.querySelector(".za-resource-thumbnail"), true);
  assert.equal(app.reads.originals, 1);
  await app.waitForRendered();
});

test("grid covers keep the same rendered node across scrolling, view switches and metadata refresh", async t => {
  const app = await mount(t, { showPreview: true });
  const cover = app.host.querySelector(".cloud-space-cover");
  await app.intersect(cover, true);
  const thumbnail = app.host.querySelector(".za-resource-thumbnail");
  await app.intersect(thumbnail, true);
  const rendered = await app.waitForRendered();
  await app.intersect(cover, false);
  await app.intersect(thumbnail, false);
  await app.update({ showPreview: false });
  await app.update({ item: { ...item, name: "Renamed.md", starred: true, updated_at: "2026-11-03T01:00:00Z" }, captureGuard: app.props().captureGuard.bind(null) });
  await app.update({ showPreview: true });
  await app.intersect(cover, true);
  await app.intersect(thumbnail, true);
  assert.equal(app.rendered(), rendered);
  assert.deepEqual(app.reads, { metadata: 1, originals: 1, sites: 0 });
});

test("site covers preserve their browsing context but replace it for a different immutable version", async t => {
  const site = { ...item, kind: "artifact", name: "Site.zip", mime: "application/zip", site_version_id: "site-version-1" };
  const app = await mount(t, { item: site, showPreview: true });
  await app.intersect(app.host.querySelector(".cloud-space-cover"), true);
  const frame = app.host.querySelector("iframe"); assert.ok(frame);
  await app.update({ showPreview: false });
  await app.update({ item: { ...site, name: "Renamed site", updated_at: "later" }, showPreview: true });
  assert.equal(app.host.querySelector("iframe"), frame);
  assert.equal(app.reads.sites, 1);
  await app.update({ item: { ...site, site_version_id: "site-version-2" } });
  assert.equal(frame.isConnected, false);
  await app.intersect(app.host.querySelector(".cloud-space-cover"), true);
  assert.notEqual(app.host.querySelector("iframe"), frame);
  assert.equal(app.reads.sites, 2);
});

test("retired accounts cannot install a delayed original descriptor", async t => {
  let release;
  const app = await mount(t, { showPreview: true,
    files: { get: () => new Promise(resolve => { release = resolve; }), download: () => assert.fail("Retired original read") } });
  await app.intersect(app.host.querySelector(".cloud-space-cover"), true);
  app.retire(); release(resource); await app.flush();
  assert.equal(app.host.querySelector(".za-resource-thumbnail"), null);
});

test("shared draft thumbnails still release offscreen previews unless retention is requested", async t => {
  const app = await mount(t, {}, "thumbnail");
  const thumbnail = app.host.querySelector(".za-resource-thumbnail");
  await app.intersect(thumbnail, true);
  await app.waitForRendered();
  await app.intersect(thumbnail, false);
  assert.equal(app.rendered(), null);
});
