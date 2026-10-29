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

test("desktop managed key copy uses the password-bound native reveal result", () => {
  const source = managedProviderSources[0];
  const verification = source.indexOf("await revealRelayApiKey(copyTarget.id, password)");
  const clipboardWrite = source.indexOf("await navigator.clipboard.writeText(value)");
  assert.notEqual(verification, -1);
  assert.notEqual(clipboardWrite, -1);
  assert.ok(verification < clipboardWrite, "native key authorization must complete before clipboard exposure");
  assert.doesNotMatch(source, /clipboard\.writeText\(copyTarget\.key\)/);
  const client = readFileSync(new URL("../../src/lib/relay/client.ts", import.meta.url), "utf8");
  assert.match(client, /isTauriHost\(\)\) return nativeRevealKey\(id, password\)/);
});

test("web managed key copy still requires USA-Zero password verification", () => {
  const source = managedProviderSources[1];
  const verification = source.indexOf("await revealRelayApiKey(copyTarget.id, password)");
  const accountGuard = source.indexOf("requireCurrent();", verification);
  const clipboardWrite = source.indexOf("await navigator.clipboard.writeText(key)", verification);
  assert.notEqual(verification, -1);
  assert.notEqual(accountGuard, -1);
  assert.notEqual(clipboardWrite, -1);
  assert.ok(verification < accountGuard && accountGuard < clipboardWrite,
    "password-bound reveal and the captured account guard must precede clipboard exposure");
  assert.doesNotMatch(source, /clipboard\.writeText\(copyTarget\.key\)/);
});

test("generic provider settings cannot bypass the managed USA-Zero provider boundary", () => {
  for (const source of adapterSources) {
    assert.match(source, /RelayProvidersSection/);
    assert.doesNotMatch(source, /import \{ ProvidersSection \}/);
    assert.doesNotMatch(source, /<ProvidersSection(?:\s|\/|>)/);
  }
});
