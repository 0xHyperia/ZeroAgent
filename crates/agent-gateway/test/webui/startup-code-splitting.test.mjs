// The ZeroAgent WebUI starts with the account-aware shell. Check that the
// resource readers and audio capture stay outside its static import graph.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  parseTypeScriptSource,
  walkSyntaxTree,
} from "../../../../scripts/typescript-source-tools.mjs";

const crates = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const webRoot = join(crates, "agent-gateway/web");
const webSrc = join(webRoot, "src");
const uiSrc = join(crates, "agent-ui/src");

// `import x from`, `import { a, type B } from`, `export * from`, `import "x"`;
// type-only imports and exports are erased and never load anything.
const STATIC_IMPORT =
  /^\s*(import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s*)?["']([^"']+)["']/gm;

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function resolveSource(specifier, fromFile) {
  let base;
  if (specifier.startsWith("@/")) base = join(webSrc, specifier.slice(2));
  else if (specifier.startsWith("@liveagent/app/")) {
    base = join(webSrc, specifier.slice("@liveagent/app/".length));
  } else if (specifier.startsWith("@liveagent/adapters/")) {
    base = join(webSrc, "agent-ui-adapters", specifier.slice("@liveagent/adapters/".length));
  } else if (specifier.startsWith("@liveagent/ui/")) {
    base = join(uiSrc, specifier.slice("@liveagent/ui/".length));
  } else if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else return null;
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every source file and package specifier reachable from `entry` without `import()`. */
function staticClosure(entry) {
  const files = new Set();
  const packages = new Set();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop();
    if (files.has(file)) continue;
    files.add(file);
    for (const [, , specifier] of stripComments(readFileSync(file, "utf8")).matchAll(
      STATIC_IMPORT,
    )) {
      const resolved = resolveSource(specifier, file);
      if (resolved) pending.push(resolved);
      else if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
        packages.add(specifier);
      }
    }
  }
  return { files, packages };
}

const relative = (file) => file.slice(crates.length + 1).replaceAll("\\", "/");

test("the account-aware entry keeps specialized readers and audio capture deferred", () => {
  const { files, packages } = staticClosure(join(webSrc, "main.tsx"));
  const reached = new Set([...files].map(relative));
  assert.ok(reached.has("agent-gateway/web/src/pages/AccountLoginPage.tsx"));
  for (const deferredModule of [
    "agent-ui/src/components/resource-preview/ResourcePreviewContent.tsx",
    "agent-ui/src/components/resource-preview/ResourceDOCXPreview.tsx",
    "agent-ui/src/components/resource-preview/ResourceSlidesPreview.tsx",
    "agent-ui/src/components/resource-preview/ResourceSheetPreview.tsx",
    "agent-ui/src/components/workspace-editor/WorkspaceHTMLPreview.tsx",
    "agent-ui/src/lib/stt/audio.ts",
  ]) {
    assert.ok(!reached.has(deferredModule), `${deferredModule} is imported at startup`);
  }
  for (const decoder of ["docx-preview", "exceljs", "@office-kit/pptx"]) {
    assert.ok(!packages.has(decoder), `${decoder} is imported at startup`);
  }
});

test("the picker, renderers and audio initialize on demand", () => {
  const expectations = [
    [join(webSrc, "components/useRemotePathPicker.tsx"), "./RemotePathPickerModal"],
    [join(uiSrc, "components/resource-preview/ResourcePreview.tsx"), "./ResourcePreviewContent"],
    [join(uiSrc, "components/resource-preview/ResourcePreviewContent.tsx"), "./ResourceSheetPreview"],
    [join(uiSrc, "components/workspace-editor/WorkspaceFilePreviewOverlay.tsx"), "./WorkspaceHTMLPreview"],
    [join(uiSrc, "lib/markdownMath.ts"), "@streamdown/math"],
    [join(uiSrc, "lib/chat/diffEngine.ts"), "@git-diff-view/file"],
    [join(uiSrc, "pages/chat/useComposerStt.ts"), "@liveagent/ui/lib/stt/audio"],
  ];
  for (const [file, specifier] of expectations) {
    const dynamicImports = new Set();
    walkSyntaxTree(parseTypeScriptSource(readFileSync(file, "utf8"), file), (node) => {
      if (node.type === "ImportExpression") dynamicImports.add(node.source.value);
      if (node.type === "CallExpression" && node.callee.type === "Import") {
        dynamicImports.add(node.arguments[0]?.value);
      }
    });
    assert.ok(dynamicImports.has(specifier), `${relative(file)} lazy-loads ${specifier}`);
  }
});

test("the source entry leaves preload selection to the bundler", () => {
  const sourceHtml = readFileSync(join(webRoot, "index.html"), "utf8");
  assert.doesNotMatch(sourceHtml, /modulepreload/);
});
