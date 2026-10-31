# 本地资料存储

SeaweedFS 4.51 使用本机持久盘，Gateway 沿用受限 S3 接口；数据库仍保存账户、额度、文件和不可变成果版本。
前端经 Gateway 鉴权取得原件，不持有 S3 密钥。预览在浏览器按需执行，不要求上传后先转换 Office 文件。

## 隔离验收

先拉取已固定的官方镜像，然后运行：

```sh
docker pull chrislusf/seaweedfs@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8
node scripts/cloud-space/verify-seaweedfs.mjs
```

脚本只创建带本次随机标签的容器、盘和桶，不读取应用配置。执行真实的 32 MiB Put/Get/Head、
摘要及元数据、错误签名、8 个并发条件写、服务重启、账户 HTTP 上传下载/越权及删除检查。
只有验证完条件写语义才通过备份适配器的门禁。私有配置留在 Git 忽略目录，公开凭据不会出现在报告中。
完成后删除脚本自己的容器和盘；不清理其他 Docker 资源。

## 单机部署接线

此方案适用于一台持久化磁盘服务器，不代表磁盘冗余或跨机高可用。扩容后可保留 S3 接口改为独立 TLS 集群。

1. 在服务器上创建专用私有配置，目录必须尚不存在，父目录需已存在：

   ```sh
   sudo node scripts/cloud-space/init-seaweedfs.mjs /opt/usa0/private/seaweedfs
   sudo install -d -o 10001 -g 10001 -m 0700 /opt/usa0/data/zeroagent/seaweedfs
   sudo install -d -o 10001 -g 10001 -m 0700 /opt/usa0/data/zeroagent/seaweedfs/master /opt/usa0/data/zeroagent/seaweedfs/volumes /opt/usa0/data/zeroagent/seaweedfs/filer
   ```

2. 将生成的 `gateway.private.env` 合入现有的私有部署环境文件，保留 OAuth、PostgreSQL、Redis、SDK 等已有配置。
   不要把密钥写入 Git，也不要把 `docker compose config` 的展开输出保存为公开证据。
3. 在现有 production + cloudchat Compose 文件之后添加 `deploy/cloudchat/seaweedfs.compose.yaml`。
   `seaweedfs` 与 `app` 共用网络命名空间，所有内部端口只监听数字环回，不向宿主机发布存储端口。
   Gateway 固定使用 `127.0.0.1:18333`，不放宽现有 HTTP 端点限制。目录元数据和对象卷均位于持久盘。
4. 启动容器后，在同一个 app 容器内执行显式初始化（使用已经注入的私有环境）：

   ```sh
   docker compose exec app cloud-space-storage --create-bucket --verify-conditional-writes
   ```

   不加参数的 `cloud-space-storage` 只做签名 HeadBucket；只有 `--create-bucket` 才创建指定桶。
   只有 `--verify-conditional-writes` 才写入并清理专用随机探针对象。命令不会覆盖对象、更换凭据或修改数据库。
   Gateway `/readyz` 在桶尚未就绪时应返回未就绪，
   不通过匿名 S3 健康检查替代签名 HeadBucket。尚未验证过的配置不得用于现有数据切换。
5. 重建 `app` 容器后也重建共享其网络命名空间的 `seaweedfs`、`cloud-executor`；单独停止业务进程时不要删除持久盘。

## 现有资料与恢复

修改 endpoint 不能移动对象。现有 R2 或其他桶中的文件不得因部署新存储而失去可读性。
先保留源桶和原数据库，暂停写入或使用一致性备份，在独立目标复制并核对每个对象的键、字节数和完整 SHA-256；
之后恢复到隔离数据库/目标桶，验证账户、引用、版本和下载，最后才显式切换部署配置。切换失败保留原源与备份。
不能在两个未同步的桶之间仅切换环境变量后继续写入。新存储的逻辑删除、回收站和额度仍由 Gateway 处理。

独立恢复演练使用实际 PostgreSQL、Redis、SQLite 会话日志以及分别限权的两个 SeaweedFS 桶：

```sh
node scripts/cloud-space/verify-recovery.mjs
```

脚本只创建自己的随机标记资源，网络命名空间与现有部署分离。它检查条件写后执行真实备份、验证和恢复，
核对原件、成果版本、文件夹及收藏；源文件保持可读，恢复目标中的登录态被隔离，非认证 Redis 数据保留，
再次向已填充目标恢复必须被拒绝。已有通过证据见[实施清单](SPACE_IMPLEMENTATION.md)。
这项演练不自动切换现有部署，也不代替真实数据切换前的一致性快照和逐对象核对。

## 每用户容量和列表分页

默认仍为总共 512 MiB、原件和成果各 256 MiB、各 500 份记录。部署新存储不自动扩大现有账户额度。
单文件 32 MiB、模型上下文、预览解压和像素上限仍独立生效。总额度包含每个成果版本及失败、待确认、
回收站和清理中的对象；只有确认删除的原件才释放预留。

运维可在注入现有私有 `DATABASE_URL` 的 app 容器中查看或显式设置指定账户的限额，不提供浏览器或 AI 提额接口：

```sh
# 默认只读，不创建用户或额度记录。
docker compose exec app cloud-space-quota --user 7

# 示例：总共 10 GiB，两类各最多使用 10 GiB，合计仍受总额约束。
docker compose exec app cloud-space-quota --user 7 --apply \
  --total-bytes 10737418240 --file-bytes 10737418240 --artifact-bytes 10737418240 \
  --max-files 20000 --max-artifact-versions 20000
```

修改时必须完整提供各项正值。额度配置与原件/成果预留共用数据库锁；降低额度不删除既有资料。
如果修改结果未确认，先使用默认只读命令核对，不自动重试。既有只配置总额的记录保持原先的分类与数量上限。

资料列表在 PostgreSQL 内筛选、排序并有界返回，每次最多 50 项；正文和解析日志不进入列表查询结果。
后续游标绑定账户、查询条件和事务代次。账户内的资料或额度在翻页间变化会返回 409，界面保留已显示内容并提供刷新；
不会把两个代次的数据拼成一份列表。重命名、移动和回收站只加载目标和候选文件夹，不再加载完整账户快照。
