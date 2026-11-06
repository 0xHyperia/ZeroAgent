import createPlugin from "../../assets/extensions/create-plugin.webp";
import createSkill from "../../assets/extensions/create-skill.webp";
import generateImage from "../../assets/extensions/generate-image.webp";
import productDesign from "../../assets/extensions/product-design.webp";
import type { Locale } from "../../i18n/hostTranslations";

type PresentedPackage = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  visibility: string;
  publisher?: string;
  overview?: string;
  native?: boolean;
};
type PresentedSkill = { name: string; description: string; display_name?: string };
type SkillCopy = readonly [name: string, description: string, legacyEnglish?: string];

/** Display metadata only. Package names, skill names and immutable references remain unchanged. */
const builtins: Record<
  string,
  {
    name: string;
    english: string;
    image: string;
    summary: readonly [chinese: string, legacyEnglish: string];
    overview: string;
    skills: Record<string, SkillCopy>;
  }
> = {
  "product-design": {
    name: "产品设计",
    english: "Product Design",
    image: productDesign,
    summary: [
      "研究产品问题、探索设计方向并构建交互原型。",
      "Research, design, and build interactive prototypes.",
    ],
    overview:
      "把产品想法变成清楚的用户流程、可比较的视觉方案和可运行的界面。可以从需求研究、体验审查、设计探索或已有参考开始，沿用你的品牌与组件规范，完成桌面和手机布局，并核对实际交互。提供截图、需求或项目文件，即可继续当前工作。",
    skills: {
      "product-design": ["产品设计", "探索设计、审查流程，或构建并验证交互原型。"],
      index: ["产品设计", "探索设计、审查流程，或在 ZeroAgent 中构建并验证交互原型。"],
      "get-context": ["明确设计任务", "开始设计前，确认目标、受众、参考资料和交付内容。"],
      "user-context": ["产品上下文", "从已授权的项目与会话资料中查找相关产品规范。"],
      research: ["研究需求", "利用用户提供的证据和获准使用的公开资料研究产品问题。"],
      audit: ["审查体验", "依据截图等实际界面证据审查用户流程，并按影响排列体验问题。"],
      ideate: ["探索设计", "根据已确认的需求探索多个有明确差异、可以比较的设计方向。"],
      "image-to-code": ["从设计图实现", "将附带的视觉参考实现为响应式交互原型。"],
      "url-to-code": ["从网页实现", "依据获准使用的公开网页证据构建可运行的前端原型。"],
      "design-qa": ["验证设计", "交付前对照实际视觉证据核验原型，并记录结果。"],
      share: ["保存与分享", "将产品设计成果交付为 ZeroAgent 私人站点，并报告核验状态。"],
      "design-research": [
        "研究需求",
        "研究用户任务、同类产品和已有规范。",
        "Research user tasks, comparable products, and existing guidelines.",
      ],
      "design-audit": [
        "审查体验",
        "依据界面证据核对完整流程，并按影响排序。",
        "Audit the full user flow against interface evidence and prioritize issues.",
      ],
      "design-ideate": [
        "探索设计",
        "探索多个有明确差异的视觉方向。",
        "Explore distinct, comparable visual directions.",
      ],
      "design-implement": [
        "实现设计",
        "复用已有组件，将选定参考实现为响应式界面。",
        "Implement the reference as a responsive interface using existing components.",
      ],
      "design-verify": [
        "验证设计",
        "核对视觉、交互、无障碍及不同屏幕状态。",
        "Verify visuals, interaction, accessibility, and viewport states.",
      ],
      "design-share": [
        "分享成果",
        "将已验证的成果保存为私人站点，由用户决定是否分享。",
        "Save the verified result as a private site with optional sharing.",
      ],
      "skill-creator": [
        "创建技能",
        "整理任务、触发条件和指令，生成可检查的技能包。",
        "Organize tasks, triggers, and instructions into a reviewable skill package.",
      ],
    },
  },
  imagegen: {
    name: "生成图像",
    english: "ImageGen",
    image: generateImage,
    summary: [
      "使用已配置的生图模型生成或编辑图像。",
      "Create or edit images with your configured image model.",
    ],
    overview:
      "把想法变成图片，也可以根据参考图修改构图、主体与风格。生成结果会保存在资料空间，后续修改保留原件。可在高级设置中选择生图模型。",
    skills: { imagegen: ["生成图像", "使用已配置的生图模型生成或编辑图像，支持透明 PNG 素材。"] },
  },
  "plugin-creator": {
    name: "创建插件",
    english: "Plugin Creator",
    image: createPlugin,
    summary: [
      "创建或完善包含相关技能的个人插件。",
      "Create or refine a personal plugin with related skills.",
    ],
    overview:
      "把经常重复的一组工作整理成个人插件。根据你的目标和现有说明梳理主流程、辅助技能与文件，生成待审阅的草稿。确认后可保存到个人目录，也可以用同样的方式更新自己拥有的插件。",
    skills: {
      "plugin-creator": ["创建插件", "把经常重复的工作整理成个人插件。"],
      "create-plugin": ["创建插件", "把可重复的工作流程整理成个人插件，并附上所需技能和文件。"],
      "update-plugin": [
        "完善插件",
        "检查自己拥有的插件，准备针对性更新并保留其他流程和文件。",
        "Prepare a targeted update to a plugin you own.",
      ],
      "prepare-plugin-submission": [
        "准备插件提交",
        "验证个人插件能否导出，并准备描述、示例、依赖说明和验证步骤。",
      ],
    },
  },
  "skill-creator": {
    name: "创建技能",
    english: "Skill Creator",
    image: createSkill,
    summary: ["创建或更新可重复使用的个人技能。", "Create or update a reusable personal skill."],
    overview:
      "把一个好用的方法保存为可复用的技能。通过对话明确触发条件、所需资料和验收标准，生成指令及辅助文件。审阅后可保存到个人技能目录。",
    skills: { "skill-creator": ["创建技能", "创建或修改个人技能，验证结构后交给用户审阅。"] },
  },
};

function builtin(pkg: PresentedPackage) {
  return pkg.builtin && pkg.visibility === "public" ? builtins[pkg.id] : undefined;
}
export function usesExtensionPackagePresentation(pkg: PresentedPackage) {
  return pkg.native || pkg.publisher === "OpenAI";
}
export function extensionDisplayName(pkg: PresentedPackage, locale: Locale = "zh-CN") {
  const brand = builtin(pkg);
  if (!brand) return pkg.name;
  return locale === "zh-CN" ? brand.name : brand.english;
}
export function extensionDescription(pkg: PresentedPackage, locale: Locale = "zh-CN") {
  const copy = builtin(pkg);
  if (!copy) return pkg.description;
  if (locale === "zh-CN") return copy.summary[0];
  return usesExtensionPackagePresentation(pkg) ? pkg.description : copy.summary[1];
}
export function extensionOverview(pkg: PresentedPackage, locale: Locale = "zh-CN") {
  const copy = builtin(pkg);
  if (locale === "zh-CN" && copy) return copy.overview;
  return pkg.overview || extensionDescription(pkg, locale);
}
export function extensionSkillDisplayName(
  pkg: PresentedPackage,
  skill: PresentedSkill,
  locale: Locale = "zh-CN",
) {
  const brand = builtin(pkg);
  if (locale === "zh-CN" && brand?.skills[skill.name]) return brand.skills[skill.name][0];
  if (brand && skill.name === pkg.id) return brand.english;
  return skill.display_name || skill.name;
}
export function extensionSkillDescription(
  pkg: PresentedPackage,
  skill: PresentedSkill,
  locale: Locale = "zh-CN",
) {
  const copy = builtin(pkg)?.skills[skill.name];
  if (!copy) return skill.description;
  if (locale === "zh-CN") return copy[1];
  if (usesExtensionPackagePresentation(pkg)) return skill.description;
  return copy[2] ?? (skill.name === pkg.id ? extensionDescription(pkg, locale) : skill.description);
}
export function extensionSearchText(pkg: PresentedPackage, skill?: PresentedSkill) {
  return [
    extensionDisplayName(pkg, "zh-CN"),
    extensionDisplayName(pkg, "en-US"),
    pkg.name,
    pkg.id,
    pkg.description,
    extensionDescription(pkg, "zh-CN"),
    extensionDescription(pkg, "en-US"),
    skill?.name,
    skill?.description,
    skill && extensionSkillDescription(pkg, skill, "zh-CN"),
    skill && extensionSkillDescription(pkg, skill, "en-US"),
    skill && extensionSkillDisplayName(pkg, skill, "zh-CN"),
    skill && extensionSkillDisplayName(pkg, skill, "en-US"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}
export function extensionImage(id: string) {
  return builtins[id]?.image;
}
export function parseExtensionReference(reference: string) {
  const match = /^zeroagent-skill:([a-z0-9-]+)\/([1-9][0-9]*)\/([a-z0-9-]+)$/.exec(reference);
  return match
    ? { packageId: match[1], version: Number(match[2]), skillName: match[3] }
    : undefined;
}
export function extensionReferencePresentation(reference: string) {
  const parsed = parseExtensionReference(reference);
  const brand = parsed ? builtins[parsed.packageId] : undefined;
  return brand ? { image: brand.image } : undefined;
}
