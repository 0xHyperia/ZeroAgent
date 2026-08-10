import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const managedProviderSources = [
  readFileSync(new URL("../../src/pages/settings/RelayProvidersSection.tsx", import.meta.url), "utf8"),
  readFileSync(
    new URL("../../../agent-gateway/web/src/pages/settings/RelayProvidersSection.tsx", import.meta.url),
    "utf8",
  ),
];

const adapterSources = [
  readFileSync(new URL("../../src/agent-ui-adapters/settingsExtension.tsx", import.meta.url), "utf8"),
  readFileSync(
    new URL("../../../agent-gateway/web/src/agent-ui-adapters/settingsExtension.tsx", import.meta.url),
    "utf8",
  ),
];

test("managed key copy requires USA-Zero password verification on every surface", () => {
  for (const source of managedProviderSources) {
    const verification = source.indexOf("await verifyRelayPassword(user.email, password)");
    const clipboardWrite = source.indexOf("await navigator.clipboard.writeText(copyTarget.key)");
    assert.notEqual(verification, -1);
    assert.notEqual(clipboardWrite, -1);
    assert.ok(verification < clipboardWrite, "password verification must precede key exposure");
  }
});

test("generic provider settings cannot bypass the managed USA-Zero provider boundary", () => {
  for (const source of adapterSources) {
    assert.match(source, /RelayProvidersSection/);
    assert.doesNotMatch(source, /import \{ ProvidersSection \}/);
    assert.doesNotMatch(source, /<ProvidersSection(?:\s|\/|>)/);
  }
});
