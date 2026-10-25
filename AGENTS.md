# ZeroAgent 仓库协作指引

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

提出上游合并前，必须运行 `node scripts/check-zeroagent-product-contract.mjs` 以及同步技能
验证矩阵要求的检查。除非用户单独授权，否则不得发布、打标签、推送或合并。
