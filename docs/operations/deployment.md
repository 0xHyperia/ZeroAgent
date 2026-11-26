# CI/CD 与发布

本文档描述当前自动化发布链路：CI 检查、Gateway Docker 镜像、用户自部署 Gateway、桌面端 macOS/Windows Release。

## 自动化入口

| 入口 | Workflow | 动作 |
|---|---|---|
| PR / `main` push | `.github/workflows/ci.yml` | 跑 Gateway、WebUI、GUI、Tauri Rust 测试和 proto 一致性检查。 |
| 每日定时 | `.github/workflows/update-model-catalog.yml` | 刷新模型能力目录；仅在数据变化时由 GitHub Actions 创建或更新待审核 PR。 |
| `v*` tag / 手动指定 tag | `.github/workflows/gateway-docker.yml` | 构建并推送 `vX.Y.Z` 与 `latest` Gateway 镜像。 |
| `v*` tag / 手动指定 tag | `.github/workflows/desktop-release.yml` | 并行构建 macOS Intel、macOS Apple Silicon、Windows x64 和 Linux x64 桌面包。按标签决定是否同步到 `USA0-Zero/ZeroAgent`。 |
| `v*` tag / 手动构建 | `.github/workflows/android-release.yml` | 构建签名 APK，并按同一标签规则上传到对应 Release。 |
| 桌面发布调用 / 手动指定提交 | `.github/workflows/file-runtime-packs.yml` | 按固定依赖构建四平台文件运行时，在目标系统离线验证后上传到源码仓库的私有 Actions 产物。 |

## 模型目录同步

`update-model-catalog.yml` 每天 03:17 UTC（北京时间 11:17）运行。任务直接运行 `node scripts/generate-model-catalog.mjs`，从 OpenAI Codex `models.json` 和 `models.dev/api.json` 生成 `crates/agent-ui/src/lib/models/catalog.generated.ts`。

- 上游没有实际数据变化时任务直接结束，不创建 PR；快照日期本身不触发更新。
- 有变化时固定更新 `automation/model-catalog-refresh` 分支和同一个 PR，避免产生重复 PR。
- PR 通过 `add-paths` 只提交模型目录生成文件；上游请求失败、数据截断或关键模型缺失时生成任务失败。
- PR 使用默认 `GITHUB_TOKEN` 创建，不会自动触发 `pull_request` CI 或 PR 治理工作流，由维护者审核后自行触发所需检查并合并。
- 模型目录是编译期静态快照；已安装版本不会动态同步，合并后的数据只进入后续构建和 Release。

工作流不需要额外 Secret，但仓库需要在 Actions 设置中允许 GitHub Actions 创建 Pull Request。`governance-exempt` 标签用于避免自动 PR 被 stale 任务关闭。

`github-release-main` 只从已经审核的 `main` 创建并推送 Tag，不再在发布过程中联网刷新、提交或直接推送模型目录，避免外部数据变化和网络故障影响发布可复现性。

## Gateway 镜像

根目录 `Dockerfile` 是 Gateway 的生产镜像：

| 阶段 | 内容 |
|---|---|
| `webui` | 用 Node 22 和 pnpm 构建 `crates/agent-gateway/web/dist`。 |
| `gateway-builder` | 用 Go 编译 `cmd/gateway`，WebUI 静态资源通过 `go:embed` 打进二进制。 |
| `runtime` | Debian slim + CA certificates + `liveagent-gateway`，非 root 用户运行。 |

运行时变量：

| 变量 | 必填 | 说明 |
|---|---|---|
| `USA_ZERO_ORIGIN` | 是 | USA-零账户与模型服务地址，默认 `https://usa0.top`。 |
| `USA_ZERO_AUTHORIZATION_ORIGIN` | 否 | USA-零浏览器授权页地址；默认与 `USA_ZERO_ORIGIN` 相同。 |
| `ZEROAGENT_WEB_OAUTH_CLIENT_SECRET` | 是 | 与 USA-零配置一致的 ZeroAgent Web OAuth 客户端密钥。 |
| `ZEROAGENT_GATEWAY_PUBLIC_ORIGIN` | 是 | Gateway 的公开 HTTPS Origin，例如 `https://agent.usa0.top`，用于生成精确 OAuth 回调。 |
| `DATABASE_URL` | 是（生产） | PostgreSQL 连接地址，保存设备、工作区快照、对话路由与网页对话历史。 |
| `REDIS_URL` | 是（生产） | Redis 连接地址，保存 Web 会话、step-up proof 消费状态与设备在线 TTL。 |
| `ZEROAGENT_GATEWAY_COOKIE_SECURE` | 否 | 账号会话 Cookie 的 `Secure` 标志；生产默认 `true`。仅本机 HTTP 开发时设为 `false`。 |
| `PORT` | Railway 自动提供 | HTTP/WebUI/桌面端 WebSocket 监听端口，未提供时 Dockerfile 默认 `8080`。 |
| `ZEROAGENT_GATEWAY_GRPC_ADDR` | 否 | **已弃用 no-op**：v1 gRPC 监听已移除，设置后启动时打印警告；保留仅为兼容旧启动脚本。 |
| `ZEROAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT` | 否 | `chat.prepare` 与 command accepted 前关联原生 Ping/Pong 的最大等待时间，默认 `2s`。 |
| `ZEROAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT` | 否 | accepted 后把 `ChatCommandRequest` 投递到当前桌面 Agent stream 的最大等待时间，默认 `5s`。 |
| `ZEROAGENT_GATEWAY_CHAT_START_TIMEOUT` | 否 | Chat command 进入桌面运行态的第一段 watchdog，默认 `5s`。 |
| `ZEROAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT` | 否 | 第一段 watchdog 后继续等待桌面 run settled 的附加窗口，默认 `10s`。 |

本地 smoke run 示例：

```bash
make gateway-docker-smoke
```

CI 中的 `Gateway Docker Smoke` job 会执行同等检查：构建镜像、启动容器、访问 `/healthz`。

## 用户自部署 Gateway

LiveAgent 不提供托管 Gateway 服务。需要公网 Remote Gateway 的用户可以用自己的 Railway 账号部署本仓库，或在其他 Docker 平台部署 `ghcr.io/<owner>/liveagent-gateway:vX.Y.Z` / `latest` 镜像。

Railway 自部署路径：

1. 在 Railway 新建项目，选择 GitHub Repository。
2. 选择 `Stack-Cairn/LiveAgent` 或用户自己的 fork。
3. 分支选择包含根目录 `Dockerfile` 和 `railway.json` 的分支。
4. 在 service variables 中设置 `USA_ZERO_ORIGIN`、`USA_ZERO_AUTHORIZATION_ORIGIN`、`DATABASE_URL` 和 `REDIS_URL`。
5. 部署成功后生成 Public Domain，并访问 `/healthz` 验证健康检查。

推荐生产部署模型：

| 流量 | Railway 能力 | Remote 配置 |
|---|---|---|
| WebUI / HTTP / 桌面端 WebSocket（`/ws/v2*`） | Public Networking HTTPS 域名 | 桌面端设置 `Gateway URL=https://<service>.up.railway.app`，网关端口填 `443`。 |

v2 起全部实时链路统一走同一 HTTPS 域名与端口，不再需要 TCP Proxy 或独立 gRPC 地址。

Gateway 不再配置共享访问 token。用户通过 USA-零账户会话登录，控制端通过 step-up 后签发的 selection lease 选择设备；桌面 Agent 首次用账户 access token 注册，后续使用保存在系统凭据库中的 `device_id` 和 `device_credential` 建立 WebSocket。

Gateway 运行时变量由用户在自己的平台配置：

| 变量 | 说明 |
|---|---|
| `USA_ZERO_ORIGIN` | USA-零账户与模型服务地址。 |
| `USA_ZERO_AUTHORIZATION_ORIGIN` | USA-零浏览器授权页地址；同域部署时与 `USA_ZERO_ORIGIN` 相同。 |
| `DATABASE_URL` | PostgreSQL 连接地址。 |
| `REDIS_URL` | Redis 连接地址。 |
| `ZEROAGENT_GATEWAY_COOKIE_SECURE` | 生产保持 `true`；仅本机 HTTP 调试设为 `false`。 |
| `ZEROAGENT_GATEWAY_CHAT_PREPARE_TIMEOUT` | 默认 `2s`；通常无需调大，超时应暴露半开连接并让客户端快速恢复。 |
| `ZEROAGENT_GATEWAY_CHAT_DELIVERY_TIMEOUT` | 默认 `5s`；控制 accepted 后投递桌面 stream 的上限。 |
| `ZEROAGENT_GATEWAY_CHAT_START_TIMEOUT` | 默认 `5s`；控制远程 command 启动 watchdog 的第一阶段。 |
| `ZEROAGENT_GATEWAY_CHAT_RENDER_START_TIMEOUT` | 默认 `10s`；控制启动 watchdog 的附加阶段。 |

Gateway 一期按单实例部署，实时 conversation stream replay 与 `client_request_id` 去重仍是进程内有界状态。账号、设备、工作区、网页历史和设备对话路由写入 PostgreSQL；Web 会话、一次性 proof 状态和在线 TTL 写入 Redis。事件窗口默认保留最近 10 分钟、最多 4096 条或约 8 MiB；实时窗口在 Gateway 重启后不会保留。

## GitHub Secrets

桌面和 Android 工作流均在 `0xHyperia/ZeroAgent` 构建。发布路由如下。

| 标签示例 | 源码仓库 | `USA0-Zero/ZeroAgent` |
| --- | --- | --- |
| `v1.0.0-alpha.1`、`v1.0.0-rc.1` | 预发布 | 不同步 |
| `v1.0.0-beta.1` | 预发布 | 同步为预发布 |
| `v1.0.0` | 正式版 | 同步为正式版 |

仅当 SemVer 预发布的第一段为 `beta`，或版本没有预发布后缀时，才同步公开仓库。公开同步需要以下凭据及人工审核的公开更新说明。公开仓库的 `main` 分支必须至少有一个提交。

| Secret | 说明 |
|---|---|
| `PUBLIC_RELEASE_TOKEN` | 可写入 `USA0-Zero/ZeroAgent` Contents 的 fine-grained PAT，用于跨仓库创建 Release 和上传产物。 |

源码 tag 只需存在于源码仓库。需要同步时，桌面发布工作流在公开仓库的 `main` 提交上创建同名 Release tag，Android 将 APK 附到对应 Release。正式版供公开稳定更新通道读取。已安装的旧版仍内置原更新地址，需要通过配套安装包更新到新客户端。仅构建 Actions 产物时，两个仓库都不会创建 Release。

使用 Developer ID 签名和 Apple 公证需要以下凭据。当前 GitHub Actions 的 macOS job 使用表中的 Tauri 更新密钥。本地 `make desktop-build-macos-release` 使用系统钥匙串中的 Developer ID 和公证配置。

| Secret | 说明 |
|---|---|
| `APPLE_CERTIFICATE_P12_BASE64` | Developer ID Application `.p12` 的 base64。 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码。 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: wenlin fei (UU94JSVAA9)`。 |
| `APPLE_ID` | Apple Developer 账号邮箱。 |
| `APPLE_TEAM_ID` | `UU94JSVAA9`。 |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple app-specific password。 |
| `TAURI_SIGNING_PRIVATE_KEY` | Tauri updater 私钥，用于生成 release 更新包签名。 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Tauri updater 私钥密码；无密码时可为空。 |
| `TAURI_UPDATER_PUBLIC_KEY` | Tauri updater 公钥，会编译进桌面端用于校验更新包。 |

脚本化写入 GitHub 配置：

```bash
BOOTSTRAP_APPLE_SECRETS=1 \
APPLE_CERTIFICATE_PASSWORD=<p12-export-password> \
  scripts/release/bootstrap-github-secrets.sh
```

如果 `CERT_DIR/developer_id_application.p12` 不存在，脚本会从本机 Keychain 中的 `Developer ID Application: wenlin fei (UU94JSVAA9)` 自动导出，并生成 `.p12` 密码写入 GitHub Secret。`CERT_DIR` 默认优先使用 `~/Personal/cert`，不存在时使用 `~/Downloads/cert`。已有 `.p12` 时需要传入 `APPLE_CERTIFICATE_PASSWORD=<p12-password>`。

如果自动导出失败，先确认本机能看到可签名 identity：

```bash
security find-identity -v -p codesigning "$HOME/Library/Keychains/login.keychain-db"
```

Keychain 中必须是带私钥的 `Developer ID Application` identity。若 macOS 拒绝私钥导出，可以在 Keychain Access 中手动导出 `.p12` 到 `P12_PATH`，再用同一个 `APPLE_CERTIFICATE_PASSWORD` 重新运行脚本。

脚本默认读取：

| 文件 | 用途 |
|---|---|
| `CERT_DIR/developer_id_application.p12` | CI 导入的签名 identity。 |
| `CERT_DIR/app key.md` | Apple app-specific password。 |

## 桌面产物

`desktop-release.yml` 产物：

| 平台 | Runner | 产物 |
|---|---|---|
| macOS Intel | `macos-15-intel` | `ZeroAgent-vX.Y.Z-macOS-x64.dmg`，以及 updater 使用的 `.app.tar.gz` / `.sig`。 |
| macOS Apple Silicon | `macos-14` | `ZeroAgent-vX.Y.Z-macOS-aarch64.dmg`，以及 updater 使用的 `.app.tar.gz` / `.sig`。 |
| Windows x64 | `windows-latest` | `LiveAgent-vX.Y.Z-Windows-x64.msi`、`LiveAgent-vX.Y.Z-Windows-x64-Setup.exe`，以及 updater 使用的 `.zip` / `.sig`。 |
| Linux x64 | `ubuntu-latest` | `LiveAgent-vX.Y.Z-Linux-x86_64.AppImage`、`.deb`、`.rpm`，以及 updater 使用的 `.tar.gz` / `.sig`。 |

GitHub Actions 直接归档 Tauri 生成的 DMG 和更新归档，并校验更新归档的 Tauri 签名。Apple Developer ID、公证、Gatekeeper 和 Finder 安装窗口需要在对应架构的 macOS 上另行验收。本地 `make desktop-build-macos-release` 对 Tauri 生成的应用验证签名，再对 DMG 签名、提交公证并附加公证票据。已完成公证时，可用 `make desktop-verify-macos` 复查应用签名、DMG 票据和 Gatekeeper 判定。验收记录应分别记录两种架构的产物摘要与检查结果。

发布 job 会在上传平台产物后生成并上传 `latest.json`。桌面端「设置 -> 关于」会根据用户是否允许预发布，从 GitHub Releases 中筛选带 `latest.json` 的正式 / 预发布版本；未允许预发布时只检查正式 Release。

桌面端在版本变更后的首次启动还会按当前应用版本查找对应的 GitHub Release，并在应用内展示更新公告。关闭公告或选择稍后查看不会写入已读状态；只有确认公告后才会按版本记录已读，之后仍可从「设置 -> 关于 -> 更新公告」重新打开。开发构建会额外显示「调试模式 -> 预览更新公告」入口，用于预览最新 Release 内容且不会改动已读状态；该入口及对应命令不会进入正式发行构建。

## 桌面版本号来源

本地开发和普通本机构建只维护一个默认版本源：`crates/agent-gui/package.json`。Tauri 默认配置、前端 About 页和 Rust 运行时代码都会从这里读取版本，因此日常开发不需要到多个文件里同步版本号。

正式发布时不依赖人工修改 `package.json`。`desktop-release.yml` 会先在 `Release Metadata` job 中解析 release tag：

```bash
node scripts/release/prepare-app-version-from-tag.mjs vX.Y.Z
```

这个脚本会校验 tag 必须是 `v` 开头的 semver，输出：

| 输出 | 示例 | 用途 |
|---|---|---|
| `ZEROAGENT_RELEASE_TAG` | `v0.1.3` | GitHub Release、产物命名和下载 URL。 |
| `ZEROAGENT_APP_VERSION` | `0.1.3` | 前端 About 页和 Rust 运行时代码。 |
| `ZEROAGENT_IS_PRERELEASE` | `false` | 决定 GitHub Release 是否标记为 prerelease。 |
| `ZEROAGENT_TAURI_VERSION_CONFIG` | `src-tauri/tauri.version.generated.conf.json` | Tauri 构建时追加的临时 config overlay。 |

各平台构建 job 会复用同一份 metadata，并生成一个未提交到仓库的 Tauri overlay：

```json
{
  "version": "0.1.3"
}
```

Tauri 构建命令通过额外的 `--config "$ZEROAGENT_TAURI_VERSION_CONFIG"` 注入这个版本；Vite 和 Rust build script 通过 `ZEROAGENT_APP_VERSION` 注入同一个版本。这样发布版本以 tag 为事实来源，updater manifest、应用内显示版本和安装包版本会保持一致；忘记改 `package.json` 不会导致发布包仍显示旧版本。

Windows 当前没有代码签名 secret，release workflow 会先自动发布 unsigned 包。接入 Windows `.p12/.pfx` 或 Trusted Signing 后再补签名步骤。

带名字的预发布 tag（`v1.3.6-beta.1`）在打 MSI 时会被 tauri-bundler 拒绝：Windows Installer 要求 MSI 的 `ProductVersion` 必须是纯数字（`major.minor.patch[.build]`），报错为 `optional pre-release identifier in app version must be numeric-only and cannot be greater than 65535 for msi target`；纯数字后缀（`v1.3.6-1`）本来就会被推导成 `1.3.6.1`，不受影响。所以 overlay 会额外注入一个只作用于 MSI 的版本，App 版本（About 页、updater、产物命名）仍然保持 tag 语义：

```json
{
  "version": "1.3.6-beta.1",
  "bundle": {
    "windows": {
      "wix": {
        "version": "1.3.6.1"
      }
    }
  }
}
```

推导规则是取预发布标识里最后一个纯数字段作为 build 号（`beta.1` -> `.1`，`beta` / `rc` -> `.0`），超过 65535 时截断到 65535。因此同一个 patch 下 `-beta.1` 与 `-rc.1` 的 MSI 产品版本相同；需要 MSI 版本严格递增时用 `vX.Y.Z-1`、`vX.Y.Z-2` 这类数字后缀。
