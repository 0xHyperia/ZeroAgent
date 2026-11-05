# 本机 Codex 插件与技能分析及 ZeroAgent 适配

2026-11-05 直接读取本机缓存中的 manifest、SKILL.md、references 和相关文本资源。分析对象是安装产物，不修改用户 Codex 配置；本报告不把截图中未观察到的交互当成已实现能力。

## 本机定义与分类

| 对象 | 实际定义 | ZeroAgent 适配 |
| --- | --- | --- |
| Product Design 0.1.56 | 插件下 10 个设计流程，没有 skill-creator | 产品设计插件，主入口 index，按任务转到具体流程 |
| Plugin Creator 0.1.28 | create-plugin、update-plugin、prepare-plugin-submission | 创建插件，3 个流程；独立技能创建分流 |
| imagegen | `.codex/skills/.system/imagegen/SKILL.md` | 独立“生成图像”技能，调用已有图像工具 |
| skill-creator | `.codex/skills/.system/skill-creator/SKILL.md` | 独立“创建技能”，指导产出可导入指令包 |
| Figma 17.0.0 | 16 个技能，设计、代码和专用 MCP 能力分层 | 采用流程与工具能力分离的结构；未添加 Figma 连接 |
| Mobbin 1.5.0 | 4 个技能，搜索与重设计有明确前置条件 | 设计参考先核对可用工具，缺能力时使用用户提供的证据 |
| Sites 1.1.3 | 2 个技能，网站制作与 remix | 使用已有私有站点发布能力，不虚构 Sites 服务连接 |
| Pages 0.1.26 | 4 个页面/空间工作流 | 文档方法与资料工具分离，不把指令注册为外部应用 |
| Work Pets 0.1.6 | 3 个生命周期技能 | 作为封装边界参考；本次没有增加宠物能力 |
| StitchDesign 2.0.0 | 2 个技能，路由与设计规范分工 | 参考主入口路由和内部依赖分工，不要求无关任务加载全部资料 |

路径根为 `C:/Users/25834/.codex/plugins/cache/openai-curated-remote/`；系统技能路径见表。可复查的 manifest 示例为 `product-design/0.1.56/.codex-plugin/plugin.json`、`plugin-creator/0.1.28/plugin.json`。本次完整清单及各入口 SHA-256 保存在本地验收目录 `local-plugin-inventory.json`。

Product Design 的实际成员：index、get-context、user-context、research、audit、ideate、image-to-code、url-to-code、design-qa、share。前一实现将创建技能一起打包，造成成员归属混乱；现已移出当前产品设计定义，旧固定引用仍可读取旧发布内容。

## 封装与调用规则

本机存在根 portable `plugin.json` 和兼容 `.codex-plugin/plugin.json` 两种封装。manifest 描述包与入口，SKILL.md 描述触发条件和方法；references、scripts、assets 是辅助资源。一个辅助文档不等于一个可调用技能。插件提供一项用户可识别的入口，具体流程按需读取；工具连接和应用视图由宿主提供权限及运行能力。

本机 manifest 将 `composerIcon` 与 `logo` 分开声明：它们服务于小尺寸行内引用与大尺寸目录展示。ZeroAgent 继续复用 ExtensionMark、既有原创品牌资产、相同图标容器和行内引用样式，确保列表、详情、输入框来自同一身份。不会从系统图标库任意为每个出现位置挑选不同图标，也不复制 OpenAI、Figma 等品牌资产冒充其连接。

ZeroAgent 当前导入的是指令包。支持 manifest 指定技能目录、主技能和辅助文件，不执行脚本，也不接受 manifest 声明的新 MCP、应用或 hooks 权限。创建插件流程必须说明这些边界，交付可检查的包；准备公开提交流程只提供检查结果，不承诺已经发布或审核通过。

## 工作流与体验落实

产品设计按“任务与上下文 → 有证据的研究/审查或方案 → 实现 → 实际交互与视觉核验”分流。生成图像区分新图和编辑，保留参考身份、原图和不确定请求的恢复边界。创建技能限定清晰触发条件、可执行步骤和必要资源；创建插件在包层组织多个相关技能。

中文名称、包级 @、独立技能目录与统一列表组件沿用现有设计。当前产品设计显示 10 个相关流程，创建插件显示 3 个；生成图像和创建技能出现在技能目录，插件内部流程保留在插件详情。生图技能详情保留配置入口，能返回当前工作区。

模型菜单的配置入口、宿主范围、草稿保存及云端真实标题执行见 `model-preferences-ux.md` 与 ADR 0072。界面是否完成以实际流程和截图为准，不以能保存字段或构建成功代替体验验收。

实现与测试位于 `cloud_extension_manifest.go`、`cloud_extension_manifest_test.go`、当前 `skills/` 及不可变 `skills-releases/`。本次未把本机所有插件移植为完整服务集成；依赖专用工具的功能仍需要对应能力接入。
