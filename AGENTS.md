# ZeroAgent 仓库协作指引

## 前端功能与体验设计

开发或扩展前端功能前，必须阅读并遵循 `docs/design/zeroagent-cross-platform-ux.md`；
对话/工作相关功能同时阅读 `docs/design/cloudchat-chat-work-ux.md`，资料与产物相关功能同时阅读
`docs/design/cloudchat-personal-space.md`。先设计用户任务、完整流程、信息架构、桌面/手机布局和关键状态，
再确定组件复用与宿主能力适配，随后实施。复杂功能先在对应设计文档留下可评审的方案及布局/交互说明。

2026-10-31 用户明确要求后续新功能设计先行，参考其提供的豆包对话与文档/表格并排工作区、
Codex 右侧工具面板的使用体验，并保持 ZeroAgent 已确认的视觉规范。功能接通、组件测试或构建成功
不等于产品体验完成；工程验证界面不能作为最终用户界面交付。设计和实现按已有授权自主推进，
不增加逐步确认流程；明确要求先评审的任务按用户要求执行。已有功能、草稿和运行状态仍须保留。

## 产品契约与上游

修改产品行为或同步 LiveAgent 上游前，必须依次完整阅读：

1. `docs/product/PRODUCT_CONTRACT.md`
2. `docs/product/features.yaml`
3. `.github/upstream-ownership.yaml`
4. `docs/product/decisions/` 中与改动相关的决策记录
5. `.github/upstream-sync.json`
6. `docs/upstream/` 中最新且适用的同步报告

同步上游时必须使用 `sync-liveagent-release` 技能，并且只合并 Stack-Cairn/LiveAgent 已正式
发布的精确 Release，保留真实的 Git 合并祖先关系。每项实质性上游变化必须分类为
`adopt`、`adapt`、`replace`、`partial`、`reject` 或 `defer`，并记录在
`docs/upstream/vX.Y.Z.md`。

需要保持的是产品契约定义的结果，而不是已经过时的本地实现。如果上游的新实现满足全部
产品不变量、数据迁移、安全属性、支持端和回归测试，可以用它替换本地代码。禁止在没有
记录、分析和测试的情况下静默删除 ZeroAgent 功能。

本轮按 ADR 0034 以上游维护公共能力为主：上游原生能力优先，其次配置/扩展入口、独立
usa0 模块和必要最小补丁。使用独立新配置，不做旧数据迁移、旧版本回退、旧服务商归档
或额外历史协议容错；不得清除原有用户数据。新版正常持久化、备份及安全边界继续保留。

2026-10-26 用户按 ADR 0035 恢复显式旧 ZeroAgent 会话导入，并要求开放平台内的模型
参数配置；这两项以 ADR 0035 为准。固定 usa0 连接、密钥保护和账户隔离继续保留，
不扩大为旧供应商/密钥/MCP 配置迁移或第三方中转站支持。

2026-10-27 用户按 ADR 0042 授权统一对外环境变量、文案与应用存储命名，并保留当前 v2
数据；内部包名/协议与上游私有启动契约保持。该受限目录切换不属于旧版本自动迁移。

提出上游合并前，必须运行 `node scripts/check-zeroagent-product-contract.mjs` 以及同步技能
验证矩阵要求的检查。除非用户单独授权，否则不得发布、打标签、推送或合并。
