# LibreChat 参考来源

只读参考 `D:/code/usa0/src/LibreChat`，基线 `v0.8.9-rc1` / `8d3da9bbb220a0a96be9330a2e1cbd385fb786d5`。保留其版权和许可证，不修改参考仓库或引入其账号/MongoDB体系。

| 来源 | 参考结果 | ZeroAgent 实施 |
| --- | --- | --- |
| `packages/api/src/stream/GenerationJobManager.ts` | job、输出缓存、事件传输分离；进程内执行不等于持久续跑 | Go 任务存储、租约和规范历史；失联操作不自动重发 |
| `packages/api/src/stream/implementations/RedisJobStore.ts` | 断线后恢复内容和水位 | PostgreSQL 持久输出/事件，Redis 保留既有认证职责 |
| `packages/data-schemas/src/schema/message.ts`、`convo.ts` | 独立消息、父节点、内容块、模型元数据 | 当前消息存储保留，分支和结构化内容分批接入 |
| `client/src/hooks/SSE/useResumeOnLoad.ts` | 页面恢复时核对任务再续流 | Web 读取权威 Run 与事件游标 |
| `packages/api/src/files/`、`client/src/components/Artifacts/` | 文件解析、引用和产物交互 | 后续独立资源流水线与受控预览，尚未实现 |

当前新增 Go 存储/执行和 Native 传输为独立实现，不将文档特性推定为真实外部能力。直接采用的代码需在此追加具体来源、许可与适配记录。

## ADR 0049：选择性移植对话实现

2026-10-29 用户选择继续以 ZeroAgent 为主线，撤销整体 LibreChat 二开的实施方向。
固定参考版本不变，适用代码按项移植，沿用 ZeroAgent 共享 UI、Go 编排与账户/数据边界。

- 直接适配 `client/src/hooks/Messages/useMessageScrolling.ts` 的滚动方向及到达/离开滞回判定到
  `crates/agent-gateway/web/src/lib/cloudChatScrollFollow.ts`。保留 150px 到达与 24px 离开阈值，
  不引入 Jotai、LibreChat Provider 或第二套会话状态；由 ZeroAgent 已有 viewport 和 Run 流驱动。
- 来源：`LibreChat-AI/LibreChat@8d3da9bbb220a0a96be9330a2e1cbd385fb786d5`。
  原版权与 MIT 全文保存在 [third-party/LibreChat-LICENSE.txt](third-party/LibreChat-LICENSE.txt)。
- 导航与资源侧栏使用现有 ZeroAgent `ChatHeader`、`Button`、`DropdownMenu` 与 `Sheet`，
  不复制竞品视觉样式，不改动规范历史、文件归属和执行协议。

MIT 全文同时随 Web 公共资源打包至 `public/third-party/LibreChat-LICENSE.txt`，保持发行产物可读。
