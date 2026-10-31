import { Sandbox } from "@e2b/code-interpreter";
import type { SandboxAccess } from "./sandbox-access.ts";
import { sdkOptions } from "./sdk-options.ts";

/** Construct an SDK client without any control-plane connect/resume request. */
export function codeSession(access: SandboxAccess, apiKey: string): Sandbox {
  return new Sandbox({ ...sdkOptions(apiKey), ...access });
}
