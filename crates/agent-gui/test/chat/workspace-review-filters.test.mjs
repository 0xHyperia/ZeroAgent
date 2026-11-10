import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const requireFromUi = createRequire(new URL("../../../agent-ui/package.json", import.meta.url));
const { filterReviewHunks } = createTsModuleLoader().loadModule(
  "@liveagent/ui/components/project-tools/git-review/workspaceReviewDiff.ts",
);

function patchHeader(path) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`].join("\n");
}

function replaceSingleLine(path, lineNumber, before, after) {
  return [
    patchHeader(path),
    `@@ -${lineNumber} +${lineNumber} @@`,
    `-${before}`,
    `+${after}`,
    "",
  ].join("\n");
}

test("import filtering accepts multiline imports with trailing comments and added blank lines", () => {
  const path = "source.ts";
  const oldImport = ['import {', '  original,', '} from "./lib"; // label'];
  const newImport = ['import {', '  current,', '} from "./lib"; // label', ''];
  const padding = Array(11).fill("");
  const before = [...oldImport, ...padding, "const value = 1;", ""].join("\n");
  const after = [...newImport, ...padding, "const value = 2;", ""].join("\n");
  const codeHunk = "@@ -15 +16 @@\n-const value = 1;\n+const value = 2;\n";
  const patch = [
    patchHeader(path),
    "@@ -1,3 +1,4 @@",
    ...oldImport.map((line) => `-${line}`),
    ...newImport.map((line) => `+${line}`),
    codeHunk,
  ].join("\n");
  const options = { hideImports: true, contents: { before, after } };
  assert.equal(filterReviewHunks(patch, path, options), `${patchHeader(path)}\n${codeHunk}`);
  assert.equal(
    filterReviewHunks(patch, path, {
      ...options,
      annotatedLines: [{ side: "new", lineNumber: 3 }],
    }),
    patch,
  );
});

test("import filtering preserves mixed, malformed, nested, partial and newly created changes", () => {
  const path = "source.ts";
  for (const [before, after, expected] of [
    ['import A from "a"; run(A);', 'import B from "b"; run(B);', true],
    ["import A from ;", "import B from ;", true],
    ['const text = `import A from "a";`;', 'const text = `import B from "b";`;', true],
    ['import A from "a";', 'import B from "b";', false],
  ]) {
    const patch = replaceSingleLine(path, 1, before, after);
    assert.equal(filterReviewHunks(patch, path, { hideImports: true }), patch);
    assert.equal(
      filterReviewHunks(patch, path, { hideImports: true, contents: { before, after } }),
      expected ? patch : null,
    );
  }
  const added = [
    "diff --git a/source.ts b/source.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/source.ts",
    "@@ -0,0 +1 @@",
    '+import A from "a";',
    "",
  ].join("\n");
  assert.equal(
    filterReviewHunks(added, path, {
      hideImports: true,
      contents: { before: "", after: 'import A from "a";\n' },
    }),
    added,
  );
});

test("import filtering uses the packaged grammar decisions for Python, Rust, Go and Java", () => {
  for (const [language, extension, header, before, after, hidden] of [
    ["python", "py", "", "import math", "import sys", true],
    ["python", "py", "def run():\n", "    import math", "    import sys", false],
    ["rust", "rs", "", "use crate::old;", "use crate::new;", true],
    ["rust", "rs", "", "extern crate old;", "extern crate new;", true],
    ["rust", "rs", "", "pub use crate::old;", "pub use crate::new;", false],
    ["go", "go", "package example\n", 'import "fmt"', 'import "log"', true],
    ["java", "java", "package example;\n", "import java.util.List;", "import java.util.Set;", true],
  ]) {
    const path = `source.${extension}`;
    const patch = replaceSingleLine(path, header ? 2 : 1, before, after);
    const importParser = requireFromUi(`@lezer/${language}`).parser;
    assert.equal(
      filterReviewHunks(patch, path, {
        hideImports: true,
        contents: { before: `${header}${before}\n`, after: `${header}${after}\n` },
        importParser,
      }),
      hidden ? null : patch,
      `${language}: ${before}`,
    );
  }
});
