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
底部输入框。只读检查已确认当前实现存在以下问题，本次提交保留现状，尚未修复：

- 远程初始化任意异常都会调用 `onSelectionInvalid` 清除父级租约；下一次渲染将原始异常
  覆盖为过期提示。因此该提示不能证明服务器租约确实过期，首次失败步骤仍待定位。
- 设备确认弹窗直接挂在顶部栏内部，受到顶部栏 stacking context 限制，不能可靠覆盖聊天
  输入区；需要使用共享 Dialog/Portal 的标准顶层弹窗路径。

前述自动验证分别覆盖完整 WebUI 产物、Native bridge 和协议路径，未覆盖桌面外壳初始化
失败经父级状态更新后丢失错误的组合场景，也不构成物理设备验收已通过。后续需补充失败
原因保留、租约状态与初始化错误区分、完整外壳切换及遮罩的回归。

用户在了解上述问题后明确要求先提交并推送当前工作，故本次作为后续修复的源码基线；
不宣称上述问题已解决，不发布新 Release 或重新部署。
