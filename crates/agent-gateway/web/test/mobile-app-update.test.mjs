import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const previousVersion = globalThis.__ZEROAGENT_APP_VERSION__;
globalThis.__ZEROAGENT_APP_VERSION__ = "1.2.3";
const updateModule = createWebModuleLoader().loadModule("@/lib/mobileAppUpdate.ts");

test.after(() => {
  if (previousVersion === undefined) delete globalThis.__ZEROAGENT_APP_VERSION__;
  else globalThis.__ZEROAGENT_APP_VERSION__ = previousVersion;
});

test("mobile update version comparison handles tags and missing segments", () => {
  assert.equal(updateModule.MOBILE_APP_VERSION, "1.2.3");
  assert.equal(updateModule.compareAppVersions("v1.2.4", "1.2.3"), 1);
  assert.equal(updateModule.compareAppVersions("1.2", "1.2.0"), 0);
  assert.equal(updateModule.compareAppVersions("1.1.99", "1.2.0"), -1);
});

function release(version, overrides = {}) {
  return {
    tag_name: `v${version}`,
    name: `ZeroAgent v${version}`,
    body: "Release notes",
    html_url: `https://github.com/USA0-Zero/ZeroAgent/releases/tag/v${version}`,
    draft: false,
    prerelease: version.includes("-"),
    assets: [
      {
        name: `ZeroAgent-v${version}-Android-arm64.apk`,
        browser_download_url: `https://github.com/USA0-Zero/ZeroAgent/releases/download/v${version}/ZeroAgent-v${version}-Android-arm64.apk`,
      },
    ],
    ...overrides,
  };
}

function fixture({ version = "0.4.0-beta.1", embedded = true } = {}) {
  const previous = globalThis.__ZEROAGENT_APP_VERSION__;
  globalThis.__ZEROAGENT_APP_VERSION__ = version;
  const opened = [];
  let module;
  try {
    module = createWebModuleLoader({
      mocks: {
        "./mobileRuntime": {
          isEmbeddedMobileRuntime: () => embedded,
          openEmbeddedExternalUrl: async (url) => opened.push(url),
        },
      },
    }).loadModule("@/lib/mobileAppUpdate.ts");
  } finally {
    if (previous === undefined) delete globalThis.__ZEROAGENT_APP_VERSION__;
    else globalThis.__ZEROAGENT_APP_VERSION__ = previous;
  }
  const requests = [];
  let jsonReads = 0;
  return {
    module,
    opened,
    requests,
    get jsonReads() {
      return jsonReads;
    },
    async check(payload, status = 200) {
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        requests.push({ url, options });
        return {
          ok: status >= 200 && status < 300,
          status,
          async json() {
            jsonReads += 1;
            return payload;
          },
        };
      };
      try {
        return await module.checkMobileAppUpdate();
      } finally {
        globalThis.fetch = previousFetch;
      }
    },
  };
}

test("mobile versions order prerelease identifiers before the stable release", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.10",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(updateModule.compareAppVersions(ordered[index - 1], ordered[index]), -1);
    assert.equal(updateModule.compareAppVersions(ordered[index], ordered[index - 1]), 1);
  }
  assert.equal(updateModule.compareAppVersions("1.0.0-9", "1.0.0-alpha"), -1);
  assert.equal(
    updateModule.compareAppVersions(
      "1.0.0-beta.99999999999999999999",
      "1.0.0-beta.100000000000000000000",
    ),
    -1,
  );
});

test("mobile versions ignore build metadata without losing prerelease order", () => {
  assert.equal(updateModule.compareAppVersions("0.4.0+build.2", "0.4.0+build.1"), 0);
  assert.equal(updateModule.compareAppVersions("v0.4.0-beta.2+build.8", "0.4.0-beta.2+build.9"), 0);
  assert.equal(updateModule.compareAppVersions("0.4.0-beta.2+build.1", "0.4.0-beta.1+build.9"), 1);
});

test("mobile versions reject malformed numeric and prerelease identifiers", () => {
  for (const invalid of ["garbage", "0.4.0.1", "01.2.3", "0.4.0-beta.01", "0.4.0-", "0.4.0+"]) {
    assert.throws(() => updateModule.compareAppVersions(invalid, "0.4.0"), /版本号无效/);
  }
});

test("stable mobile updates retain the latest stable endpoint and result shape", async () => {
  const app = fixture({ version: "1.2.3" });
  const next = release("1.2.4");
  const result = await app.check(next);
  assert.equal(
    app.requests[0].url,
    "https://api.github.com/repos/USA0-Zero/ZeroAgent/releases/latest",
  );
  assert.equal(app.requests[0].options.cache, "no-store");
  assert.equal(app.requests[0].options.headers.Accept, "application/vnd.github+json");
  assert.deepEqual(result, {
    currentVersion: "1.2.3",
    version: "1.2.4",
    title: next.name,
    notes: next.body,
    apkUrl: next.assets[0].browser_download_url,
    releaseUrl: next.html_url,
  });
});

test("stable mobile updates reject preview tags, preview metadata and drafts", async () => {
  for (const candidate of [
    release("0.4.0-beta.1", { prerelease: false }),
    release("0.4.0", { prerelease: true }),
    release("0.4.0", { draft: true }),
  ]) {
    const app = fixture({ version: "0.3.23" });
    assert.equal(await app.check(candidate), null);
  }
});

test("preview mobile updates select the highest eligible version from an unordered list", async () => {
  const app = fixture();
  const result = await app.check([
    release("0.4.0-beta.2"),
    release("0.5.0", { draft: true }),
    release("nightly"),
    release("0.3.23"),
    release("0.4.0-beta.10"),
  ]);
  assert.equal(
    app.requests[0].url,
    "https://api.github.com/repos/USA0-Zero/ZeroAgent/releases?per_page=20",
  );
  assert.equal(result.version, "0.4.0-beta.10");
});

test("preview mobile updates can promote to the same core stable version", async () => {
  const app = fixture();
  const result = await app.check([release("0.4.0-beta.20"), release("0.4.0"), release("0.3.23")]);
  assert.equal(result.version, "0.4.0");
});

test("mobile update checks return null when no higher eligible version exists", async () => {
  assert.equal(await fixture().check([release("0.4.0-beta.1"), release("0.4.0-beta.0")]), null);
  assert.equal(await fixture().check([]), null);
  assert.equal(await fixture({ version: "0.4.0" }).check(release("0.4.0+build.2")), null);
});

test("a newer release without its Android APK remains an explicit error", async () => {
  const app = fixture();
  await assert.rejects(
    app.check([release("0.4.0-beta.2"), release("0.4.0-beta.3", { assets: [] })]),
    /尚未提供 Android arm64 安装包/,
  );
});

test("mobile update APK URLs retain the GitHub HTTPS boundary", async () => {
  for (const url of [
    "https://example.com/ZeroAgent-Android-arm64.apk",
    "http://github.com/USA0-Zero/ZeroAgent/Android-arm64.apk",
  ]) {
    const app = fixture();
    await assert.rejects(
      app.check([
        release("0.4.0-beta.2", {
          assets: [{ name: "ZeroAgent-Android-arm64.apk", browser_download_url: url }],
        }),
      ]),
      /尚未提供 Android arm64 安装包/,
    );
  }
});

test("mobile update HTTP errors are reported before reading release JSON", async () => {
  const app = fixture();
  await assert.rejects(app.check([], 403), /检查更新失败 \(403\)/);
  assert.equal(app.jsonReads, 0);
});

test("mobile update checks reject malformed response shapes and unusable version data", async () => {
  await assert.rejects(fixture().check(release("0.4.0-beta.2")), /版本信息无效/);
  await assert.rejects(fixture({ version: "0.3.23" }).check([]), /版本信息无效/);
  await assert.rejects(fixture().check([release("nightly")]), /版本信息无效/);
  const app = fixture({ version: "not-a-version" });
  await assert.rejects(app.check([release("0.4.0-beta.2")]), /版本号无效/);
  assert.equal(app.requests.length, 0);
});

test("nonembedded mobile update checks do not fetch releases", async () => {
  const app = fixture({ embedded: false });
  assert.equal(await app.check([release("0.4.0-beta.2")]), null);
  assert.equal(app.requests.length, 0);
});

test("mobile APK downloads continue through the existing external URL bridge", async () => {
  const app = fixture();
  const next = await app.check([release("0.4.0-beta.2")]);
  await app.module.downloadMobileAppUpdate(next);
  assert.deepEqual(app.opened, [next.apkUrl]);
});

test("manual mobile update requests retain their event and runtime gate", () => {
  const previousWindow = globalThis.window;
  const events = [];
  globalThis.window = { dispatchEvent: (event) => events.push(event.type) };
  try {
    fixture().module.requestMobileAppUpdateCheck();
    fixture({ embedded: false }).module.requestMobileAppUpdateCheck();
    assert.deepEqual(events, [updateModule.MOBILE_UPDATE_CHECK_EVENT]);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
