import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(guiRoot, "../..");

function readRepoFile(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

test("Desktop and WebUI chat surfaces use the ZeroAgent logo", () => {
  const avatarAdapters = [
    readRepoFile("crates/agent-gui/src/agent-ui-adapters/assistantAvatar.ts"),
    readRepoFile("crates/agent-gateway/web/src/agent-ui-adapters/assistantAvatar.ts"),
  ];

  for (const source of avatarAdapters) {
    assert.match(source, /\/zeroagent-logo\.png/);
    assert.doesNotMatch(source, /icon-simple\.png|iconSimpleUrl/);
  }
});

test("Desktop chat sidebar uses the ZeroAgent brand", () => {
  const source = readRepoFile("crates/agent-gui/src/agent-ui-adapters/sidebarChrome.tsx");

  assert.match(source, /src="\/zeroagent-logo\.png"/);
  assert.match(source, />ZeroAgent<\/div>/);
  assert.doesNotMatch(source, /Live Agent|iconSimpleUrl/);
});

test("Desktop and WebUI ship the same ZeroAgent logo asset", () => {
  const desktopLogo = readFileSync(path.join(repoRoot, "crates/agent-gui/public/zeroagent-logo.png"));
  const webLogo = readFileSync(
    path.join(repoRoot, "crates/agent-gateway/web/public/zeroagent-logo.png"),
  );

  assert.deepEqual(desktopLogo, webLogo);
});
