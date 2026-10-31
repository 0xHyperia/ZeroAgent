import { Sandbox } from "e2b";

/** Private, process-local VM access. Never include this in an operation receipt. */
export type SandboxAccess = {
  sandboxId: string;
  sandboxDomain: string;
  envdVersion: string;
  envdAccessToken?: string;
  trafficAccessToken?: string;
};

/**
 * Keep the capability returned by an explicitly authorized create/resume.
 * SDK connect is a lifecycle mutation: even without timeoutMs it extends TTL
 * by the provider's default 300 seconds and can resume a paused VM.
 */
export class WorkspaceSandbox extends Sandbox {
  access(envdVersion: string): SandboxAccess {
    return {
      sandboxId: this.sandboxId,
      sandboxDomain: this.sandboxDomain,
      envdVersion,
      envdAccessToken: this.envdAccessToken,
      trafficAccessToken: this.trafficAccessToken,
    };
  }
}
