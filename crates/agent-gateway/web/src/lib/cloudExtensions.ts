import type { MentionComposerSkill } from "@liveagent/ui/components/chat/MentionComposer";
import type { MentionComposerExtensionDetails } from "@liveagent/ui/components/chat/MentionComposerModel";
import type {
  ExtensionCatalog,
  ExtensionPackage,
  ExtensionRevision,
  ExtensionsAdapter,
} from "@liveagent/ui/features/extensions/extensionTypes";
import {
  ExtensionRevisionUnavailable,
  extensionComposerEntry,
  extensionSkillEnabled,
} from "@liveagent/ui/features/extensions/extensionTypes";
import type { Locale } from "@liveagent/ui/i18n/hostTranslations";

export { buildTextFromComposerDraft as buildCloudComposerText } from "@liveagent/ui/lib/chat/composerDraft";

import {
  extensionDescription,
  extensionDisplayName,
  extensionSearchText,
  extensionSkillDescription,
  extensionSkillDisplayName,
  parseExtensionReference,
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
    typeof value.entry === "string" &&
    (value.display_name === undefined || typeof value.display_name === "string")
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
        (pkg.overview === undefined || typeof pkg.overview === "string") &&
        (pkg.unavailable_apps === undefined ||
          (Array.isArray(pkg.unavailable_apps) &&
            pkg.unavailable_apps.every(
              (app: unknown) =>
                record(app) && typeof app.name === "string" && typeof app.description === "string",
            ))) &&
        Number.isSafeInteger(pkg.version) &&
        typeof pkg.installed === "boolean" &&
        typeof pkg.enabled === "boolean" &&
        typeof pkg.builtin === "boolean" &&
        (pkg.native === undefined || typeof pkg.native === "boolean") &&
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
class ExtensionRequestRejected extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
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
    const message =
      response.status === 409
        ? "其他页面已修改技能。当前编辑已保留，请重新打开技能后合并修改。"
        : record(result) && record(result.error) && typeof result.error.message === "string"
          ? result.error.message
          : record(result) && typeof result.error === "string"
            ? result.error
            : record(result) && typeof result.message === "string"
              ? result.message
              : "技能操作未完成，请刷新目录确认结果。";
    if (response.status >= 400 && response.status < 500)
      throw new ExtensionRequestRejected(message, response.status);
    throw new Error(message);
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
    async read(id, signal, revision) {
      const query = revision === undefined ? "" : `?revision=${revision}`;
      const value = await request(`/${encodeURIComponent(id)}${query}`, { signal }).catch(
        (cause: unknown) => {
          if (
            cause instanceof ExtensionRequestRejected &&
            (cause.status === 403 || cause.status === 404)
          ) {
            throw new ExtensionRevisionUnavailable(cause.message);
          }
          throw cause;
        },
      );
      if (!record(value) || !revisionValid(value.revision) || !Number.isSafeInteger(value.version))
        throw new Error("技能文件响应无效。");
      return { revision: value.revision, version: value.version as number };
    },
    async readDraft(id, signal) {
      const value = await request(`/drafts/${encodeURIComponent(id)}`, { signal });
      if (
        !record(value) ||
        (value.kind !== "plugin" && value.kind !== "skill") ||
        !revisionValid(value.revision) ||
        (value.target_id !== undefined &&
          (typeof value.target_id !== "string" ||
            typeof value.base_revision !== "number" ||
            !Number.isSafeInteger(value.base_revision) ||
            value.base_revision < 1))
      )
        throw new Error("对话草稿暂不可用。");
      return {
        kind: value.kind,
        revision: value.revision,
        target_id: typeof value.target_id === "string" ? value.target_id : undefined,
        base_revision: typeof value.base_revision === "number" ? value.base_revision : undefined,
      };
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
const draftUUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
export function extensionDraftFromLink(path: string) {
  return new RegExp(`^cloud-extension-drafts/(${draftUUID})$`, "i").exec(path)?.[1];
}
export function linkExtensionDraftCitations(text: string) {
  return text.replace(
    new RegExp(`【自定义草稿:(${draftUUID})】`, "gi"),
    "[审阅草稿](cloud-extension-drafts/$1)",
  );
}
export function cloudComposerSkills(
  catalog: ExtensionCatalog | null,
  locale: Locale = "zh-CN",
): MentionComposerSkill[] {
  return [...(catalog?.packages ?? [])]
    .sort((a, b) => Number(b.id === "skill-creator") - Number(a.id === "skill-creator"))
    .flatMap((pkg) =>
      pkg.skills
        .filter((skill) => extensionSkillEnabled(pkg, skill))
        .map((skill) => ({
          name: skill.name,
          ...(pkg.builtin && pkg.id === skill.name ? { builtIn: true } : {}),
          displayName:
            skill.name === pkg.skills[0]?.name
              ? extensionDisplayName(pkg, locale)
              : extensionSkillDisplayName(pkg, skill, locale),
          searchText: extensionSearchText(pkg, skill),
          description: extensionSkillDescription(pkg, skill, locale),
          skillFile: `zeroagent-skill:${pkg.id}/${pkg.version}/${skill.name}`,
          baseDir: "cloud",
          legacyReferences: (pkg.legacy_skills ?? []).map((legacy) => ({
            name: legacy.name,
            description: extensionSkillDescription(pkg, legacy, locale),
            displayName: extensionSkillDisplayName(pkg, legacy, locale),
            skillFile: `zeroagent-skill:${pkg.id}/${legacy.version}/${legacy.name}`,
          })),
        })),
    );
}
export function cloudComposerSlashSkills(
  catalog: ExtensionCatalog | null,
  locale: Locale = "zh-CN",
) {
  return cloudComposerExtensions(catalog, locale, "skill");
}

/** The @ menu lists one entry per plugin; slash uses standalone skills. */
export function cloudComposerExtensions(
  catalog: ExtensionCatalog | null,
  locale: Locale = "zh-CN",
  kind: ExtensionPackage["kind"] = "plugin",
): MentionComposerSkill[] {
  return (catalog?.packages ?? []).flatMap((pkg) => {
    const primary = extensionComposerEntry(pkg);
    if (!primary || pkg.kind !== kind) return [];
    const skill = cloudPackageSkill(pkg, primary.name, locale);
    return skill ? [{ ...skill, description: extensionDescription(pkg, locale) }] : [];
  });
}
export function cloudPackageSkill(pkg: ExtensionPackage, name?: string, locale?: Locale) {
  return cloudComposerSkills({ version: 0, packages: [pkg] }, locale).find(
    (skill) => !name || skill.name === name,
  );
}

export async function prepareDeviceSkillMention(
  pkg: ExtensionPackage,
  skill: ExtensionPackage["skills"][number],
  revision: number,
  locale: Locale,
  signal: AbortSignal,
): Promise<MentionComposerSkill> {
  const guard = captureAccountRequestGuard();
  const params = new URLSearchParams({ revision: String(revision), skill: skill.name });
  const response = await accountFetch(
    `/api/web-chat/extensions/device-compatibility/${encodeURIComponent(pkg.id)}?${params}`,
    { signal },
  );
  if (response.body) void response.body.cancel().catch(() => undefined);
  signal.throwIfAborted();
  guard();
  if (response.status !== 204) {
    const messages = {
      401: [
        "Sign in on this computer to use account skills.",
        "请先在此电脑登录，以使用账户技能。",
      ],
      403: [
        "Sign in on this computer to use account skills.",
        "请先在此电脑登录，以使用账户技能。",
      ],
      404: [
        "This skill revision is no longer available. Check its status in Customize.",
        "此技能修订已不可用。请在自定义中检查安装与启用状态。",
      ],
      413: ["This skill exceeds the device context limit.", "此技能的资料超出了设备上下文限制。"],
      422: [
        "This skill requires tools or files unavailable on this computer.",
        "此技能需要此电脑无法使用的工具或文件。",
      ],
    } as Record<number, [string, string]>;
    const message = messages[response.status] ?? [
      "The device skill could not be checked. Try again.",
      "暂时无法检查设备技能，请重试。",
    ];
    throw new Error(message[locale === "en-US" ? 0 : 1]);
  }
  return {
    name: skill.name,
    displayName:
      pkg.kind === "skill"
        ? extensionDisplayName(pkg, locale)
        : extensionSkillDisplayName(pkg, skill, locale),
    description: extensionSkillDescription(pkg, skill, locale),
    baseDir: "cloud",
    skillFile: `zeroagent-skill:${pkg.id}/${revision}/${skill.name}`,
  };
}

export function cloudExtensionMention(
  catalog: ExtensionCatalog | null,
  reference: string,
  locale: Locale,
): (MentionComposerExtensionDetails & { packageId: string; skillName?: string }) | undefined {
  const target = parseExtensionReference(reference);
  const pkg = catalog?.packages.find((item) => item.id === target?.packageId);
  if (!target || !pkg || target.version > pkg.version) return undefined;
  const skill = pkg.skills.find((item) => item.name === target.skillName);
  const legacy = pkg.legacy_skills?.find(
    (item) => item.name === target.skillName && item.version === target.version,
  );
  const named = skill ?? legacy;
  const availability = !pkg.installed
    ? "not-installed"
    : !pkg.enabled || pkg.disabled_skills?.includes(target.skillName)
      ? "disabled"
      : undefined;
  if (!named) {
    // The catalog only includes executable archived members. The package state is still known.
    return availability && target.version < pkg.version
      ? { packageId: pkg.id, skillName: target.skillName, availability }
      : undefined;
  }
  const primary = named === pkg.skills[0];
  return {
    packageId: pkg.id,
    skillName: skill && skill !== pkg.skills[0] ? skill.name : undefined,
    label: primary
      ? extensionDisplayName(pkg, locale)
      : extensionSkillDisplayName(pkg, named, locale),
    description: primary
      ? extensionDescription(pkg, locale)
      : extensionSkillDescription(pkg, named, locale),
    ...(availability ? { availability } : {}),
  };
}
