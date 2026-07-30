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
