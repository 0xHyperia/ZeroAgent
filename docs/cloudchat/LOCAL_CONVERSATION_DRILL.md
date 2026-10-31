# CloudChat 本地对话协议演练

这条独立演练使用真实 Gateway HTTP 路由、会话鉴权、Run 调度、SSE 与历史持久化逻辑；模型输出、沙箱 SDK 和对象存储由测试进程内的 loopback 服务提供。所有内容均为“合成验收数据”。它用于核对产品协议，不代表真实模型质量、E2B 兼容性或生产部署验收。

## 运行方式

在 `crates/agent-gateway` 下执行：

```powershell
go test ./internal/account -run '^TestCloudConversationLocalDrill$' -count=1 -v -timeout=60s
```

2026-10-31 已在集中联调中执行该演练，3 个子场景全部通过，总耗时 0.40 秒。结果来自实际行为测试日志，非仅编译检查；模型、SDK 与对象存储仍是下述隔离 loopback 服务。

## 本次执行证据

本机证据目录为 `.codex-artifacts/cloudchat-conversation-final-20261031/`：
`account-final.jsonl` 保存逐项执行日志，`backend-result.json` 汇总各独立用例的最后执行结果。该目录为本机验收产物，不将其中合成 Run ID 当作用户开发数据。

| 已执行子场景 | 日志事实 |
| --- | --- |
| `disconnect_replay_history_and_idempotency` | 通过；模型仅调用 1 次，初始读取 6 帧，从游标 7 重放 3 帧，最终序号 10，历史保留 2 个内容块 |
| `explicit_stop_keeps_partial_history` | 通过；终态 `cancelled`，重放 8 帧，历史保留 2 个内容块 |
| `published_output_survives_following_model_failure` | 通过；模拟后续模型失败后终态为 `failed`，3 次模型调用，重放 23 帧，历史保留 4 个内容块；已发布成果仍可下载，内容校验通过 |

同期后端回归汇总如下。数量采用叶用例口径，不重复计算父测试与其子测试：

| 范围 | 通过叶用例 | 跳过 | 汇总中未解决失败 |
| --- | ---: | ---: | ---: |
| `internal/account` | 491 | 3 | 0 |
| `internal/cloudbackup` | 13 | 3 | 0 |

`account-final.jsonl` 的整包进程曾因 PostgreSQL JSONB 键顺序导致队列幂等判断失败而非零退出。修复后在 `pending-fixed.jsonl` 定向重跑相关测试并通过；上表按最终独立用例结果去重汇总，不表示修复后重新跑过整个包。`cloudbackup-final.jsonl` 整包执行通过。上述统计不包含汇总生成后的额外定向测试。

以下 6 项在本批仍为实际跳过，不能视为通过：

- `TestCloudRunArchiveActualGuestCodePatchAndDurableZIP`：需要 Linux `renameat2` 与资源限制。
- `TestCloudRunSiteActualGuestSeaweedFSDelivery`：未启用显式隔离的 SeaweedFS 站点交付夹具。
- `TestPersistentDeviceNameSurvivesRestart`：未设置该测试要求的独立可丢弃 PostgreSQL 与 Redis 地址。
- `TestCloudBackupIsolatedPostgresRedisS3Recovery`：缺少完整独立 PostgreSQL、Redis、Node 与 PostgreSQL 工具链夹具。
- `TestRestoreUnsupportedConditionalServiceStopsBeforeDatabaseAuthAndFormalWritesPostgres`：缺少独立 PostgreSQL、Redis、Node 与 PostgreSQL 工具链夹具。
- `TestCloudBackupSeaweedFSRecovery`：未启用可丢弃的 SeaweedFS 恢复夹具。

本记录证明本地协议演练和列明的后端回归结果，不据此声明真实模型、E2B、完整存储灾备或生产部署已验收通过。

## 演练覆盖

| 场景 | 真实请求与检查 |
| --- | --- |
| 断开与恢复 | POST Run；SSE 收到部分正文后关闭查看连接；模型继续；使用 `Last-Event-ID` 重连；确认事件连续、正文不重复，最终状态一致 |
| 重复提交 | 同一个 `client_request_id` 与相同请求体重试；返回原 Run，模型调用次数不增加 |
| 主动停止 | 通过取消 API 停止仍在输出的模型；核对下游 HTTP context 取消、部分正文保留、终态 SSE 可重放 |
| 成果后失败 | 真实工具流程写文件、发布成果，再模拟后续模型 HTTP 失败；历史消息、完整 Run 和 SSE 均保留成功工具及不可变成果引用 |
| 历史与下载 | 通过单消息 API 和消息分页读取完整 `presentation`；按成果版本 ID 下载并校验精确内容 |
| 账户边界 | 第二个账户无法读取 Run、原消息或下载成果；公开过程不含执行凭据、原工具参数或模型原始报错 |

通过时，每个场景打印一行 `local-drill-evidence` JSON，包含合成数据标记、场景、Run ID、事件数量、模型调用次数和相应状态。日志不包含会话 Cookie 或服务密钥。失败时命令返回非零状态；不能将仅编译通过标记为演练通过。

## 隔离边界

- 存储使用新建 `MemoryStore`，不是开发环境 PostgreSQL；其 Runner 只处理本测试创建的队列。
- 用户、会话和模型授权均为内存合成记录；HTTP 请求仍经过正式 session middleware。
- 模型、SDK、对象存储均通过已有测试依赖注入指向临时 loopback HTTP 服务，不修改生产 API，不新增 fake flag、路由开关或鉴权旁路。
- 不使用现有本地开发队列、账户余额、E2B、Tavily 或远端存储，也不向开发验收数据中插入正在运行的任务。
- 所有测试服务由测试生命周期关闭。静态验收数据仍由独立 `cmd/dev-cloudchat-fixtures` 管理，不能混淆为真实执行证据。

相关实现：`internal/account/cloud_conversation_drill_test.go`；复用 `cloud_run_http_test.go`、`cloud_run_tools_test.go` 与 `cloud_file_http_test.go` 中的隔离测试依赖。
