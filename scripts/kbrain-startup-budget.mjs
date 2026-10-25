// Match ADR 0011's Windows production startup grace. Other platforms retain each fixture's
// existing readiness/overall budgets. Request, ACK, cancellation and model deadlines stay separate.
import { isAbsolute } from "node:path";

export function kbrainStartupTimeoutMs(previousMs = 20_000) {
  return process.platform === "win32" ? 60_000 : previousMs;
}

export function kbrainFixtureTimeoutMs(previousTotalMs, starts = 1, previousStartupMs = 20_000) {
  return previousTotalMs + starts * Math.max(0, kbrainStartupTimeoutMs(previousStartupMs) - previousStartupMs);
}

export function isolatedKbrainFixtureEnv(root, extra = {}) {
  if (!isAbsolute(root)) throw new Error("K-brain fixture root must be absolute");
  return {
    ...process.env, ...extra,
    HOME:root, USERPROFILE:root,
    LIVEAGENT_HOME:root, K_BRAIN_HOME:"", LIVEAGENT_KBRAIN_PROXY:"direct",
  };
}
