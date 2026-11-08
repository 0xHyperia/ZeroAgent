import createPlugin from "../../assets/extensions/create-plugin.webp";
import createSkill from "../../assets/extensions/create-skill.webp";
import generateImage from "../../assets/extensions/generate-image.webp";
import productDesign from "../../assets/extensions/product-design.webp";
import type { ExtensionTryResult } from "../../features/extensions/extensionTypes";
import type { Locale } from "../../i18n/hostTranslations";
import { parseExtensionReference } from "./reference";

export { parseExtensionReference } from "./reference";

export function extensionTryError(result: Exclude<ExtensionTryResult, "accepted">, locale: Locale) {
  const labels = {
    "conversation-unavailable": [
      "此对话暂时无法添加技能。请在对话可编辑后重试。",
      "This conversation cannot accept a skill right now. Try again when it is ready to edit.",
    ],
    "skill-unavailable": [
      "此技能暂不可用。请确认已安装并启用后重试。",
      "This skill is unavailable. Check that it is installed and enabled, then try again.",
    ],
    "draft-reference-conflict": [
      "草稿已引用此包的其他修订或技能。请移除原引用后再试。",
      "Your draft already references another revision or skill from this package. Remove that reference and try again.",
    ],
  };
  return labels[result][locale === "en-US" ? 1 : 0];
}

type PresentedPackage = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  visibility: string;
  publisher?: string;
  overview?: string;
  native?: boolean;
  examples?: readonly string[];
};
type PresentedSkill = { name: string; description: string; display_name?: string };
type SkillCopy = readonly [
  chineseName: string,
  chineseDescription: string,
  englishName: string,
  englishDescription: string,
];

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
    starterCopy: Readonly<Record<string, string>>;
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
    starterCopy: {
      "Audit this product flow using my screenshots": "根据我的截图审查这个产品流程",
      "Explore three directions for this feature": "为这项功能探索三种设计方向",
      "Build an interactive prototype from this reference": "根据这份参考实现可交互原型",
    },
    skills: {
      "product-design": [
        "产品设计",
        "探索设计、审查流程，或构建并验证交互原型。",
        "Product Design",
        "Explore designs, audit user flows, or build and verify interactive prototypes.",
      ],
      index: [
        "产品设计",
        "探索设计、审查流程，或在 ZeroAgent 中构建并验证交互原型。",
        "Product Design",
        "Explore designs, audit user flows, or build and verify interactive prototypes in ZeroAgent.",
      ],
      "get-context": [
        "明确设计任务",
        "开始设计前，确认目标、受众、参考资料和交付内容。",
        "Define the design task",
        "Confirm the goal, audience, references, and deliverables before designing.",
      ],
      "user-context": [
        "产品上下文",
        "从已授权的项目与会话资料中查找相关产品规范。",
        "Product context",
        "Find product guidelines in authorized project and conversation materials.",
      ],
      research: [
        "研究需求",
        "利用用户提供的证据和获准使用的公开资料研究产品问题。",
        "Design research",
        "Research product questions using supplied evidence and permitted public sources.",
      ],
      audit: [
        "审查体验",
        "依据截图等实际界面证据审查用户流程，并按影响排列体验问题。",
        "Experience audit",
        "Review user flows against screenshots and other interface evidence, then prioritize issues.",
      ],
      ideate: [
        "探索设计",
        "根据已确认的需求探索多个有明确差异、可以比较的设计方向。",
        "Explore designs",
        "Explore distinct, comparable design directions based on the confirmed brief.",
      ],
      "image-to-code": [
        "从设计图实现",
        "将附带的视觉参考实现为响应式交互原型。",
        "Build from a design",
        "Build a responsive, interactive prototype from the supplied visual reference.",
      ],
      "url-to-code": [
        "从网页实现",
        "依据获准使用的公开网页证据构建可运行的前端原型。",
        "Build from a website",
        "Build a runnable frontend prototype from permitted public web evidence.",
      ],
      "design-qa": [
        "验证设计",
        "交付前对照实际视觉证据核验原型，并记录结果。",
        "Design QA",
        "Check the prototype against visual evidence before handoff and record the result.",
      ],
      share: [
        "保存与分享",
        "将产品设计成果交付为 ZeroAgent 私人站点，并报告核验状态。",
        "Save and share",
        "Deliver the design as a private ZeroAgent site and report verification status.",
      ],
      "design-research": [
        "研究需求",
        "研究用户任务、同类产品和已有规范。",
        "Design research",
        "Research user tasks, comparable products, and existing guidelines.",
      ],
      "design-audit": [
        "审查体验",
        "依据界面证据核对完整流程，并按影响排序。",
        "Experience audit",
        "Audit the full user flow against interface evidence and prioritize issues.",
      ],
      "design-ideate": [
        "探索设计",
        "探索多个有明确差异的视觉方向。",
        "Explore designs",
        "Explore distinct, comparable visual directions.",
      ],
      "design-implement": [
        "实现设计",
        "复用已有组件，将选定参考实现为响应式界面。",
        "Implement the design",
        "Implement the reference as a responsive interface using existing components.",
      ],
      "design-verify": [
        "验证设计",
        "核对视觉、交互、无障碍及不同屏幕状态。",
        "Design QA",
        "Verify visuals, interaction, accessibility, and viewport states.",
      ],
      "design-share": [
        "分享成果",
        "将已验证的成果保存为私人站点，由用户决定是否分享。",
        "Share the result",
        "Save the verified result as a private site with optional sharing.",
      ],
      "skill-creator": [
        "创建技能",
        "整理任务、触发条件和指令，生成可检查的技能包。",
        "Skill Creator",
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
    starterCopy: {
      "Create a product hero image": "为产品创建一张主视觉图",
      "Edit my reference and preserve the subject": "编辑我的参考图，保留主体",
      "Generate a transparent asset for this design": "为这项设计生成透明背景素材",
    },
    skills: {
      imagegen: [
        "生成图像",
        "使用已配置的生图模型生成或编辑图像，支持透明 PNG 素材。",
        "ImageGen",
        "Create or edit images with your configured model, including transparent PNG assets.",
      ],
    },
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
    starterCopy: {
      "Create a plugin for a task I do often": "为我经常做的一项任务创建插件",
      "Turn these instructions into a plugin": "把这些说明整理成插件",
      "Improve a plugin I own": "完善一个我自己的插件",
    },
    skills: {
      "plugin-creator": [
        "创建插件",
        "把经常重复的工作整理成个人插件。",
        "Plugin Creator",
        "Turn recurring work into a personal plugin.",
      ],
      "create-plugin": [
        "创建插件",
        "把可重复的工作流程整理成个人插件，并附上所需技能和文件。",
        "Create Plugin",
        "Turn a repeatable workflow into a personal plugin with the required skills and files.",
      ],
      "update-plugin": [
        "完善插件",
        "检查自己拥有的插件，准备针对性更新并保留其他流程和文件。",
        "Update Plugin",
        "Prepare a targeted update to a plugin you own.",
      ],
      "prepare-plugin-submission": [
        "准备插件提交",
        "验证个人插件能否导出，并准备描述、示例、依赖说明和验证步骤。",
        "Prepare a plugin submission",
        "Verify that a personal plugin can be exported and prepare its description, examples, dependencies, and verification steps.",
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
    starterCopy: {
      "Turn my instructions into a reusable skill": "把我的说明整理成可复用的技能",
    },
    skills: {
      "skill-creator": [
        "创建技能",
        "创建或修改个人技能，验证结构后交给用户审阅。",
        "Skill Creator",
        "Create or update a personal skill and validate its structure for review.",
      ],
    },
  },
};

function builtin(pkg: PresentedPackage) {
  return pkg.builtin && pkg.visibility === "public" ? builtins[pkg.id] : undefined;
}

export function builtinSkillPresentation(packageId: string, skillName: string, locale: Locale) {
  if (!Object.hasOwn(builtins, packageId)) return;
  const { skills } = builtins[packageId];
  if (!Object.hasOwn(skills, skillName)) return;
  const copy = skills[skillName];
  return locale === "en-US"
    ? { title: copy[2], description: copy[3] }
    : { title: copy[0], description: copy[1] };
}
export function usesExtensionPackagePresentation(pkg: PresentedPackage) {
  return pkg.native || pkg.publisher === "OpenAI";
}

// Some archived built-ins only published Chinese metadata. Keep available English publisher copy.
function englishBuiltinCopy(value: string | undefined) {
  return value && !/\p{Script=Han}/u.test(value) ? value : undefined;
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
  return (
    (usesExtensionPackagePresentation(pkg) && englishBuiltinCopy(pkg.description)) ||
    copy.summary[1]
  );
}
export function extensionOverview(pkg: PresentedPackage, locale: Locale = "zh-CN") {
  const copy = builtin(pkg);
  if (locale === "zh-CN" && copy) return copy.overview;
  const overview = copy ? englishBuiltinCopy(pkg.overview) : pkg.overview;
  return overview || extensionDescription(pkg, locale);
}
export function extensionStarterPrompts(pkg: PresentedPackage, locale: Locale) {
  const examples = pkg.examples ?? [];
  const translations = pkg.native && locale === "zh-CN" ? builtin(pkg)?.starterCopy : undefined;
  if (!translations) return examples;
  return examples.map((example) =>
    Object.hasOwn(translations, example) ? translations[example] : example,
  );
}
export function extensionSkillDisplayName(
  pkg: PresentedPackage,
  skill: PresentedSkill,
  locale: Locale = "zh-CN",
) {
  const copy = builtin(pkg)?.skills[skill.name];
  if (!copy) return skill.display_name || skill.name;
  return locale === "zh-CN" ? copy[0] : (englishBuiltinCopy(skill.display_name) ?? copy[2]);
}
export function extensionSkillDescription(
  pkg: PresentedPackage,
  skill: PresentedSkill,
  locale: Locale = "zh-CN",
) {
  const copy = builtin(pkg)?.skills[skill.name];
  if (!copy) return skill.description;
  if (locale === "zh-CN") return copy[1];
  return (
    (usesExtensionPackagePresentation(pkg) && englishBuiltinCopy(skill.description)) || copy[3]
  );
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
export function extensionReferencePresentation(reference: string) {
  const parsed = parseExtensionReference(reference);
  const brand = parsed ? builtins[parsed.packageId] : undefined;
  return brand ? { image: brand.image } : undefined;
}
