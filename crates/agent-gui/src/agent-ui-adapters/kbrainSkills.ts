import { hasFrozenCapability, readKBrainHealthResponse } from "@liveagent/ui/lib/kbrain/health";
import type { SkillsResourceAdapter } from "@liveagent/ui/lib/resourceHost";
import { normalizeClawHubSkillCard } from "@liveagent/ui/lib/skills/clawHub";
import type { SystemManageSkillResponse } from "@liveagent/ui/lib/skills/index";
import {
  configurationVersionHeaders,
  readKBrainConfiguration,
} from "../lib/kbrain/configurationVersion";
import { fetchKBrain } from "../lib/kbrain/transport";

/** K-brain capability: skills nested in skill packs, `packs` in skills settings. */
export const KBRAIN_SKILL_PACKS_CAPABILITY = "skill_packs";

/** Resource-page seam for K-brain-managed Skills. */
export function createKbrainSkillsAdapter(fetchImpl?: typeof fetch): SkillsResourceAdapter {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetchKBrain(path, init, fetchImpl ? { fetch: fetchImpl } : {});
    if (!response.ok) {
      const error = new Error(
        (await response.text()) || `ZeroAgent engine skills request failed (${response.status})`,
      );
      Object.assign(error, { status: response.status });
      throw error;
    }
    return readKBrainConfiguration<T>(response);
  };

  return {
    list: async (workdir) => {
      const result = await request<Awaited<ReturnType<SkillsResourceAdapter["list"]>>>(
        `/v1/skills${workdir ? `?workdir=${encodeURIComponent(workdir)}` : ""}`,
      );
      if (
        typeof result.rootDir !== "string" ||
        !Array.isArray(result.skills) ||
        typeof result.settings?.enabled !== "boolean" ||
        !Array.isArray(result.settings.selected)
      )
        throw new Error("Invalid ZeroAgent engine skills list response");
      return result;
    },
    manage: async (body) => {
      const result = await request<SystemManageSkillResponse>("/v1/skills/manage", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (result.installJob?.phase === "completed") result.installJob.phase = "done";
      if (result.external) {
        result.external = result.external.map((scan) => ({
          ...scan,
          tool:
            scan.tool === "skills"
              ? /(?:^|[\\/])\.claude[\\/]skills$/.test(scan.rootDir)
                ? "claude-code"
                : /(?:^|[\\/])\.codex[\\/]skills$/.test(scan.rootDir)
                  ? "codex"
                  : /(?:^|[\\/])\.agents[\\/]skills$/.test(scan.rootDir)
                    ? "agents"
                    : scan.rootDir
              : scan.tool,
          skills: scan.skills ?? [],
          errors: scan.errors ?? [],
        }));
      }
      return result;
    },
    settings: async (body, baseline) => {
      if (body.packs !== undefined) {
        const response = await fetchKBrain(
          "/v1/health",
          undefined,
          fetchImpl ? { fetch: fetchImpl } : {},
        );
        const health = await readKBrainHealthResponse(response);
        if (!hasFrozenCapability(health, KBRAIN_SKILL_PACKS_CAPABILITY)) {
          throw new Error("The current execution host does not support skill packs");
        }
      }
      return request("/v1/skills/settings", {
        method: "PUT",
        headers: configurationVersionHeaders(baseline?.configurationVersion),
        body: JSON.stringify(body),
      });
    },
    read: (path, offset = 0, length = 200) =>
      request(`/v1/skills/file?path=${encodeURIComponent(path)}&offset=${offset}&length=${length}`),
    storeSearch: async (params) => {
      const query = new URLSearchParams();
      if (params.query) query.set("q", params.query);
      if (params.cursor) query.set("cursor", params.cursor);
      if (params.ownerHandle) query.set("ownerHandle", params.ownerHandle);
      if (params.limit !== undefined) query.set("limit", String(params.limit));
      if (params.sort) query.set("sort", params.sort);
      const result = await request<{ results: unknown[] | null; nextCursor?: string }>(
        `/v1/skills/store/search?${query}`,
      );
      if (result.results !== null && !Array.isArray(result.results)) {
        throw new Error("Invalid ZeroAgent engine skills store response");
      }
      const items = (result.results ?? []).map((raw) => {
        const card = normalizeClawHubSkillCard(raw);
        if (!card) throw new Error("Invalid ZeroAgent engine skills store item");
        return card;
      });
      return { items, nextCursor: result.nextCursor || null };
    },
    storeInstall: (body) =>
      request("/v1/skills/store/install", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  };
}

export const kbrainSkillsAdapter = createKbrainSkillsAdapter();
