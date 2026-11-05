import type {
  MentionComposerDraft,
  MentionComposerSkill,
} from "@liveagent/ui/components/chat/MentionComposer";
import type {
  ExtensionCatalog,
  ExtensionPackage,
  ExtensionRevision,
  ExtensionsAdapter,
} from "@liveagent/ui/features/extensions/extensionTypes";
import { extensionSkillEnabled } from "@liveagent/ui/features/extensions/extensionTypes";
import { buildTextFromComposerDraft } from "@liveagent/ui/lib/chat/composerDraft";
import {
  extensionDisplayName,
  extensionSearchText,
  extensionSkillDisplayName,
} from "@liveagent/ui/lib/extensions/presentation";
import { accountFetch, captureAccountRequestGuard } from "./accountRequest";

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function revisionValid(value: unknown): value is ExtensionRevision {
  return (
    record(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    Number.isSafeInteger(value.number) &&
    record(value.files) &&
    Object.values(value.files).every((body) => typeof body === "string") &&
    Array.isArray(value.skills) &&
    value.skills.every(skillValid) &&
    (value.aliases === undefined ||
      (record(value.aliases) &&
        Object.keys(value.aliases).length <= 20 &&
        Object.values(value.aliases).every((target) => typeof target === "string")))
  );
}
function skillValid(value: unknown) {
  return (
    record(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    typeof value.entry === "string"
  );
}
export function parseExtensionCatalog(value: unknown): ExtensionCatalog {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 0 ||
    !Array.isArray(value.packages) ||
    value.packages.length > 104 ||
    !value.packages.every(
      (pkg) =>
        record(pkg) &&
        typeof pkg.id === "string" &&
        (pkg.kind === "plugin" || pkg.kind === "skill") &&
        (pkg.visibility === "public" || pkg.visibility === "personal") &&
        typeof pkg.owned === "boolean" &&
        !(pkg.visibility === "public" && pkg.owned) &&
        typeof pkg.name === "string" &&
        typeof pkg.description === "string" &&
        typeof pkg.publisher === "string" &&
        Number.isSafeInteger(pkg.version) &&
        typeof pkg.installed === "boolean" &&
        typeof pkg.enabled === "boolean" &&
        typeof pkg.builtin === "boolean" &&
        Array.isArray(pkg.skills) &&
        pkg.skills.length > 0 &&
        (pkg.kind !== "skill" || pkg.skills.length === 1) &&
        pkg.skills.every(skillValid) &&
        (pkg.legacy_skills === undefined ||
          (Array.isArray(pkg.legacy_skills) &&
            pkg.legacy_skills.length <= 4096 &&
            pkg.legacy_skills.every(
              (legacy: unknown) =>
                record(legacy) &&
                typeof legacy.name === "string" &&
                typeof legacy.description === "string" &&
                Number.isSafeInteger(legacy.version) &&
                (legacy.version as number) > 0 &&
                (legacy.version as number) < (pkg.version as number),
            ))) &&
        (pkg.disabled_skills === null ||
          (Array.isArray(pkg.disabled_skills) &&
            pkg.disabled_skills.every((name: unknown) => typeof name === "string"))) &&
        (pkg.examples === null ||
          (Array.isArray(pkg.examples) &&
            pkg.examples.every((text: unknown) => typeof text === "string"))),
    )
  )
    throw new Error("技能目录响应无效，请刷新重试。");
  return value as unknown as ExtensionCatalog;
}
class ExtensionRequestRejected extends Error {}
async function request(path: string, init?: RequestInit) {
  const guard = captureAccountRequestGuard();
  const response = await accountFetch(`/api/web-chat/extensions${path}`, {
    credentials: "include",
    ...init,
  });
  const body = await response.text();
  guard();
  if (body.length > 2 << 20) throw new Error("技能响应过大。");
  let result: unknown;
  try {
    result = JSON.parse(body);
  } catch {
    throw new Error("技能服务暂不可用，请重试。");
  }
  if (!response.ok) {
    const Rejection =
      response.status >= 400 && response.status < 500 ? ExtensionRequestRejected : Error;
    if (response.status === 409)
      throw new Rejection("其他页面已修改技能。当前编辑已保留，请重新打开技能后合并修改。");
    throw new Rejection(
      record(result) && record(result.error) && typeof result.error.message === "string"
        ? result.error.message
        : record(result) && typeof result.error === "string"
          ? result.error
          : record(result) && typeof result.message === "string"
            ? result.message
            : "技能操作未完成，请刷新目录确认结果。",
    );
  }
  return result;
}
export function createCloudExtensionsAdapter(scope: string): ExtensionsAdapter {
  let writeUnconfirmed = false;
  let generation = 0;
  let writing = false;
  async function write(path: string, payload: unknown) {
    if (writeUnconfirmed) throw new Error("上次保存结果尚未确认。编辑已保留，请先刷新目录核对。");
    if (writing) throw new Error("正在保存，请稍候。");
    writing = true;
    generation++;
    try {
      return parseExtensionCatalog(
        await request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
    } catch (cause) {
      if (cause instanceof ExtensionRequestRejected) throw cause;
      writeUnconfirmed = true;
      generation++;
      throw new Error("保存结果尚未确认。编辑已保留，请先刷新目录核对，不要重复提交。", { cause });
    } finally {
      writing = false;
    }
  }
  return {
    scope,
    get writeUnconfirmed() {
      return writeUnconfirmed;
    },
    async list(signal) {
      const readingGeneration = generation;
      const catalog = parseExtensionCatalog(await request("", { signal }));
      if (readingGeneration === generation && !writing) writeUnconfirmed = false;
      return catalog;
    },
    async read(id, signal) {
      const value = await request(`/${encodeURIComponent(id)}`, { signal });
      if (!record(value) || !revisionValid(value.revision) || !Number.isSafeInteger(value.version))
        throw new Error("技能文件响应无效。");
      return { revision: value.revision, version: value.version as number };
    },
    async mutate(expected, input) {
      if (input.action === "save" && !input.revision) throw new Error("请填写技能内容。");
      // Revision numbers and timestamps are assigned by the server. In particular,
      // a new editor draft has no RFC3339 timestamp to send over the wire.
      const payload =
        input.action === "save" && input.revision
          ? {
              ...input,
              revision: {
                name: input.revision.name,
                description: input.revision.description,
                files: input.revision.files,
                skills: input.revision.skills,
                ...(input.revision.aliases ? { aliases: input.revision.aliases } : {}),
              },
            }
          : input;
      return write("", { ...payload, expected_version: expected });
    },
    async importArchive(expected, file, kind) {
      if (file.size > 350_000)
        throw new Error("ZIP 文件不能超过 350 KB，展开后的文本不能超过 256 KB。");
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return write("/import", { expected_version: expected, archive: btoa(binary), kind });
    },
    async download(id) {
      const guard = captureAccountRequestGuard();
      const response = await accountFetch(
        `/api/web-chat/extensions/${encodeURIComponent(id)}?download=true`,
        { credentials: "include" },
      );
      if (!response.ok) throw new Error("下载失败，请重试。");
      const blob = await response.blob();
      guard();
      if (blob.size > 512 << 10) throw new Error("技能包过大。");
      return blob;
    },
  };
}
export function cloudComposerSkills(catalog: ExtensionCatalog | null): MentionComposerSkill[] {
  return [...(catalog?.packages ?? [])]
    .sort((a, b) => Number(b.id === "skill-creator") - Number(a.id === "skill-creator"))
    .flatMap((pkg) =>
      pkg.skills
        .filter((skill) => extensionSkillEnabled(pkg, skill))
        .map((skill) => ({
          name: skill.name,
          displayName:
            pkg.kind === "plugin" && skill.name === pkg.skills[0]?.name
              ? extensionDisplayName(pkg)
              : extensionSkillDisplayName(pkg, skill),
          searchText: extensionSearchText(pkg, skill),
          description: skill.description,
          skillFile: `zeroagent-skill:${pkg.id}/${pkg.version}/${skill.name}`,
          baseDir: "cloud",
          legacyReferences: (pkg.legacy_skills ?? []).map((legacy) => ({
            name: legacy.name,
            description: legacy.description,
            skillFile: `zeroagent-skill:${pkg.id}/${legacy.version}/${legacy.name}`,
          })),
        })),
    );
}
export function buildCloudComposerText(draft: MentionComposerDraft) {
  return buildTextFromComposerDraft({
    ...draft,
    segments: draft.segments.map((segment) =>
      segment.type === "skillMention" &&
      /^zeroagent-skill:[a-z0-9-]+\/[1-9][0-9]*\/[a-z0-9-]+$/.test(segment.skill.skillFile)
        ? {
            type: "text" as const,
            text: `[${(segment.skill.displayName || segment.skill.name).replace(/[\\[\]]/g, "\\$&")}](${segment.skill.skillFile})`,
          }
        : segment,
    ),
  });
}
/** @ selects packages; explicit slash workflows and clipboard validation retain all enabled skills. */
export function cloudComposerExtensions(catalog: ExtensionCatalog | null): MentionComposerSkill[] {
  return (catalog?.packages ?? []).flatMap((pkg) => {
    const primary = pkg.skills[0];
    if (!primary || !extensionSkillEnabled(pkg, primary)) return [];
    const skill = cloudPackageSkill(pkg, primary.name);
    return skill
      ? [{ ...skill, displayName: extensionDisplayName(pkg), description: pkg.description }]
      : [];
  });
}
export function cloudPackageSkill(pkg: ExtensionPackage, name?: string) {
  return cloudComposerSkills({ version: 0, packages: [pkg] }).find(
    (skill) => !name || skill.name === name,
  );
}
