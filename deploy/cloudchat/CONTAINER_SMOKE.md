# SDK 镜像隔离容器验收

`container-smoke.mjs` 对已经存在的本地 SDK 镜像进行真实容器验收，不自动构建、拉取或推送。
需要本机 Linux Docker Engine 与 Node；只接受本地 npipe/unix Docker endpoint，不切换
context、不调整 Docker 设置，不加载生产配置。不存在的镜像会在创建资源前失败。

```sh
node deploy/cloudchat/container-smoke.mjs --image zeroagent-cloud-executor:cloudchat-local
```

可用 `--output /absolute/new-directory` 指定一个尚未存在的证据目录；默认保存在工作区
`.codex-artifacts/cloudchat-container-smoke-20261029/<随机任务UUID>/`。不要把真实 token/key
作为参数。脚本每次随机生成合成 HTTP token、稳定 scope key 和 namespace，E2B key/template
保持为空，内部请求只在容器自身 loopback 发出，不会进行真实 E2B 调用或计费。

## 运行边界

每次使用随机容器名、hostname、专用 named volume 和唯一任务 label，运行参数固定为：

- `--pull never`，`--network none`，没有发布任何端口。
- UID/GID 10001，根文件系统只读，`cap-drop ALL`，`no-new-privileges:true`。
- 私有 `/tmp` tmpfs：64 MiB、0700、uid/gid 10001、noexec/nosuid。
- 256 MiB 内存且禁止额外 swap，1 CPU、64 pids；这些只是小型验收限额，不是生产容量结论。
- 只有本次创建的专用 journal volume 可写；验证目录 0700、SQLite 文件 0600 与文件 owner。

实际检查 Docker HostConfig、进程 `/proc/self/status`、网络接口、cgroup memory/cpu/pids
限制、只读写入失败和 tmpfs 随容器替换消失，不能仅凭命令参数声称隔离成立。

## 真实崩溃与协议验证

1. 容器 A 直接使用镜像内真实 `Ledger/config/protocol` 创建一条 executing checkpoint，
   再创建一条约 1 MiB 的成功下载结果并 retire。只操作合成 journal，不导入或执行 adapter。
   检查大结果压缩为小 tombstone 后保持 2 个稳定 ID，并在输出 ready 后真 `SIGKILL`。
   验证退出码 137 且不是 OOM，不调用优雅关闭来冒充崩溃。
2. 容器 B 换 hostname，使用镜像默认 `main.ts` 和同一卷正常启动，验证：
   checkpoint 变为 unknown 且原部分结果保留；原 unknown 请求重放仍 unknown；unknown ACK
   返回 409；retired GET/原 payload POST 返回 410，变更 payload 返回 409；外账户 scope
   返回 404；错误 token/浏览器 Origin 返回 401，且没有 CORS 内部凭据面。
3. 新 create 请求在缺少 E2B key 时返回 503 `e2b_disabled`，journal 记录数不增加。
   结合无 key、无网络与 admission 前拒绝证明没有云沙箱分配，不能用它冒充真实 E2B 验收。
4. 实际执行镜像中的 healthcheck，disabled 返回退出码 1，Docker 最终状态为 unhealthy。
   为缩短本地等待，只在 smoke 容器上把 interval/start-period/retries 改为 2s/1s/2；镜像
   本身仍保留 30s interval、15s start-period。把 start-period 设为 0 可能继承镜像值，
   所以 smoke 使用明确的非零 1s，并检查 Docker 实际采用的值。
5. 容器 C 只换 HTTP token，scope key/namespace 不变，旧 token 401，新 token 可读原事实。
   容器 D 改 scope key，必须以 `journal_authority_changed` 拒绝启动；再用 C 的正确配置
   启动，确认原 unknown/tombstone 没有被重置或重新执行。

容器 A 同时对镜像中的 TS 源码、healthcheck、broker/parser Python 资源
计算摘要，并与工作区冻结源逐个比对。首次实际验收发现 Dockerfile 漏复制 `sandbox/`，
默认 main 在 import 时 ENOENT；已补对应 COPY，并在修正后的真实镜像上通过本矩阵。
Python 资源仅作为可信源码打包，原件解析仍只在明确授权的 VM 中执行。
运行镜像的 COPY 仅列出 `file_broker.py`、`file_parser.py` 和 `archive_extract.py`，不复制模板构建目录、测试或
requirements 文件；Python 依赖在单独沙箱模板构建时安装。此收紧已通过 Docker 配置检查，
需要在后续重新构建的运行镜像上重跑本脚本，不能沿用下述旧镜像摘要声称新镜像已验收。

脚本还使用完全合成的变量及自己的 env-file 对 production Compose + CloudChat overlay
执行 `config --quiet`，清空相关环境插值再显式赋值。这个步骤只验证配置，不启动 Compose
服务，不读取生产 `.env`、不创建生产网络、不连接 PG/Redis/S3。

## 证据与清理

证据目录保留镜像 digest、脚本/镜像源码摘要、各阶段断言、资源 ID、脱敏日志与清理结果。
不保存完整容器 inspect（包含 env），token/key 不输出。实际 HTTP 请求次数从 probe 动态
计数，不把静态测试用例数量冒充运行结果。

`finally` 只清理自己创建并逐个核对任务 label、name、已知 container ID 的容器；卷也必须
匹配本次 label/name，且不使用强制卷删除。随后只按本次 label 查询确认无资源余留，并删除
自己的合成 env 文件。不会停止/移除其它容器、卷、网络、镜像或 Docker daemon。镜像与
证据保留，失败也会保留 manifest，不能把部分阶段通过标记为完整验收。

当前已在本机 Linux amd64 Docker Engine 29.9.2 验证修正后的镜像：

`sha256:5169efe7c218918cd6764507f74c1b36274247fe02cb9fd5ac133ad804064d19`

成功证据任务：`addca359-ffb9-43cf-a620-99e73747f90a`。这是本地构建的镜像摘要，未推送。
本结果不代表 arm64、生产 Compose 启停/切流、真实 E2B 模板/网络/远程取消、云端计费或
持续负载容量已经验收。
