import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const requireUi = createRequire(new URL("../../../agent-ui/package.json", import.meta.url));
const streamdown = await import(
  new URL("../../../agent-ui/node_modules/@streamdown/code/dist/index.js", import.meta.url)
);
const loader = createTsModuleLoader({ mocks: { "@streamdown/code": streamdown } });
const catalog = loader.loadModule("@liveagent/ui/lib/sourceLanguages.ts");
const { getSyntaxHighlighter } = loader.loadModule("@liveagent/ui/lib/syntaxHighlighter.ts");

test("the complete bundled catalog loads and tokenizes using real TextMate grammars in both themes", async () => {
  const highlighter = await getSyntaxHighlighter();
  assert.ok(catalog.sourceLanguages.length >= 235);
  for (const language of catalog.sourceLanguages) {
    await highlighter.loadLanguage(language.id);
    for (const theme of ["github-light", "github-dark"]) {
      const tokens = highlighter.codeToTokensBase("const value = 42; // syntax smoke", {
        lang: language.id,
        theme,
      });
      assert.ok(tokens[0]?.length, language.id + " / " + theme);
    }
    for (const alias of [language.id, ...language.aliases])
      assert.equal(catalog.normalizeSourceLanguage(alias.toUpperCase()), language.id, alias);
  }
});

test("source language detection covers framework, compiled, script, configuration and extensionless files", () => {
  const cases = {
    "a.vue": "vue",
    "a.svelte": "svelte",
    "a.astro": "astro",
    "a.tsx": "tsx",
    "a.jsx": "jsx",
    "a.py": "python",
    "a.R": "r",
    "a.exs": "elixir",
    "a.erl": "erlang",
    "a.hs": "haskell",
    "a.fsx": "fsharp",
    "a.rs": "rust",
    "a.go": "go",
    "a.dart": "dart",
    "a.zig": "zig",
    "a.c": "c",
    "a.hpp": "cpp",
    "a.cs": "csharp",
    "a.tfvars": "terraform",
    "a.toml": "toml",
    "a.psm1": "powershell",
    "a.zsh": "shellscript",
    "a.gd": "gdscript",
    "a.sv": "system-verilog",
    "a.wat": "wasm",
    "a.sass": "sass",
    "a.blade.php": "blade",
    "a.html.erb": "erb",
    "C:\\project\\Dockerfile.dev": "dockerfile",
    Makefile: "make",
    "CMakeLists.txt": "cmake",
    "Cargo.lock": "toml",
    ".env.test": "dotenv",
    ".gitignore": "plaintext",
    Jenkinsfile: "groovy",
  };
  for (const [name, id] of Object.entries(cases))
    assert.equal(catalog.resolveSourceLanguage(name), id, name);
  assert.equal(
    catalog.resolveSourceLanguage("script", "text/plain", "#!/usr/bin/env python3\nprint(1)"),
    "python",
  );
  assert.equal(catalog.resolveSourceLanguage("blob", "application/ld+json"), "json");
  assert.equal(catalog.resolveSourceLanguage("blob", "text/x-rust"), "rust");
  assert.equal(catalog.sourceLanguageForName("program.wasm"), undefined);
  assert.equal(catalog.sourceLanguageForName("binary.exe"), undefined);
  for (const name of ["unknown.xyz", "constructor", "__proto__", "test.constructor"])
    assert.equal(catalog.resolveSourceLanguage(name), "plaintext", name);
});

test("namespaced Monaco providers keep native grammar services and themes intact, with multiline and embedded tokens", async (t) => {
  let dark = false;
  const previous = globalThis.document;
  globalThis.document = { documentElement: { classList: { contains: () => dark } } };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const providers = new Map(),
    registered = [],
    themes = new Map();
  const monaco = {
    languages: {
      getLanguages: () => [{ id: "typescript" }, ...registered],
      register: (entry) => registered.push(entry),
      setTokensProvider(id, provider) {
        providers.set(id, provider);
        return { dispose: () => providers.delete(id) };
      },
    },
    editor: { defineTheme: (name, data) => themes.set(name, data) },
  };
  const { prepareSourceSyntax, refreshSourceSyntax } = loader.loadModule(
    "@liveagent/ui/lib/sourceSyntax.ts",
  );
  const [first, second] = await Promise.all([
    prepareSourceSyntax("tsx", monaco),
    prepareSourceSyntax("tsx", monaco),
  ]);
  assert.equal(first, second);
  assert.equal(first, "zeroagent-source-tsx");
  assert.equal(registered.length, 1);
  assert.equal(providers.has("typescript"), false);
  assert.equal(themes.get("vs").inherit, true);
  assert.ok(themes.get("vs").rules.every((rule) => rule.token.startsWith("za-source-")));
  assert.ok(
    themes
      .get("vs")
      .rules.every((rule) => /^(?:[0-9a-f]{6}|[0-9a-f]{8})$/.test(rule.foreground)),
  );
  const samples = {
    python: [
      '""" multiline',
      "still a comment",
      '"""',
      "def run(value):",
      "    return value + 1",
    ],
    vue: [
      '<script setup lang="ts">',
      "const count: number = 1",
      "</script>",
      "<template><div>{{ count }}</div></template>",
    ],
    tsx: ["/* multiline", "comment */", "const view = <div value={42}>hello</div>;"],
    rust: ["fn main() {", '    println!("hello");', "}"],
  };
  for (const [id, lines] of Object.entries(samples)) {
    const key = await prepareSourceSyntax(id, monaco),
      provider = providers.get(key);
    let state = provider.getInitialState();
    const scopes = new Set();
    assert.ok(state.equals(state.clone()));
    for (const line of lines) {
      const result = provider.tokenize(line, state);
      state = result.endState;
      result.tokens.forEach((token) => scopes.add(token.scopes));
    }
    assert.ok(scopes.size > 2, id);
  }
  const provider = providers.get(first),
    state = provider.getInitialState();
  const light = provider.tokenize('const value = "color";', state).tokens;
  dark = true;
  refreshSourceSyntax(monaco);
  const night = providers.get(first).tokenize('const value = "color";', state).tokens;
  assert.notDeepEqual(light, night);
  const long = providers.get(first).tokenize("a".repeat(20001), state);
  assert.equal(long.endState, state);
  assert.deepEqual(long.tokens, [{ startIndex: 0, scopes: "" }]);
});

test("Markdown fenced code uses the same full grammar engine and normalizes aliases", async () => {
  const { throttledCodePlugin } = loader.loadModule(
    "@liveagent/ui/lib/markdownCodeHighlight.ts",
  );
  assert.ok(throttledCodePlugin.supportsLanguage("svelte"));
  assert.ok(throttledCodePlugin.supportsLanguage("C++"));
  const result = await new Promise((resolve) =>
    throttledCodePlugin.highlight(
      {
        code: '<script lang="ts">\nlet count: number = 1\n</script>',
        language: "vue",
        themes: ["github-light", "github-dark"],
      },
      resolve,
    ),
  );
  assert.equal(result.tokens.length, 3);
  assert.ok(
    result.tokens
      .flat()
      .some((token) => token.htmlStyle?.color && token.htmlStyle?.["--shiki-dark"]),
  );
  assert.equal(requireUi("shiki/package.json").version, "3.23.0");
});
