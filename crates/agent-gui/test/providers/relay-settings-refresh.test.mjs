import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../src/pages/settings/RelayProvidersSection.tsx", import.meta.url),
  "utf8",
);

test("relay settings opens directly on the key list without a manual refresh header", () => {
  assert.doesNotMatch(source, /USA-零专属终端/);
  assert.doesNotMatch(source, /onClick=\{\(\) => void syncProviders\(true\)\}/);
  assert.doesNotMatch(source, /ZeroAgentLogo|RefreshCw/);
});

test("relay settings refreshes provider models during initial data loading", () => {
  assert.match(
    source,
    /bindRelayKeysToSettings\(\s*settingsRef\.current,\s*currentKeys,\s*availableGroups,\s*true,/,
  );
  assert.match(source, /useEffect\(\(\) => \{\s*void loadData\(\);/);
});
