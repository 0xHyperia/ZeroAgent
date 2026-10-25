# 开发与运行

## 根目录命令

| 命令 | 作用 |
|---|---|
| `make dev` | 启动桌面 GUI 开发模式。 |
| `make build` | 构建桌面 GUI。 |
| `make desktop-build-macos` | macOS 普通桌面打包。 |
| `make desktop-build-macos-release` | macOS Developer ID 签名、公证相关 release 打包。 |
| `make desktop-build-macos-intel` | Intel macOS 目标构建。 |
| `make desktop-build-macos-m` | Apple Silicon macOS 目标构建。 |
| `make desktop-build-windows` | Windows 桌面目标构建。 |
| `make desktop-build-linux` | Linux 桌面目标构建。 |
| `make dev-gateway` | 本地启动 Go Gateway 开发服务。 |
| `make dev-webui` | 本地启动 Gateway WebUI Vite 开发服务。 |
| `make dev-stack` | 后台一键启动 Gateway、WebUI、桌面 ZeroAgent 三端。 |
| `make dev-stack-status` | 检查三端和 MCP Bridge 状态。 |
| `make dev-stack-logs` | 查看三端最近日志。 |
| `make dev-stack-stop` | 停止由三端脚本管理的进程。 |
| `make check-fast` | 编译、lint、基础测试与错误检查。 |
| `make check-all` | 执行 fast、完整测试与 Proto 契约检查。 |
| `make check-strict` | 执行 all，并将 Biome/Rust warning 视为错误。 |
| `make proto` | 生成 Gateway proto。 |
| `make webui` | 构建 Gateway WebUI 静态资源。 |
| `make gateway-build` | proto + webui + Gateway 构建。 |

## 包管理与子项目

| 子项目 | Manifest | 说明 |
|---|---|---|
| Rust workspace | `Cargo.toml` | 根工作区，包含 Tauri/Rust crate。 |
| 共享 UI | `crates/agent-ui/package.json` | GUI/WebUI 共用的 React 应用 UI 与领域逻辑。 |
| GUI frontend | `crates/agent-gui/package.json` | 桌面 React/Tauri 前端依赖与脚本。 |
| Gateway | `crates/agent-gateway/go.mod` | Go Gateway 依赖。 |
| Gateway WebUI | `crates/agent-gateway/web/package.json` | 浏览器 WebUI 依赖与构建脚本。 |

桌面开发和打包也需要 Go：Tauri 启动前会从当前工作区源码构建 Gateway sidecar，并嵌入对应
WebUI。先使用根 `mise.toml` 对齐 Go、Node、pnpm、Rust 等工具链，再在仓库根安装全部 workspace
依赖，确保桌面和 Gateway WebUI 均可构建：

```bash
mise install
pnpm install --frozen-lockfile
pnpm --dir crates/agent-gui tauri dev
```

`tauri dev` 和 `tauri build` 的前置 hook 自动执行 `scripts/prepare-gateway.mjs`，先完成 WebUI
typecheck/Vite build，再构建 `crates/agent-gui/src-tauri/binaries/liveagent-gateway-<target-triple>`
（Windows 带 `.exe`）。目标架构来自 Tauri 的构建目标；直接准备其他目标时可传
`--target <rust-triple>`。生成的 sidecar 属于本地构建产物，不提交到 Git。正式安装包和 Windows
portable 包携带 Gateway 与嵌入的 WebUI，运行时无需 Go、Node 或 pnpm。

直接调用 Cargo 不执行 Tauri hook。首次在干净工作区运行 Rust check/test/build 前，先准备本机
sidecar；Go Gateway 或 WebUI 源码变更后也应重新准备：

```bash
node scripts/prepare-gateway.mjs
cargo check --manifest-path crates/agent-gui/src-tauri/Cargo.toml --tests
```

## 桌面本机托管

ZeroAgent 桌面通过 USA-零 OAuth 账户管理设备与远程访问。全新 profile 默认关闭远程访问，
本地聊天可独立运行；开启远程访问仍需账户设备身份和工作区租约。本机托管 Gateway 的原生
生命周期保留，但账户设置界面不提供绕过 OAuth 的通用地址/令牌编辑器。

本机 Gateway 仅监听数字 loopback，使用本次进程的 token/nonce 和父进程存活监测。关闭
窗口到托盘时继续运行，真正退出或 profile 改变时停止。账户、后端和迁移边界见
[ADR 0007](../product/decisions/0007-v2-execution-boundaries.md)。

## Windows 构建 Android 调试包

当前工具链使用 Android SDK 36、build-tools 35.0.0、NDK 27.2.12479018、Java 17 或更高版本，
以及 Rust `aarch64-linux-android` target。`ANDROID_HOME` 和 `NDK_HOME` 需指向已安装的目录。
Windows bindgen 还需明确 NDK 的 sysroot 与 Clang 标准头目录：

```powershell
$ndkNormalized = $env:NDK_HOME.Replace('\', '/')
$clangRoot = "$ndkNormalized/toolchains/llvm/prebuilt/windows-x86_64"
$env:BINDGEN_EXTRA_CLANG_ARGS = "--sysroot=$clangRoot/sysroot -resource-dir=$clangRoot/lib/clang/18"
pnpm --filter zeroagent exec tauri android init --ci --skip-targets-install
Copy-Item -Path crates/agent-gui/src-tauri/icons/android/* -Destination crates/agent-gui/src-tauri/gen/android/app/src/main/res -Recurse -Force
pnpm --filter zeroagent exec tauri android build --apk --debug --target aarch64 --ci
```

移动 WebUI 输出到 `crates/agent-gateway/web/dist-mobile`，Gateway 静态资源仍输出到 `web/dist`。
Android 配置以空数组清除桌面外部程序和资源，APK 中不包含桌面 sidecar。调试包使用开发
版本与调试签名；正式签名和版本由 Android Release workflow 处理。

## 常用检查命令

| 场景 | 命令 |
|---|---|
| GUI build | `pnpm -C crates/agent-gui build` |
| WebUI build | `pnpm -C crates/agent-gateway/web build` |
| Gateway tests | `cd crates/agent-gateway && go test ./...` |
| Gateway lint | `cd crates/agent-gateway && golangci-lint run ./...` |
| Proto 检查 | `make proto-check`（buf lint + 对 origin/main 的 breaking 检查） |
| Tauri/Rust tests | `cargo test --manifest-path crates/agent-gui/src-tauri/Cargo.toml` |
| 前端专项测试 | `pnpm -C crates/agent-gui test:frontend` |
| diff 空白检查 | `git diff --check` |
| 当前改动 | `git status --short` |

工具链版本由根 `mise.toml` 固定（git 跟踪），`mise install` 一键对齐，CI 使用相同版本。

实际脚本名称可能随 package.json 调整，运行前以当前 manifest 为准。

## 一键启动三端

跨平台脚本 `scripts/dev-stack.mjs` 统一管理 Gateway、Gateway WebUI 和桌面 LiveAgent：

```bash
make dev-stack
make dev-stack-status
make dev-stack-logs
make dev-stack-stop
```

也可以在 macOS、Linux 和 Windows 直接通过 pnpm 调用：

```bash
pnpm dev:stack
pnpm dev:stack:status
pnpm dev:stack:logs
pnpm dev:stack:stop
```

默认端口为 Gateway `50052`、WebUI `5173`、桌面前端 `1420`、MCP Bridge `9223`，默认本地
Gateway token 为 `dev-token`。脚本遇到已由外部进程占用且健康的端口时只复用，不会在 stop 时
终止该外部进程。进程检测、HTTP 健康检查、日志和状态文件均由 Node 实现；Windows 停止托管进程
时调用系统自带的 `taskkill`，macOS/Linux 使用进程组信号。

`dev-stack` 单独启动的 Gateway 由该脚本管理。要让桌面连接这个开发服务，在桌面远程访问设置中
开启远程访问、关闭「在此电脑托管 Gateway」，填写 `http://127.0.0.1:50052` 和 `dev-token`；
如果通过环境变量修改了开发端口或令牌，填写相应值。浏览器访问 `http://localhost:5173` 使用独立
Vite WebUI。桌面本机托管模式不会自动接管或复用 `dev-stack` 的 Gateway，已有桌面连接配置也不会
被脚本替换。

## 统一编译与检查

跨平台主入口为 `scripts/check.mjs`，macOS、Linux 和 Windows 推荐通过 pnpm 调用：

```bash
pnpm check:fast
pnpm check:all
pnpm check:strict
```

也可以在提供 Make 的环境中运行 `make check-fast`、`make check-all`、`make check-strict`。

| 级别 | 检查范围 |
|---|---|
| `fast` | diff、脚本测试、Shared UI 边界/typecheck、GUI build、嵌入 WebUI 的 Gateway sidecar build、三端完整 lint 诊断、Rust check、golangci-lint、Go tests。 |
| `all` | `fast` + 自动发现的 GUI/WebUI/release 测试、Rust all-target/doc tests、Proto lint/breaking。 |
| `strict` | `all` + rustfmt、Clippy、三端完整 Biome 诊断，并将相对基线变更文件中的 Biome warning 视为错误。 |

所有级别都会执行检查脚本单测、Shared UI 边界和独立 TypeScript typecheck；Biome 使用
`--max-diagnostics=none`，不会隐藏超出默认上限的诊断。`strict` 仍输出三端全量诊断，但只把
相对 `LIVEAGENT_CHECK_BASE_REF`（默认依次选择 `origin/main`、`main`）新增或修改源码中的 warning
升级为失败，避免通过关闭规则掩盖历史诊断。GUI 与 WebUI 测试文件由
`scripts/run-node-tests.mjs` 递归发现，避免手写目录列表或依赖 shell glob。

完整文本日志和结构化 JSON 报告默认写入操作系统临时目录下的
`liveagent-check-<user>/<timestamp>-<profile>-<pid>/check.log` 与 `report.json`。JSON 包含运行元数据、
汇总计数及每一步的命令、工作目录、状态、退出码和耗时。需要失败后继续执行其他检查时设置
`LIVEAGENT_CHECK_KEEP_GOING=1`；需要固定报告位置时设置 `LIVEAGENT_CHECK_REPORT_PATH`。当前已在
macOS ARM64 实跑验证；Windows/Linux 仍应在对应机器或 CI 上完成平台验证。

## 运行时路径

| 路径 | 说明 |
|---|---|
| `<app_data>/runtime-v2/profiles/<profile>/kbrain/` | K-brain 的规范设置、会话、记忆等数据；app_data 由 ZeroAgent 应用身份确定。 |
| `~/.zeroagent/runtime-v2/profiles/<profile>/settings/config.sqlite` | 原生辅助设置数据库，按 profile 隔离。 |
| `~/.zeroagent/runtime-v2/profiles/<profile>/settings/memory/` | 原生辅助 MemoryStore；规范记忆接口走 K-brain。 |
| `~/.zeroagent/runtime-v2/profiles/<profile>/settings/skills/` | 原生 Skills runtime root。 |
| `~/.zeroagent/runtime-v2/profiles/<profile>/settings/default-project/` | 当前 profile 的默认工作目录。 |
| `~/.zeroagent/config.sqlite`、`~/.zeroagent/chat-history.sqlite3` | 旧版导入来源，保持原始内容。 |

`<profile>` 是 `local` 或由已验证的 USA-零来源与账户 ID 派生的 `account-<sha256>`，端口和
token 不参与命名。开发验收用 `LIVEAGENT_DEV_HOME` 隔离原生 home；Tauri app_data 另由应用
身份决定，不能仅凭该环境变量便使用正式应用 ID 启动 UI 测试。

## Gateway 开发关注点

| 项 | 说明 |
|---|---|
| HTTP | `internal/server/http.go` 注册 `/ws/v2*` 三链路、`/api/status`、`/api/files/import`、public share 和静态资源。 |
| Proto | 改 `proto/v2/*.proto` 后执行 `make proto`（buf 生成 Go+TS），生成物随源同 PR 提交；`make proto-check` 把关破坏性变更。 |
| Shutdown | `make dev-gateway` 应支持 Ctrl+C 后 HTTP 干净退出。 |
| WebUI embed | Gateway build 通常依赖 `make webui` 先产出静态资源。 |
| 新增桌面端能力 | `proto/v2/gateway.proto` 加信封臂（编号只增不改）→ `make proto` → v2 直通白名单（`internal/protocol/pbws/guard.go`）放行 → 各端生成物随源同 PR 提交；新增网关本地操作则在 v2 帧（`proto/v2/gateway_ws.proto`）加臂。 |
| 弃用惯例 | Go `// Deprecated: <原因；替代物；删除条件>`、Rust `#[deprecated]`、TS `@deprecated`、proto `option deprecated`；弃用代码原地保留只修 bug，删除前先经使用打点观察。 |

## Gateway 分层（新代码放哪里）

| 代码类型 | 位置 |
|---|---|
| 传输机制（写泵/背压/心跳，帧格式无关） | `internal/transport/wscore` |
| v2 协议编解码/握手/直通/扇出 | `internal/protocol/pbws` |
| 跨协议域逻辑（终端门控、Origin 校验等） | `internal/protocol/shared` |
| chat 命令编排 | `internal/chatcmd` |
| 会话状态与关联路由（transport 无关） | `internal/session` |
| 日志装置与协议使用打点 | `internal/observability` |
| HTTP 入口与 public share | `internal/server` |

## GUI/WebUI 共享 UI 改造检查

| 改动类型 | 代码位置与检查范围 |
|---|---|
| Settings、Skills Hub、MCP Hub | 公共页面只修改 `crates/agent-ui`；平台差异放各宿主 `src/agent-ui-adapters/*` 或页面扩展注册表，并在两端验证。 |
| Chat 侧边栏、输入栏、公共消息视觉 | 公共 JSX/CSS 只修改 `crates/agent-ui`；GUI/WebUI 各自数据控制器、流式状态和虚拟列表仍分别检查。 |
| 上传、剪贴板、目录选择 | 公共交互契约位于 `agent-ui`，Tauri/Gateway/browser 实现位于各宿主适配器。 |
| Provider 设置 | 公共 Settings UI、两端 provider 适配器、Rust settings、Gateway redaction 和模型请求层。 |
| Memory | K-brain memory API、共享 Memory 页面、宿主适配器、Gateway 租约与账户拒绝路径；原生辅助 MemoryStore 按 profile 隔离。 |
| 边界检查 | 执行 `pnpm check:ui-boundaries`，防止应用目录重新出现公共页面副本或共享层直接依赖具体宿主。 |

## 文档任务边界

本文档树只描述当前架构，不要求启动 dev server 或跑 build。若后续文档改动伴随代码改动，应按触达模块补充对应 build/test。
