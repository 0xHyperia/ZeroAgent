import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSources = [
  readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8"),
  [
    "../../../agent-gateway/web/src/app/hooks/useGatewaySettingsOverlay.ts",
    "../../../agent-gateway/web/src/app/GatewayAppView.tsx",
  ]
    .map((relativePath) => readFileSync(new URL(relativePath, import.meta.url), "utf8"))
    .join("\n"),
];

const settingsPageSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);

const settingsAdapterSources = [
  readFileSync(new URL("../../src/agent-ui-adapters/settingsExtension.tsx", import.meta.url), "utf8"),
  readFileSync(
    new URL(
      "../../../agent-gateway/web/src/agent-ui-adapters/settingsExtension.tsx",
      import.meta.url,
    ),
    "utf8",
  ),
];

test("settings overlays carry a requested provider id", () => {
  for (const source of appSources) {
    assert.match(source, /settingsProviderId/);
    assert.match(
      source,
      /setSettingsProviderId\(section === "providers" \? providerId : undefined\)/,
    );
    assert.match(source, /initialProviderId=\{settingsProviderId\}/);
  }
});

test("settings pages route provider navigation through the surface adapter", () => {
  assert.match(settingsPageSource, /pendingProviderId/);
  assert.match(settingsPageSource, /extension\.renderProviders\(\{/);
  assert.match(settingsPageSource, /initialProviderId: pendingProviderId/);
  assert.match(
    settingsPageSource,
    /onInitialProviderHandled: \(\) => setPendingProviderId\(undefined\)/,
  );
});

test("desktop and WebUI adapters use protected USA-Zero provider settings", () => {
  for (const source of settingsAdapterSources) {
    assert.match(source, /import \{ RelayProvidersSection \}/);
    assert.match(source, /renderProviders:/);
    assert.match(source, /<RelayProvidersSection/);
    assert.doesNotMatch(source, /<ProvidersSection/);
  }
});
