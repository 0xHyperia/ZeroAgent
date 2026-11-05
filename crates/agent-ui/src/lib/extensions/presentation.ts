import createPlugin from "../../assets/extensions/create-plugin.webp";
import createSkill from "../../assets/extensions/create-skill.webp";
import generateImage from "../../assets/extensions/generate-image.webp";
import productDesign from "../../assets/extensions/product-design.webp";

type PresentedPackage = {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  visibility: string;
};
type PresentedSkill = { name: string; description: string };

/** Display metadata only. Package names, skill names and immutable references remain unchanged. */
const builtins: Record<
  string,
  { name: string; alias: string; image: string; overview: string; skills: Record<string, string> }
> = {
  "product-design": {
    name: "产品设计",
    alias: "Product Design",
    image: productDesign,
    overview:
      "把产品想法变成清楚的用户流程、可比较的视觉方案和可运行的界面。可以从需求研究、体验审查、设计探索或已有参考开始，沿用你的品牌与组件规范，完成桌面和手机布局，并核对实际交互。提供截图、需求或项目文件，即可继续当前工作。",
    skills: {
      "product-design": "产品设计",
      index: "产品设计",
      "get-context": "明确设计任务",
      "user-context": "产品上下文",
      research: "研究需求",
      audit: "审查体验",
      ideate: "探索设计",
      "image-to-code": "从设计图实现",
      "url-to-code": "从网页实现",
      "design-qa": "验证设计",
      share: "保存与分享",
      "design-research": "研究需求",
      "design-audit": "审查体验",
      "design-ideate": "探索设计",
      "design-implement": "实现设计",
      "design-verify": "验证设计",
      "design-share": "分享成果",
      "skill-creator": "创建技能",
    },
  },
  imagegen: {
    name: "生成图像",
    alias: "ImageGen Image Generation",
    image: generateImage,
    overview:
      "把想法变成图片，也可以根据参考图修改构图、主体与风格。描述用途和希望看到的画面，或提供需要保留的参考；生成结果会保存在资料空间，后续修改保留原件。生图模型在图像创作设置中独立选择。",
    skills: { imagegen: "生成图像" },
  },
  "plugin-creator": {
    name: "创建插件",
    alias: "Plugin Creator",
    image: createPlugin,
    overview:
      "把经常重复的一组工作整理成个人插件。从你的目标和现有工作说明开始，梳理主流程、辅助技能与交付标准，生成可以检查和导入的插件包。也可以完善自己创建的插件，保留已经有效的方法。",
    skills: {
      "plugin-creator": "创建插件",
      "create-plugin": "创建插件",
      "update-plugin": "完善插件",
      "prepare-plugin-submission": "准备插件提交",
    },
  },
  "skill-creator": {
    name: "创建技能",
    alias: "Skill Creator",
    image: createSkill,
    overview:
      "把一个好用的方法保存为可复用的技能。通过对话明确什么时候使用、需要什么资料、如何完成以及怎样检查结果，整理成可以阅读和导入的技能包；适合重复写作、分析、整理和检查等任务。",
    skills: { "skill-creator": "创建技能" },
  },
};

function builtin(pkg: PresentedPackage) {
  return pkg.builtin && pkg.visibility === "public" ? builtins[pkg.id] : undefined;
}
export function extensionDisplayName(pkg: PresentedPackage) {
  return builtin(pkg)?.name ?? pkg.name;
}
export function extensionOverview(pkg: PresentedPackage) {
  return builtin(pkg)?.overview ?? pkg.description;
}
export function extensionSkillDisplayName(pkg: PresentedPackage, skill: PresentedSkill) {
  return builtin(pkg)?.skills[skill.name] ?? skill.name;
}
export function extensionSearchText(pkg: PresentedPackage, skill?: PresentedSkill) {
  return [
    extensionDisplayName(pkg),
    builtin(pkg)?.alias,
    pkg.name,
    pkg.id,
    pkg.description,
    skill?.name,
    skill?.description,
    skill && extensionSkillDisplayName(pkg, skill),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}
export function extensionImage(id: string) {
  return builtins[id]?.image;
}
export function extensionReferencePresentation(reference: string) {
  const match = /^zeroagent-skill:([a-z0-9-]+)\/[1-9][0-9]*\/([a-z0-9-]+)$/.exec(reference);
  if (!match) return undefined;
  const brand = builtins[match[1]],
    name = brand?.skills[match[2]];
  return brand && name ? { name, image: brand.image } : undefined;
}
