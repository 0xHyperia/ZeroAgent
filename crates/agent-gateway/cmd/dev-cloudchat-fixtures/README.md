# CloudChat 本地验收数据

这是开发者 CLI，没有 HTTP 测试开关或鉴权旁路。所有对话标注“合成验收数据”，不代表真实模型或工具执行证据。默认 `core` 配置只插入终态消息和公开过程；显式 `complete` 配置另含未发送队列、服务端草稿及真实本地成果原件。两个配置都不会调用模型、E2B、ClaimCloudRun，不会创建活动 Run、执行租约或沙箱。

默认仅生成清单，不连接数据库：

```powershell
go run ./cmd/dev-cloudchat-fixtures --user-id 1
```

统一联调阶段再显式执行。先启动新版开发 Gateway 初始化新增列，将回环 PostgreSQL URL 放入 `ZEROAGENT_POSTGRES_DSN` 或 `DATABASE_URL`，不要把密钥写入命令或提交。`--receipt` 的父目录须已经存在；保存此清单，后续运行使用同一路径和相同参数。

```powershell
go run ./cmd/dev-cloudchat-fixtures --user-id 1 --apply --receipt D:/local-test/cloudchat-conversations.json --base-url http://127.0.0.1:52386/ --space-receipt D:/local-test/space-seed-receipt.json
```

`--space-receipt` 可省略。指定时只引用清单中本账号现存的文件，写入前核对数据库中的所有者、名字、MIME、大小和摘要；不会重新上传或修改文件。

覆盖：

- 多轮思考、工具状态、Markdown 表格及代码；完成、失败、停止、未知外部结果。
- 60 份分页会话、置顶及归档；搜索“后页星河计划”命中目录后页。
- 72 条历史消息；搜索“旧页蓝鲸锚点”定位首条消息，检查上下文的双向加载。
- 超过默认页面预算的长正文和长过程；分别按需读取，折叠预览不挂载全部文本。
- fork、edit、regenerate 的持久来源关系，原会话保持不变。
- 可选的已有资料原件引用，检查预览、返回会话及手机布局。

命令通过命名空间生成确定性 ID 和内容指纹。所有插入使用参数化事务；不会更新或删除已存在的会话。重新运行返回 `already_present`、`preserved_user_changes`，或根据本地清单保留用户后来删除的会话（`preserved_deleted`）。保持清单用于区分“尚未创建”和“用户删除”；清单与账号/数据定义不匹配时拒绝运行。输出含会话 URL、首尾消息 ID 和指纹，可用于最后的浏览器联调。

此数据覆盖持久阅读与管理，不替代真实流式生成、断线恢复、取消或外部工具验收。运行中场景应走真实 Run 协议，不能通过本 CLI 伪造活动任务。

## 完整功能样例

`complete` 在上述数据之外增加三份可操作会话：

| 会话 | 验收操作 |
| --- | --- |
| 成果保留与站点版本 | 同轮思考/正文交替、5 个工具成果入口；打开 Word 和多工作表 Excel；比较同一站点的两个不可变版本；私有预览、用户主动创建/撤销分享；来源行号定位；后续处理失败时成果继续可用 |
| 待发送队列 | 3 条带编辑器快照的待发送内容；包含已有文件和站点版本引用；打开页面保持暂停；编辑、重排、删除、取回输入框；明确点击发送才走正常模型授权 |
| 服务端草稿恢复 | 工作模式、文字、文档和表格成果引用、模型/思考参数；刷新与跨页面恢复；正常 CAS 保存、冲突处理。只创建此专用会话的草稿，不触碰用户当前 `blank` 草稿 |

计划生成只读取指定的本地样例及 receipt，不连接 PostgreSQL、Redis、S3 或模型。`--samples-dir` 为原 20 文件样例的 `files` 目录，Word/Excel 大小和 SHA256 必须匹配 receipt：

```powershell
go run ./cmd/dev-cloudchat-fixtures --user-id 1 --profile complete `
  --space-receipt D:/code/usa0/src/ZeroAgent/.codex-artifacts/local-dev-20261026/acceptance-20261031/seed-receipt.json `
  --samples-dir D:/code/usa0/src/ZeroAgent/.codex-artifacts/local-dev-20261026/acceptance-20261031/files
```

统一联调时在同一命令后追加 `--apply --receipt D:/local-test/cloudchat-complete.json`。须使用不同于 `core` 的 receipt。环境变量沿用 Gateway 的 `ZEROAGENT_OBJECT_STORAGE_*`，其中 endpoint 必须是**字面回环 IP**的本地 SeaweedFS/S3 地址；拒绝远端端点、DNS 主机名及重定向。不会创建桶或调整用户配额。PostgreSQL 也只接受回环地址。先启动更新后的 Gateway 初始化正式 schema。

成果对象经 `cloudbackup.S3.PutIfAbsent` 的条件写能力验证后写入，上传后回读完整字节核对 SHA、大小、MIME；已有不同内容绝不覆盖。同样的固定 ID/对象键用于未知上传结果的重试，事务失败产生的原件保留在这些确定性键上以便同计划核对，不做自动清理。站点 ZIP 由 `cloudsite.Inspect` 校验，不包含远端脚本或网络请求；不预先生成分享授权。

`ReserveCloudArtifact` 的正式发布入口要求活动 lease，不适用于合成数据。因此只有这个独立 CLI 使用参数化事务插入终态 `synthetic-local-fixture` Run 和 `succeeded` 工具记录，以维持真实的账号/会话/来源关系。其 input 明确写明未执行模型、E2B 或联网；`attempt=0`、无 session 凭据、无 lease，任何 worker 都无法领取。原件与资料空间配额共用正式账号锁及计数，来源、草稿也检查正式配额；站点 manifest、来源持久化记录和终态公开事件保持一致。

队列输入使用正式 `MemoryStore.MutateCloudPendingQueue` 归一化，草稿使用正式 `WriteCloudPrivateDraft` 验证，再在开发数据事务内写入。事务只新增本命名空间的内容，唯一更新是正常分配草稿账号 revision。已有完整样例返回 `preserved_existing_bundle`，整组保留，包括后来编辑的队列、草稿和删掉的单个成果，绝不自动补回。receipt 输出各资源固定 ID、站点版本、队列项 ID、草稿 scope 与会话地址。

本阶段只实现及编译；最终联调再统一运行测试、plan/apply、幂等重跑、私有预览及用户主动分享验证。
