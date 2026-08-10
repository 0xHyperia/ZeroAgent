# LiveAgent vX.Y.Z 同步报告

- 上游 Release：`Stack-Cairn/LiveAgent@vX.Y.Z`
- Peeled Commit：`<sha>`
- ZeroAgent 基线：`<sha>`
- 合并分支：`codex/sync-liveagent-X.Y.Z`
- 状态：`analyzing` | `adapting` | `validated` | `proposed` | `merged`

## 用户价值

说明这个上游 Release 能为 ZeroAgent 用户带来什么。除非已经确认相关能力可从某个 ZeroAgent
端实际使用，否则不得直接复制上游 Release Notes。

## 决策清单

| 上游变化 | 文件及所有权 | 决策 | ZeroAgent 适配与原因 | 回归测试 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 示例 | `path/**`（`adapted`） | `adapt` | 采用新实现，同时保持账户隔离 | `test/path` | `pending` |

决策值只能使用：`adopt`、`adapt`、`replace`、`partial`、`reject`、`defer`。

## 安全与数据

记录认证、授权、Secret 暴露、账户隔离、存储结构、迁移、回滚和公开发布影响。只有逐项检查后
才能填写“无”。

## 维护成本

列出删除的本地代码、新增的长期差异、所有权变化，以及为什么最终方案比保留旧实现更容易
维护或更安全。

## 验证结果

记录执行的准确命令和结果。区分本机环境限制和产品失败。每个语义冲突以及被上游触及的
ZeroAgent 自有行为都必须有回归测试。

## 延后事项

列出有意延后或拒绝的上游变化、负责人、重新评估条件，以及继续等待的影响。
