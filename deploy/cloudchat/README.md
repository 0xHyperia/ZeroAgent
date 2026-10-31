# CloudChat 部署候选配置

本目录是可选配置，不启动、推送或部署任何服务。它与
`deploy/production/compose.yaml` 组合使用。现有生产脚本不自动加载此 overlay；
不能用现有 app-only 更新脚本推定 SDK sidecar 也已更新。

## 镜像与配置

使用仓库根目录作为构建上下文，单独构建 SDK adapter：

```sh
docker build -f deploy/cloudchat/Executor.Dockerfile -t zeroagent-cloud-executor:local .
```

构建不会调用 E2B。生产候选需审核实际镜像 digest，并将 `CLOUD_EXECUTOR_IMAGE`
设置为 `repository@sha256:...`。Gateway 使用现有根目录 Dockerfile；不要把 SDK
management key 放进 Gateway 镜像或环境。基础镜像使用与本地验证一致的 Node 24.14.1；
正式构建可用 `--build-arg NODE_IMAGE=repository@sha256:...` 固定已审核的多平台清单。
[Node 官方镜像](https://hub.docker.com/_/node) 提供构建来源。

1. 将 `gateway.env.example` 中已审核的值加入专用 Gateway 私有配置。
2. 将 `executor.env.example` 保存为独立 SDK 私有配置，仅该容器可读取；两个配置文件
   采用 0600 和专用服务账户权限。E2B scope key/namespace 要持久保留，不能随内部
   token 轮换而改变。
3. 日志、原件及 SDK journal 都不得放进源码或镜像。预先创建 journal 目录，UID/GID
   为 10001、模式 0700；不会通过放宽目录权限解决启动错误。
4. S3 必须具备应用原件/成果前缀的 Put/Get/Delete 及 bucket metadata 权限；配置后
   `/readyz` 检查 PostgreSQL、Redis、bucket HEAD 和内部 SDK health。SDK health
   不代表已通过真实 E2B 模板、网络隔离或计费验证。

只读校验 Compose（不需要启动服务）：

```sh
docker compose --env-file /opt/usa0/config/zeroagent.env \
  -f deploy/production/compose.yaml -f deploy/cloudchat/compose.yaml config --quiet
```

SDK 只监听共享网络命名空间中的 127.0.0.1:17843，不公开端口；管理 key 仅由 SDK
服务持有。该方案以 Gateway/SDK 同属一个可信私有网络命名空间为边界。Gateway 容器
重建时需要一并重新创建 sidecar，使它绑定新的网络命名空间；实际重建、重启、权限、
只读文件系统与资源上限必须在隔离 Docker 环境验收后才可部署。

## 持久性与恢复

`ZEROAGENT_CLOUD_FILE_PARSER_ENABLED` 默认 `true`；设为 `false` 仅停止启动后台 Office/PDF 文件解析 worker，保留 Executor 连接和用户主动发起的工作区工具，非法布尔值拒绝启动。

Gateway 的执行并发、总任务时限、模型轮数与工具调用数可通过独立 Cloud 环境变量调整，
见 `gateway.env.example`。当前初始值为 2 个 worker、15 分钟总时限、12 轮模型调用和
32 次工具调用；部署时需要按真实任务耗时与预算校准，不作为容量承诺。配置只在启动时
读取，非法值直接拒绝启动，浏览器与模型不能修改。单次 E2B 分配仍受独立的 300 秒及
账户按日预算约束；加长任务时限不会自动延长沙箱，也不会自动重新执行未知结果。

PostgreSQL 保存任务、规范历史、资源版本、引用和外部操作事实；Redis 的登录协调状态
具有安全语义，不能作为普通可随意丢弃缓存。S3 保存正式原件与成果，VM 文件系统不能
作为正式交付或备份。SDK journal 也应持久保留并备份，它不替代 PostgreSQL。

现有 `deploy/production/backup.sh` 仅产生数据库 dump，不能单独视为 CloudChat 完整
备份。生产验收还需对象存储版本/复制及清单、SDK 私有 journal、配置和 scope key 的
受保护备份，并在隔离环境恢复比对正式对象大小/摘要及数据库引用。恢复旧认证快照不能
使已注销会话或已撤销设备重新获得权限；恢复操作必须使旧认证凭据失效或应用可靠的
更新撤销事实，用户重新认证后仍可访问恢复的工作数据。

## 当前证据与未完成项

完整Gateway候选镜像已在本地构建并实跑：实际非root用户/私有数据目录、只读文件系统、
嵌入前端资源、未登录接口401、独立PostgreSQL18.6与Redis8.2.10、缓存故障/恢复、
进程重启数据保留和优雅退出均通过。真实Garage的签名bucket HEAD可使已配置依赖就绪；
接入没有E2B key的SDK后，health仍可用而ready明确503，未伪造分配或操作来获得绿灯。
本地镜像tag是 `zeroagent-gateway:cloudchat-local` 与 `zeroagent-cloud-executor:cloudchat-local`。
精确本地索引、platform manifest、binary/asset摘要及任务清理记录在 ignored
`.codex-artifacts/cloudchat-gateway-final-20261029/` 与SDK对应验收目录，未推送到registry。

已验证本地 Node/Go 协议、隔离的真实 PostgreSQL/Redis、SDK 镜像构建，以及非 root、
只读文件系统和资源限制下的容器强制终止/恢复。SDK 容器演练覆盖未知操作回执保留、
稳定 ID 去重、已确认结果回收和内部 token 轮换；缺少 E2B key 时健康检查如实失败。
真实 Garage v2.5.0 的本地 S3 验收覆盖 32 MiB 完整对象、重启后摘要、签名拒绝及
账户文件接口隔离，见 Gateway `test/cloudchat/GARAGE_S3_ACCEPTANCE.md`。
SDK journal 已改为按 ID 读取的私有 SQLite 回执，并由 Gateway 持久确认后回收大结果，
稳定操作 ID 继续保留。首次候选使用新的专用 journal 目录，既有 JSON 目录不会自动迁移或清除。
完整备份工具及隔离恢复候选见 `backup/README.md`；已在隔离 PostgreSQL/Redis、SQLite
和本地 S3 协议服务上验证恢复后撤销旧凭据及正式对象摘要，不能代替生产存储恢复演练。
当前只支持一组 Gateway/SDK 的固定路由。真实 E2B 模板、模型与搜索服务、远端对象存储、
生产恢复及实际业务容量仍需专用资源和费用授权后验收；尚未部署生产。
2 GiB/2 CPU 是初始容器约束，需按真实并发、输出和 journal 内存占用校准，不能当作容量承诺。
