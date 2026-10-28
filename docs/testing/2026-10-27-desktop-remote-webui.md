# 桌面完整远程 WebUI 与内网 Windows 安装包验证

- 日期：2026-10-27（Asia/Hong_Kong）；按用户授权仅本地修改、验证和打包，不推送。
- 基础提交：`bfefe7523f789afea85f9ef943fc0265ef07453a`，附当前未提交改动。
- 决策：[ADR 0046](../product/decisions/0046-desktop-remote-webui-workbench.md)。固定上游 beta.23、
  K-brain pin 与九个补丁不变，没有新协议、执行器、旧版本迁移或数据清理。

移除简化聊天页，复用完整 `GatewayApp` 与共享 UI。WebUI 以独立适配器和可释放模块工厂进入
同一桌面窗口；设备开关和窗口控制通过布局插槽保持桌面上下文。Native 保留真实账号凭据、
密钥遮罩/密码证明和私有 Cookie；上传沿用既有 handoff 与 lease。新密钥在目标设备缺少模型
绑定时按当前 Native 账号补齐，不改变设置 CAS。账号退出失败可重试，设备名称读取实时列表，
内网账号安全链接使用当前来源，退出远程界面恢复根主题/字体/语言。

## 已完成验证

| 检查 | 实际结果 |
| --- | --- |
| Desktop 完整前端 | 3,669 通过、0 失败、1 项既有条件跳过。 |
| WebUI 完整前端（最终源码） | 883 通过、0 失败、0 跳过。 |
| Shared UI / Desktop / WebUI 类型 | 全部通过；两端生产前端构建通过。 |
| Native 完整库 | 1,341 通过、0 失败、16 项按原/显式环境规则 ignored。 |
| 新增 Native HTTP 运行时 | 5 项包含在完整库通过项内；真实本机 handoff/上传/固定路由、账号切换/取消、Cookie/token 遮罩。 |
| 新增 Native 模型绑定运行时 | 显式准备二进制后单独运行，1 通过：真实固定 Go 后端、当前账号新 key、旧 capability 保持、真实配置保存、disabled/foreign key 和切号拒绝。 |
| Gateway 完整 Go | 21 包、552 测试（含子测试）通过、0 失败、1 项既有条件跳过。 |
| 构建/来源脚本 | 59 通过、0 失败、2 项既有 Windows 条件跳过；包含工厂实例隔离与 Worker URL/导出契约。 |
| 完整构建产物 DOM | 显式运行实际 `runtime.js`，1 通过；真实 React/GatewayApp/共享侧栏、输入框及桌面插槽，38 个二进制帧、10 个宿主 HTTP 调用；A 关闭实际 WebSocket 后 B 独立挂载，主题/字体/语言/标题恢复。 |
| 生产 Gateway 客户端运行时 | 本机真实 WebSocket + 标准 Protobuf：模型与 CAS、指定模型提交、精确 agent/conversation/tool 的允许/拒绝、租约过期、A/B 隔离、设置及审批丢 ACK 不自动重发、聊天复用原 request ID。 |
| 会话/目录补验 | Native 退出失败保持目标和登录态、成功重试；不走 Cookie 登录/旧全局事件；设备列表读取最新名称。 |
| 边界与格式 | UI 边界、15 功能/86 所有权规则、rustfmt、diff hygiene 通过。触达源码 Biome 通过，保留已记录的既有 warning。 |
| Windows NSIS 与实际侧车 | 构建及 pin/九补丁/实际 helper SHA 来源校验通过；public 与嵌入前端的远程 bundle 字节一致。 |

真实 DOM 探针没有替换整个 View 或聊天组件，只模拟浏览器布局/动画等 JSDOM 缺失的标准能力，
并通过本机协议服务器返回实际 schema 数据。它证明真实产物能运行，不能替代真人视觉、实际
账号登录或物理双设备验收。未调用收费模型、未操作用户桌面 UI，原用户数据不用于夹具。

## 先行失败与修正

- IIFE 会将 Monaco 的 `import.meta.url` 改写为空对象；最终改用单文件 ESM 工厂，保留标准
  Worker 地址并用 Node 语法检查拒绝未封装的静态 import/export，未忽略构建错误。
- GUI 首轮唯一失败为旧 portal 检查将普通布局插槽当作弹窗。改为 AST 验证显式 chrome
  标记必须为 `contents` 且禁止 dialog、overlay 和绝对定位；其余所有 portal 保留原 layer
  要求，无文件路径豁免。最终完整前端通过。
- Gateway 首轮 `TestTunnelTrafficWhileControlPlaneBusy` 在并行 Native 编译负载下超时。
  相同未修改源码、原期限、原默认包并发的完整 `-count=1` 重跑全部通过。没有改断言或新增
  skip；保留失败原日志，不宣称修复了该既有负载间歇问题。
- 真实线测试复现工具审批丢 ACK 后自动重发，已将该单一变更请求改为不自动重放；聊天的
  固定请求 ID 幂等恢复保持。完整 bundle 卸载时保留 `client disposed` 的后台初始化收尾诊断，
  探针确认无残留连接或跨设备请求；未隐藏诊断或降低断言。

## Windows 交付

- 版本：`0.4.0-beta.2+lan.remote.20261027`；Windows x64 / NSIS，简体中文与英文。
- Gateway：`http://172.16.0.121:5174`；ZeroAPI：`http://172.16.0.121:5173`。
- 按 ADR0036 使用支持精确私网 HTTP 来源的 debug 构建，内嵌生产前端，无需本地 Vite 或
  环境变量。正式 HTTPS 传输限制未放宽，不生成 updater 签名产物。
- 文件：`dist/windows-lan-remote-20261027/ZeroAgent_0.4.0-beta.2+lan.remote.20261027_Windows-x64-Setup.exe`。
- 大小：66,158,105 字节；Authenticode：`NotSigned`。
- SHA-256：`2c11dad81e916c93b3dbf62a00924a9187680a84fb814a2c8468ad39e34e6378`。
- 同目录保存校验值、构建收据及使用说明。控制端和目标设备均更新后可使用新 key 的远端补齐。

原始日志、脚本和运行时结果位于 `.codex-artifacts/desktop-remote-webui-20261027/`；新增模型
绑定显式运行时原日志另在 `.codex-artifacts/remote-managed-binding-runtime.log`。未执行本机
安装、真人 OAuth、实际双设备工具执行、OS 代码签名或 macOS/Android 验收，不将其计为通过。

## 安装版人工反馈与待修问题

用户随后提供截图：确认切换在线远程设备后显示“控制权限已过期”，确认弹窗的遮罩未覆盖
底部输入框。只读检查已确认以下问题，在 `0cc4cf3f` 基线提交中保留现状；后续修复见末节：

- 远程初始化任意异常都会调用 `onSelectionInvalid` 清除父级租约；下一次渲染将原始异常
  覆盖为过期提示。因此该提示不能证明服务器租约确实过期，首次失败步骤仍待定位。
- 设备确认弹窗直接挂在顶部栏内部，受到顶部栏 stacking context 限制，不能可靠覆盖聊天
  输入区；需要使用共享 Dialog/Portal 的标准顶层弹窗路径。

前述自动验证分别覆盖完整 WebUI 产物、Native bridge 和协议路径，未覆盖桌面外壳初始化
失败经父级状态更新后丢失错误的组合场景，也不构成物理设备验收已通过。后续需补充失败
原因保留、租约状态与初始化错误区分、完整外壳切换及遮罩的回归。

用户在了解上述问题后明确要求先提交并推送当前工作，故本次作为后续修复的源码基线；
不宣称上述问题已解决，不发布新 Release 或重新部署。

## 设备重命名在重启后被覆盖的补充修复

用户继续反馈设备重启后恢复旧名称。原实现的两个确定覆盖路径已用回归测试复现：重复注册
可重新提交主机名/兜底名称，工作空间同步在另一端改名后仍将旧设备快照整条写回。

注册名称现只用于新建设备；内存和 PostgreSQL 存储在重复写入时保留已存名称。显式重命名
改为按所属账户及未撤销条件单独更新名称，避免与工作空间同步互相覆盖。注册响应重新读取
当前设备，不返回同步前的旧名称。未更改设备 ID、凭据、协议或数据库结构。

新增 `internal/account/device_name_test.go` 覆盖重新注册（空名称、主机名、兜底名称）、
服务重建、数据库连接重开、在线与工作空间同步、双端目录名称、并发旧快照覆盖、跨账户和
已撤销设备拒绝改名。真实 PostgreSQL 18/Redis 8 测试使用专用一次性容器，未读取或修改
现有开发数据；日志位于 `.codex-artifacts/device-name-20261027/`。

最终 Gateway 全量回归：21 个包通过、559 项测试（含子测试）通过、0 失败，1 项既有真实
后端测试跳过；本次真实持久化测试已显式执行并通过。Gateway Windows 可执行文件构建、
产品契约检查（15 项功能 / 86 条所有权规则）与 `git diff --check` 均通过。专用测试容器
已停止并由 `--rm` 清除，原开发容器保持运行。

本次修改在 Gateway 服务端，需更新实际运行的 Gateway 才会生效；没有部署到内网环境，
也未自动恢复已被覆盖的旧别名。远程初始化错误和遮罩问题另见下节修复。

## 远程授权误报和设备确认弹窗的后续修复

初始化失败不再调用父级租约失效处理，保留具体的 JavaScript Error 或 Tauri 字符串异常。
运行中授权失效的原因随原租约保留并阻止复用，父级重渲染不再用“权限过期”覆盖真实原因；
旧连接的回调仅能标记原设备/原租约，不能废弃新授权。原租约按真实有效期清理，避免另一
设备到期时将还剩 10 秒的当前连接提前清空。新增“重新连接”显式获取新租约；实际过期
继续关闭运行时、样式和 Native 桥，离线设备不能发起请求，不会回落本机。

另用修复前的 Gateway 代码复现同账号 token 刷新导致 handoff 被拒绝：桌面控制端 ID 包含
access token 哈希，原 handoff 严格对比旧 ID，而既有 WebSocket 已按同账号及固定有效期
验证。handoff 现复用该验证，仍拒绝跨账号、非桌面主体、过期会话及过期租约，并保留原
租约期限。新增 HTTP 路由测试经过合成 USA-Zero 的实际 HTTP 身份验证，再消费一次性
handoff 建立指定设备会话。原截图首次异常未采集，不能断言必定由 token 刷新触发；新版
保留原始失败原因以便确认。

设备切换确认复用共享 `Dialog` / `DialogContent`，由标准 Portal 将遮罩和弹窗挂到工作台
层叠上下文之外，沿用模态层级、焦点管理和关闭行为。确认期间防止重复提交和关闭；失败
保留弹窗并展示原因，之后可重试或取消。

验证结果：

- 桌面完整前端：3679 通过、0 失败、1 项既有跳过。此后额外增加重连失败用例，包含该用例
  的 8 项工作台 DOM 回归通过；再补充多设备过期清理用例，最终工作台 DOM、实际父级状态
  和共享 Dialog DOM/焦点共 21 项针对性回归全部通过。新构建完整 WebUI 产物的二进制
  WebSocket 协议/DOM 挂载与双设备释放探针 1 项通过；卸载时既有 disposed 诊断保留。
- 类型检查通过。修改的 TS 通过 Biome；App 原有 9 条依赖警告和 1 条冗余 Fragment 提示
  保留，未新增忽略规则。
- Gateway 全量：21 个包通过、557 项测试（含子测试）通过、0 失败；2 项跳过分别为既有
  真实 K-brain 测试及需专用数据库的设备名称集成测试。后者已在前节一次性真实数据库中
  显式运行通过，本次 handoff 测试没有跳过。

日志和构建脚本位于 `.codex-artifacts/desktop-remote-fix-20261027/`。未操作用户桌面、
登录真实账号或发起收费模型请求，也未推送或部署内网 Gateway。客户端修复通过新安装包
生效；服务端 handoff 与名称保护需部署更新后的 Gateway。

新 Windows x64 NSIS 内网候选：

- 版本：`0.4.0-beta.2+lan.remote.fix.20261027`，内网地址保持 `172.16.0.121:5174` /
  `172.16.0.121:5173`。使用支持私网 HTTP 的既有 debug 配置并内嵌生产前端。
- 文件：`dist/windows-lan-remote-fix-20261027/ZeroAgent_0.4.0-beta.2+lan.remote.fix.20261027_Windows-x64-Setup.exe`。
- 大小：66,259,258 字节；SHA-256：`704a2c4c0a44735a632dcada54fd76dc0c8613d5cdd51d78775e4f7bf9da376a`。
- Authenticode：`NotSigned`，不含 updater 产物。内网地址、应用版本、远程模块与新 Gateway
  侧车的一致性、固定后端和九个补丁的打包来源核对均通过；同目录保存构建收据及校验值。
- 构建保留既有 Rust 编译警告；NSIS 数字版本字段不支持语义版本 metadata，按既有构建
  行为使用数字 0，应用 ProductVersion 的完整版本字符串已核对。未自动安装或操作 UI。

## 2026-10-28：内嵌运行时 process 全局缺失

用户提供的新截图显示 `process is not defined`。在此前打包的真实远程 bundle 上新增
无 Node 浏览器 realm 探针，复现 `ReferenceError: process is not defined`，堆栈位于
`createDesktopRemoteRuntime` 初始化 React 入口阶段。原完整 DOM 探针直接在 Node 中导入
产物，借用了 Node 的 `process`，未覆盖这项浏览器环境差异。

Vite 的 library 构建保留 `process.env.NODE_ENV` 供消费者替换，而该独立内嵌产物直接由
WebView 动态导入，没有二次构建。仅在 `embedded-desktop` 模式增加 production 常量定义。
不提供全局 process shim、不暴露环境变量、不对生成的 JavaScript 做正则替换；普通 WebUI
和 Android 构建模式保持原行为，第三方库受 `typeof process` 保护的环境检测也保持。

新增 `desktop-remote-browser-probe.mjs` 在 jsdom 的独立浏览器 VM realm 中加载真实 ESM、
连续创建两个运行时，前后断言 `process`、`require`、`Buffer`、`module` 不存在。仅补充
jsdom 缺失的标准 TextEncoder/TextDecoder，并将无渲染器的 canvas 检测返回 null。每次
`prepare-desktop-remote.mjs` 都要求该检查通过后才生成 manifest；Node 的实验 VM 模块参数
只用于构建验证，不影响 WebView 的执行方式。

旧产物在新探针中失败，修复后真实产物通过。同一修复后 bundle 的完整工作台 DOM 探针
通过，包含两个设备的完整界面挂载、38 帧真实二进制协议消息和 10 次宿主 HTTP 调用；
卸载时既有异步 disposed 诊断保留。WebUI 全量 883 项通过、0 失败、0 跳过，两端类型
检查和 factory 包装的 2 项脚本回归通过。此次不涉及 Gateway 服务端或 Native Rust 逻辑修改。

桌面远程工作台、租约状态及标准弹窗的 21 项针对性回归也全部通过。最终编译后的
`dist/remote-device/runtime.js` 另行通过无 Node realm 检查和完整双设备 DOM 探针；其
SHA-256 与准备目录、manifest 一致。

本轮早期因日志目录不存在，首次前端测试命令未执行；已修正目录后执行 WebUI 完整回归。
没有将未完成的 GUI 全量日志计作通过。最终打包还会运行桌面类型检查和上述浏览器启动检查。
日志、脚本和构建收据位于 `.codex-artifacts/desktop-process-fix-20261028/`；不推送。

新包为 `0.4.0-beta.2+lan.remote.process.20261028`，Windows x64 NSIS，地址仍为
`http://172.16.0.121:5174` 与 `http://172.16.0.121:5173`。文件位于
`dist/windows-lan-remote-process-20261028/ZeroAgent_0.4.0-beta.2+lan.remote.process.20261028_Windows-x64-Setup.exe`，
66,077,264 字节，SHA-256：`046dbd1eb98d0fca14ea9a0219d6873f9dd1799e63aa357b6a76e729190f580c`。
固定后端九补丁的打包来源及内网地址检查通过；沿用私网 HTTP debug 构建，无 Authenticode
签名、无 updater 产物。

已启动本工作区 `target/debug/zeroagent.exe`，核对 ProductVersion 为本次版本，启动时 PID
12268，窗口存在且响应正常。没有操作桌面控件、安装 NSIS、手动登录或进行真实账号远程
对话；保留现有账号数据，不把进程启动当作人工远程验收通过。代码未提交、未推送。
