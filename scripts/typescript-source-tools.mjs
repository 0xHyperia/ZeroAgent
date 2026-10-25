import { pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import { transformSync } from "@babel/core";
import transformTypeScript from "@babel/plugin-transform-typescript";
import transformJsx from "@babel/plugin-transform-react-jsx";
import transformModules from "@babel/plugin-transform-modules-commonjs";

export function parseTypeScriptSource(source, fileName) {
  const supportsJsx = /\.[cm]?[jt]sx$/i.test(fileName);
  return parse(source, {
    sourceFilename: fileName,
    sourceType: "module",
    createParenthesizedExpressions: true,
    plugins: supportsJsx ? ["typescript", "jsx"] : ["typescript"],
  });
}

const NON_CHILD_KEYS = new Set([
  "comments",
  "errors",
  "extra",
  "innerComments",
  "leadingComments",
  "loc",
  "tokens",
  "trailingComments",
]);

export function walkSyntaxTree(node, visitor) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walkSyntaxTree(child, visitor);
    return;
  }
  if (typeof node.type !== "string") return;

  visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (NON_CHILD_KEYS.has(key)) continue;
    walkSyntaxTree(child, visitor);
  }
}

export function staticStringValue(node) {
  // DirectiveLiteral: Babel lifts prologue strings ("use strict"-style
  // statements) out of ExpressionStatement, unlike the TypeScript AST.
  if (node?.type === "StringLiteral" || node?.type === "DirectiveLiteral") return node.value;
  if (node?.type !== "TemplateLiteral" || node.expressions.length > 0) return undefined;
  return node.quasis[0]?.value.cooked ?? node.quasis[0]?.value.raw;
}

function loaderFor(filePath) {
  const extension = filePath.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (extension === ".tsx") return "tsx";
  if (extension === ".jsx") return "jsx";
  if ([".js", ".mjs", ".cjs"].includes(extension)) return "js";
  return "ts";
}

// Share compiler output, never evaluated module state or mocks, between test loaders.
const transpilationCache = new Map();
const MAX_TRANSPILE_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_TRANSPILE_CACHE_ENTRIES = 256;
let transpilationCacheBytes = 0;

function sourceWithTestImportMeta(source, filePath) {
  if (!source.includes("import.meta")) return source;
  const ast = parseTypeScriptSource(source, filePath);
  const spans = [];
  walkSyntaxTree(ast, (node) => {
    if (node.type === "MetaProperty" && node.meta.name === "import" && node.property.name === "meta") {
      spans.push([node.start, node.end]);
    }
  });
  if (spans.length === 0) return source;
  let binding = "__zeroagent_test_import_meta";
  while (source.includes(binding)) binding += "_";
  let output = source;
  for (const [start, end] of spans.sort((a, b) => b[0] - a[0])) {
    output = output.slice(0, start) + binding + output.slice(end);
  }
  const offset = Math.max(ast.program.interpreter?.end ?? 0, ast.program.directives.at(-1)?.end ?? 0);
  return output.slice(0, offset) + `\nconst ${binding} = {url:${JSON.stringify(pathToFileURL(filePath).href)}};\n` + output.slice(offset);
}

export function transpileTypeScriptModule(source, filePath) {
  const cached = transpilationCache.get(filePath);
  if (cached?.source === source) {
    transpilationCache.delete(filePath);
    transpilationCache.set(filePath, cached);
    return cached.code;
  }
  try {
    const loader = loaderFor(filePath);
    // The synchronous esbuild worker can block module evaluation for tens of
    // seconds on Windows. Keep source-only tests in-process; production builds
    // and the separate typecheck retain their own compilers.
    const code = transformSync(sourceWithTestImportMeta(source, filePath), {
      babelrc: false,
      configFile: false,
      filename: filePath,
      // Some render regressions compile an extracted function body for new Function.
      parserOpts: { allowReturnOutsideFunction: true },
      plugins: [
        ...(loader === "ts" || loader === "tsx" ? [[transformTypeScript, { isTSX: loader === "tsx", allowDeclareFields: true }]] : []),
        ...(loader === "jsx" || loader === "tsx" ? [[transformJsx, { runtime: "automatic" }]] : []),
        transformModules,
      ],
    }).code;
    const bytes = Buffer.byteLength(source) + Buffer.byteLength(code);
    if (cached) {
      transpilationCache.delete(filePath);
      transpilationCacheBytes -= cached.bytes;
    }
    if (bytes <= MAX_TRANSPILE_CACHE_BYTES) {
      transpilationCache.set(filePath, { source, code, bytes });
      transpilationCacheBytes += bytes;
      while (transpilationCache.size > MAX_TRANSPILE_CACHE_ENTRIES || transpilationCacheBytes > MAX_TRANSPILE_CACHE_BYTES) {
        const oldest = transpilationCache.keys().next().value;
        transpilationCacheBytes -= transpilationCache.get(oldest).bytes;
        transpilationCache.delete(oldest);
      }
    }
    return code;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to transpile ${filePath}: ${detail}`, { cause: error });
  }
}
