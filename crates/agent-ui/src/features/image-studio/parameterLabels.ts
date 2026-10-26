import type { ParameterSpec, Scalar } from "../../lib/imaging/types";

// Presentation only. Parameter keys and enum values keep the backend wire contract.
const labels: Record<string, string> = {
  size: "图像尺寸",
  aspectRatio: "画面比例",
  imageSize: "分辨率",
  quality: "图像质量",
  output_format: "图片格式",
  response_format: "返回方式",
  background: "背景",
  output_compression: "输出压缩",
  watermark: "水印",
  "optimize_prompt_options.mode": "提示词优化",
  seed: "随机种子",
  steps: "生成步数",
  guidance_scale: "提示词引导强度",
  cfg_scale: "提示词引导强度",
  negative_prompt: "反向提示词",
  strength: "重绘强度",
};
const options: Record<string, Record<string, string>> = {
  quality: { auto: "自动", low: "低", medium: "标准", high: "高", hd: "高清", standard: "标准" },
  background: { auto: "自动", opaque: "不透明", transparent: "透明" },
  output_format: { png: "PNG", jpeg: "JPEG", webp: "WebP" },
  response_format: { b64_json: "图片数据", url: "图片链接" },
  "optimize_prompt_options.mode": { standard: "标准", fast: "快速" },
};

export function parameterLabel(spec: ParameterSpec): string {
  return labels[spec.key] ?? (spec.label || spec.key);
}

export function parameterValueLabel(key: string, value: Scalar): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  return options[key]?.[String(value)] ?? String(value);
}
