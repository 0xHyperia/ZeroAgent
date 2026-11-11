import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function runtimeNodeModules() {
  const envName = "RUNTIME_NODE_MODULES";
  const nodeModules = process.env[envName];
  if (!nodeModules) {
    throw new Error("RUNTIME_NODE_MODULES is required.");
  }
  if (!path.isAbsolute(nodeModules)) {
    throw new Error(`${envName} must be an absolute path.`);
  }
  const stat = await fs.stat(nodeModules).catch(() => undefined);
  if (!stat?.isDirectory()) {
    throw new Error(`${envName} is not a directory: ${nodeModules}`);
  }
  return nodeModules;
}

async function runtimeRequire() {
  const nodeModules = await runtimeNodeModules();
  return {
    nodeModules,
    requireFromRuntime: createRequire(path.join(nodeModules, "__runtime__.cjs")),
  };
}

export async function requireRuntimeModule(packageName) {
  const { nodeModules, requireFromRuntime } = await runtimeRequire();
  try {
    if (packageName === "skia-canvas") {
      const entry = requireFromRuntime.resolve("@oai/artifact-tool");
      return createRequire(entry)(packageName);
    }
    return requireFromRuntime(packageName);
  } catch (error) {
    throw new Error(`Could not resolve ${packageName} from runtime node_modules: ${nodeModules}`, {
      cause: error,
    });
  }
}

export async function importRuntimeModule(packageName) {
  const { nodeModules, requireFromRuntime } = await runtimeRequire();
  let entrypoint;
  try {
    entrypoint = requireFromRuntime.resolve(packageName);
  } catch (error) {
    throw new Error(`Could not resolve ${packageName} from runtime node_modules: ${nodeModules}`, {
      cause: error,
    });
  }
  return import(pathToFileURL(entrypoint).href);
}
