# CloudChat 备份与隔离恢复候选

本工具提供可执行的维护窗口候选和隔离演练，不启动、停止或部署服务，不回退应用版本，
不自动迁移旧 journal，不把数据库 dump 单独称为完整备份。现有
`deploy/production/backup.sh` 仍只是 PostgreSQL dump，本目录不会改变其行为。

构建当前代码：

```sh
cd crates/agent-gateway
go build -o /private/tools/cloudchat-backup ./cmd/cloudchat-backup
```

运行需要当前受支持的 PostgreSQL 原生 `pg_dump`/`pg_restore` 和 Node 24.14.1。
工具只使用显式路径，不下载安装工具、不切换 Shell、不读取 AWS/E2B CLI profile。
本候选的恢复路径已在 Linux 上验证；Windows CLI 拒绝 restore/invalidate-auth。

## 完整候选包含什么

- 同一 `pg_export_snapshot()` 的 PostgreSQL custom dump，保留本应用 schema 的规范历史、
  任务、版本、引用、配额、删除意图及外部操作事实；同时记录所有应用表的行数。
- 全部未删除且已验证上传的原件，包括尚未解析或解析失败的原件；全部 ready 成果版本。
  每条都校验数据库导出的 canonical key、账户归属、MIME、大小、完整 SHA256 和 S3 owner
  metadata。按内容摘要去重保存字节，账户对应关系仍逐条保留。临时 VM 文件不算成果。
- SDK SQLite 回执的官方 backup API 快照，保留 ACK 后不可重执行的 tombstone、未知事实、
  request/scope hash、authority 及逻辑摘要。不会直接复制运行中的 SQLite/WAL 文件。
- 显式选中的当前私有配置包，以 AES-256-GCM 加密，AAD 绑定候选 ID、scope、schema 和
  SDK authority。配置中的 namespace/scope key 必须计算出与真实 journal 一致的 HMAC。
- 带组件大小/摘要的 manifest，以及用外部恢复密钥派生独立密钥签名的完整 manifest HMAC。
  只改文件与普通校验和不能绕过验证。加密与 manifest 认证分别派生密钥。

恢复密钥不写入候选。数据库、对象和 journal 本身可能含用户资料；整个候选必须放在专用
0700 目录，并使用加密备份卷、受控离线/异地存储和相应保留策略。外部 32 字节恢复密钥
须另行保管并演练取回；丢失后不能恢复私有配置或认证 manifest。不要将真实备份或私有
配置加入源码、镜像、聊天或测试日志。

## 建立维护窗口候选

1. 操作员先停止本部署的入口写入、Gateway worker/maintenance 和 SDK adapter，确认没有
   其它实例继续写同一数据库/对象命名空间。工具不会替操作员操作服务。暂停 SDK 不能当作
   已终止远程 VM；未知操作仍须保留原 ID 对账。
2. 使用一个仅含本应用表的明确 schema。表名必须是 `agents`、`zerobox_*` 或 `zeroagent_*`；
   遇到其它表会拒绝。源 PostgreSQL 角色须有该 schema 的读取、共享锁和 dump 权限。
3. 按 `config.private.example.json` 创建 0600 私有配置，使用绝对路径和真实的预期数据库名。
   配置只由 `ZEROAGENT_CLOUD_BACKUP_CONFIG` 显式指定；不回落到应用全局环境变量。
4. 将当前已审核的 Gateway/SDK 配置填入 `protected-configuration.example.json` 的私有副本。
   其中 `executor_namespace` 和 `executor_scope_key` 是权威恢复值；`files` 保存原配置正文。
   namespace、scope key 必须与当前 SDK 一致；更换内部 HTTP token 不应更换它们。可用下面的
   只读命令查看当前 authority 摘要和记录数量，无需输出密钥：

   ```sh
   /private/node/bin/node deploy/cloudchat/backup/journal.mjs verify /private/executor/receipts.sqlite
   ```

5. 在配置中填写另行生成、保存在恢复密钥库的 32 字节 Base64 密钥，确认备份卷有足够空间。
   `allow_mutations` 默认 false，建立候选无需开启数据库恢复/认证失效权限。

```sh
export ZEROAGENT_CLOUD_BACKUP_CONFIG=/private/cloudchat/source-backup.json
/private/tools/cloudchat-backup create --bundle /private/backups/new-candidate
/private/tools/cloudchat-backup verify --bundle /private/backups/new-candidate
```

源目录和候选目录必须是实际路径，拒绝 symlink/hardlink 组件、覆盖既有候选和不安全权限。
SDK 的 ownership SQLite 必须能取得独占锁，否则拒绝建立候选；锁持续到数据库/对象快照
结束。PostgreSQL 所有应用表持有 SHARE 锁，故会阻塞写入、删除意图和 DDL，这是维护窗口
方案，不是在线零停机备份。锁等待默认 5 秒，整体默认 15 分钟，最多可设 1 小时；取消会
终止本工具的子进程并释放其锁，不结束其它服务。

默认最多 100000 个正式资源、64 GiB 总逻辑组件字节；单对象仍受 32 MiB 产品限制。
可在已评估容量后设置明确上限（最多 1000000 资源、1 TiB）。dump 的实际写盘还须受备份
卷配额约束。失败留下部分目录，缺少有效且签名匹配的 manifest 不构成完整候选。

`verify` 默认只读：验证本地组件/HMAC、SQLite 完整性和配置 authority，并将数据库规范
资源集合与 manifest 比对、完整读取 S3 对象。它不恢复 Redis、不改数据库、不写对象。
数据库必须对应候选的那个快照。源服务恢复写入后，新上传/删除会使实时资源集合与旧
manifest 不同；此时应在隔离恢复数据库上验证旧候选，不能把实时差异误称为归档损坏。

## 隔离恢复并使旧认证失效

准备独立空数据库、空对象 bucket/命名空间、未存在的 SDK 目录、0700 私有恢复目录和
专用 Redis DB。目标应用入口、Gateway、SDK 均保持离线。目标 schema 名与源保持相同，
数据库名必须与源候选不同；本工具只创建恢复候选，不执行生产切流、数据库重命名或覆盖。
目标角色只应有这个恢复数据库的权限，不要对不可信 SQL 归档使用高权限角色。

创建独立的目标私有配置：设置目标连接/bucket、空 journal 路径、新的 `restored_config_path`，
保留原逻辑 scope、journal authority 及外部恢复密钥，显式设置 `allow_mutations:true`。
然后必须同时确认逻辑 scope 与物理目标数据库：

```sh
export ZEROAGENT_CLOUD_BACKUP_CONFIG=/private/cloudchat/isolated-restore.json
/private/tools/cloudchat-backup restore \
  --bundle /private/backups/new-candidate \
  --scope your-reviewed-deployment-scope \
  --database your_fresh_restore_database \
  --report /private/recovery/new-restore-report.json
```

工具拒绝有既存关系对象的目标数据库、既存 SDK/config 文件或任何目标同名 S3 key。
在授权、完整本地清单及所有空目标检查通过后，工具必须先实测这个 S3 endpoint/bucket 的
条件写行为；即使候选没有对象也不能跳过。通过前不会执行 `pg_restore`、撤销认证，或写入
正式对象、journal 和恢复配置。不能仅凭服务品牌、HTTP 成功响应或发送了条件头判定可用。
正式对象仍使用 `If-None-Match:*`，每次 PUT 后完整 GET 校验；没有 HEAD+普通 PUT 的降级。
网络中断的写入保留不确定结果，不声称未写入，也不自动更换 ID/覆盖重试。
失败保留阶段报告、数据库及已写对象，不清理证据、不重放原任务，不将部分恢复标记完成。

### 条件写能力门禁与探针清理

`ConditionalObjects.CheckRestoreWriteSemantics(ctx)` 是强制接口；直接调用备份 S3 客户端的
`PutIfAbsent` 也会经过同一门禁。`NewS3`、`create` 和默认 `verify` 不发探针写入，不会为了
检查备份而修改远端。只有显式的恢复写入操作启动探针。

探针在 `zeroagent-restore-write-probes/v1/<256bit随机hex>` 专用非 `accounts/` 命名空间中
选择一个全新键，先确认 HEAD 不存在，再写入几十字节的原始 canary 并完整 GET 校验大小、
SHA、MIME 和随机 nonce metadata。随后对同键用不同字节及 metadata 再发条件 PUT：必须
收到目标已存在的拒绝，而且完整 GET 仍为原字节及 metadata。两个条件缺一不可。

每个固定 endpoint/bucket 客户端只有一次有界 singleflight 尝试：检查最长 30 秒，清理另有
5 秒独立预算；并发等待者可独立取消。只有条件语义和归属清理全部证实才缓存为支持。
明确反例为 `conditional_writes_unsupported`；网络、超时、所有权或清理未证实为
`conditional_writes_unconfirmed`。失败在同一客户端保持原状态与 nonce，不自动重试。
显式创建新客户端是新尝试，**不会解除操作员对上一探针未完成清理的责任**。

报告在 `verify_restore_write_semantics` 阶段记录静态错误码，以及 `write_probe` 中的精确
`probe_key`、`cleanup_required`、`cleanup_confirmed`、`cleanup_code` 和已观察到的
`observed_payload`；CLI 同时输出安全诊断，不输出 URL、密钥或 SDK 原始错误。功能支持与
清理状态是两条独立事实：`conditional_writes_unsupported` **不表示清理已经完成**。
操作员必须检查 `write_probe.cleanup_required && !write_probe.cleanup_confirmed`；存在时
保留该记录，按精确键和 nonce/已知 SHA 核对，再决定受控清理，不自动重试或盲删。

自动清理只处理本次新随机键：HEAD 及完整 GET 必须共同匹配 nonce、已知原始或替换 canary
的 SHA、MIME 和 metadata，才发 DELETE，并再次 HEAD 确认不存在。遇到未知字节、外来
metadata 或异常竞争会保留对象和精确键。这个“读取核对后 DELETE”**不是原子比较删除**；
应在维护窗口保持专用命名空间不被其他写入者使用，不能声称消除了所有竞争。探针只验证
当次 endpoint/bucket 的小样本行为，正式条件请求和受控的存储配置仍不可省略。

真实 Garage v2.5.0 的最小原始试验曾在冲突 PUT 返回成功时严格失败；该失败证据保留。
修复后的真实 socket 观察确认两次 PUT 均带 `If-None-Match:*`，仍观察到私有 canary 被替换。
新门禁在重启前后都安全拒绝正式写入，并证实 canary 精确清理、正式 key 保持不存在。
这是**对真实 Garage 不兼容的安全拒绝验收**，不是“Garage 条件写支持通过”，也不是整套
真实 Garage 数据库/对象/journal 备份恢复演练通过。

恢复旧 PG/Redis 快照不能保留旧认证的可信性。因此成功恢复前必须执行以下实际步骤：

- 撤销恢复 schema 内全部 `agents` 和 `zerobox_devices`，使旧设备凭据失效，保留规范工作数据。
- 清除且复查以下固定应用认证前缀，绝不 `FLUSHDB`、删除 `zeroagent:*` 或清其它服务数据：
  `zeroagent:web-session:`、`cloud-session-ref:`、`session-refresh:`、`session-revocation:`、
  `session-refresh-lock:`、`desktop-handoff:`、`oauth-transaction:`、`device-presence:`、
  `selection-lease:`（后八项同样以 `zeroagent:` 开头）。
- 使 queued/running/cancelling Run 进入 interrupted，保存已有输出和中断事件；prepared/
  executing tool 标记 unknown；VM 进入 cleanup_pending；未完成解析保留原件并阻止新分配。
  原操作 ID 和 scope 仍用于对账，绝不自动重新执行未知副作用。
  补写 partial 助手消息时，时间取恢复时钟与该账户/会话原历史最新时间加 1µs 的较大值；
  同会话多个待补写结果按原 Run 时间/ID 依次递增 1µs，已存在的助手消息不覆盖。
  源快照时钟超前也不把答案排到问题之前，不回写旧历史时间。

Redis 认证状态不作为可直接恢复后重新可信的工作数据。SDK scope key 负责外部资源归属，
也不能靠随机新 key 替换来“解决”旧快照。SQL 和 Redis 不能分布式原子提交：任何一步失败，
保持目标离线并保留 incomplete 报告；完成前不得接入入口流量。离线期间反复执行显式失效
是幂等的，方便已手动恢复旧 Redis 的演练：

```sh
/private/tools/cloudchat-backup invalidate-auth \
  --scope your-reviewed-deployment-scope --database your_fresh_restore_database
```

只有报告 `complete:true` 且 `auth_invalidated:true`，并且 `verify` 成功，才完成数据候选
演练。恢复的私有配置仍是新 0600 候选文件，不自动加载或启动服务；操作员需审核环境、
当前镜像、原 namespace/scope key 的 authority 后另行决定切流。用户须重新登录、设备须
重新注册；重新认证后按原账户 ID 访问恢复的工作资料。

## 可复现实证与当前界限

`internal/cloudbackup/backup_test.go` 在显式隔离参数下创建随机专用数据库，并只在两个
预检为空的 Redis DB 14/15 中模拟旧认证。它使用真实 `pg_dump`/`pg_restore`、官方 Node
SQLite backup、实际 SDK Ledger 和签名 S3 HTTP 夹具。演练复现了旧快照会重新接受旧
Cookie/设备的风险，然后证明 Session/AuthenticateAgent/RunSession 均拒绝旧认证，其他
服务及非认证缓存 key 保留；正式字节、配置和 tombstone/unknown 事实恢复一致。

还覆盖缺对象、坏字节、错误 owner、错误恢复密钥、SDK 独占锁、条件写拒覆盖、非空目标及
部分恢复不会误报成功。`ZEROAGENT_BACKUP_TEST_*` 不配置时不会自行连接数据库；普通测试
仍验证路径/归属边界。当前工作区已完成 PostgreSQL 18.6、Redis 8.2.10、Node 24.14.1 的
真实 Linux 隔离演练，并记录 manifest、组件 hash、源码 hash、完整/部分恢复报告和认证断言。

在另一个已准备的专用 Linux 环境复现时，显式配置以下进程环境，再运行
`go test ./internal/cloudbackup -run '^TestCloudBackupIsolatedPostgresRedisS3Recovery$' -count=1 -v`：

| 环境变量 | 专用测试值 |
| --- | --- |
| `ZEROAGENT_BACKUP_TEST_DATABASE_URL` | 仅 loopback 的私有 PG 测试 DSN，角色可创建/删除随机测试数据库 |
| `ZEROAGENT_BACKUP_TEST_REDIS_URL` | 仅 loopback 的私有 Redis 测试 URL，DB 14/15 必须预检为空 |
| `ZEROAGENT_BACKUP_TEST_NODE` | 已校验 Node 24.14.1 原生绝对路径 |
| `ZEROAGENT_BACKUP_TEST_PG_BIN` | 已校验 PG 18 工具目录 |
| `ZEROAGENT_BACKUP_TEST_JOURNAL_HELPER` | 本仓库 `deploy/cloudchat/backup/journal.mjs` 的绝对路径 |
| `ZEROAGENT_BACKUP_TEST_LEDGER` | 本仓库 `crates/cloud-executor/src/ledger.ts` 的绝对路径 |
| `ZEROAGENT_BACKUP_TEST_EVIDENCE_DIR` | 可选，既存 0700 空目录，保存合成 manifest/恢复报告/断言 |

测试只删除自己创建并核对前缀的随机数据库、只清自己的测试 key，不停止 PG/Redis。
测试使用合成认证、固定测试恢复密钥及本地 S3 夹具，不能将它们复制到真实部署配置。

新增条件写测试覆盖正确协议服务、忽略条件头、伪造拒绝却改写对象、写回复丢失、外来
nonce、删除失败/假删除、并发单次尝试及 leader/waiter 取消。真实隔离 PostgreSQL 测试覆盖
有对象和零对象两种候选：不支持或未知时数据库仍为空、认证 canary 不变、正式 PUT 为零、
journal/config 尚不存在。原完整恢复演练仍使用本地 S3 协议 peer 验证正向路径；旧 fixture
只补精确 DELETE，并将正式对象专用 badOwner/dropPut 注入限定到 `accounts/`，保留原断言，
探针异常由独立负例覆盖。没有通过放宽 provider 条件写或原有正式对象断言取得通过。

`TestCloudBackupRestorePartialMessagesMonotonicPostgres` 另用显式隔离数据库/Redis参数，
在新建测试 DB 中验证未来历史、同会话多个 partial、独立 owner/会话、已有消息及重复失效。
仅该测试 DB 移除 active-run 唯一索引以模拟旧/异常快照，不修改生产 schema。

这不代替生产云 S3 的 IAM、版本/复制、备份卷加密、RPO/RTO、真实数据量、磁盘容量与故障
演练，也未进行真实 E2B/付费模型调用、容器部署或生产恢复。只允许已信任且 HMAC 验证的
本应用当前 schema 归档；本工具不提供旧版本回退或旧协议兼容层。

实现依据：[PostgreSQL 18 pg_dump 快照](https://www.postgresql.org/docs/18/app-pgdump.html)、
[PostgreSQL 快照同步](https://www.postgresql.org/docs/18/functions-admin.html)、
[Node SQLite backup API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)。
