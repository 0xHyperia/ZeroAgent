# 双本机客户端真实远程验收

2026-10-28，Windows x64。针对远程 `request timed out`，使用两套独立编译的 Debug
客户端、真实 Go Gateway、Native WebSocket 桥与设备处理器、固定九补丁 Go 后端。
只有 USA-Zero 账号服务与模型 HTTP 服务为 loopback 合成服务，不使用真人账号或付费模型。

## 复现与修复

1. 原目标客户端切到远程设备后，ChatPage 被卸载，Native 仍在线，历史读取在 20 秒后
   返回 `composer action timed out`。修复保留原本机宿主，隐藏页面返回 null，并停用其
   页面和侧栏快捷键；保持原对话映射、后台运行、审批与 Go 执行链。
2. 合成模型发现延迟 30 秒，连续两次刷新阻塞串行 dispatcher。测试 Gateway 为缩短
   复现使用 25 秒 request timeout（产品默认 2 分钟），历史请求同样返回截图中的
   `request timed out`。修复仅异步派发模型发现，并将回复绑定原连接；没有增大超时。
   修复后两次发现分别按自己的网络超时失败，历史读取 47～77 毫秒返回。

## 实测结果

- 设置读取/保存、显式缓存模式和请求格式保留、陈旧版本 CAS 拒绝、模型刷新通过。
- 远程新对话、固定 client request ID 去重、流式事件与重放通过。
- 历史列表/目录/消息、改名、置顶、工作目录修改、删除通过。
- Skills 列表包含 zeroagent-code-review；定时任务、记忆、文件目录读取通过。
- 真正 Write 权限挂起后，通过远程 chat_queue 审批：允许前文件不存在，允许后内容
  完全匹配；拒绝后文件始终不存在。只写入隔离实例的专用测试目录。
- 真实 Native 控制 socket 关闭后，旧连接请求失败；新连接恢复历史读取。
- 被控端显示远程工作台时，以上流程仍通过，本机运行宿主保持挂载且不渲染本机页面。
  DOM 中只有一个可见 SidebarProvider；隐藏实例不抢快捷键的 React DOM 回归通过。
- GUI 全量 3,705 通过、0 失败、1 项默认跳过；跳过的真实 Memory/Skills CRUD、打包/
  安装测试已用同一隔离后端连接单独补跑通过，覆盖总计 3,706 项。
- WebUI 883 项全部通过；GUI 的 Cargo smoke 完整运行 Native 后端测试通过。
- Gateway account/session/pbws/websocket 回归通过。

第一次 GUI 命令未加载本机 SDK 工具链，Cargo 因 stdio.h 缺失未编译；加载已验证的
SDK 22621 环境后通过。Android 源码检查仍假定只有两个 Vite 构建模式，已将断言限定
为 mobile 输出分支后完整重跑。没有把这两次失败计作通过。

## 重复运行

探针入口：`crates/agent-gui/test/providers/fixtures/desktop-remote-native-pair-probe.mjs`。
辅助脚本只接受以下账号作用域，拒绝对真实账号执行配置和工具测试：

| 实例 | USA-Zero 合成源 | 检查端口 | 用户 |
| --- | --- | --- | --- |
| target | http://127.0.0.1:19373 | 19383 | 700127 |
| controller | http://127.0.0.1:19375 | 19385 | 700127 |

两实例各自使用不同 Tauri identifier、WebView dataDirectory、ZEROAGENT_DEV_HOME、
ZEROAGENT_CONFIG_DIR 和账号源，避免 OS vault 与设备身份共用。Gateway 使用真实二进制，
监听 127.0.0.1:19374，USA_ZERO_ORIGIN 指向 19373；仅此合成开发服务使用内存存储。
模型服务入口为 `native-pair-model-server.mjs`。Native 通过既有 bootstrap/import API
安装合成凭据，正常激活 profile、注册两台设备并开启远程连接，不增加产品测试后门。

目标实例需切到 controller，以验证本机宿主仍能服务。探针从 Node 通过现有 Debug
检查桥调用 Native API；不点击桌面控件。检查桥的结果借用其既有 Tauri event 通道返回，
不修改应用权限、生产命令或认证流程。模型服务日志输出到 ZEROAGENT_REMOTE_E2E_ARTIFACTS，
未设置时写 `.codex-artifacts/native-pair`；RPC 详细日志仅在显式设置该目录时写入。

本轮构建、初始化、启动/重启脚本和原始日志位于
`.codex-artifacts/two-client-remote-20261028/`。程序启动被自动审批阻止后，用户手动运行
启动和重启脚本；其余验收自动完成，不等待人工审批，也不操作真实 tkxs 设备。

本机双实例不能替代 tkxs 的升级、实际内网连通性或真人账号验收。这些修复位于客户端，
控制端与被控端均应使用新版本；本轮无需为这两项修复重新部署 Gateway。代码不提交、不推送。

最终内网安装包版本 `0.4.0-beta.2+lan.remote.e2e.20261028`，Windows x64 NSIS，
Gateway `http://172.16.0.121:5174`、ZeroAPI `http://172.16.0.121:5173`。
产物位于 `dist/windows-lan-remote-e2e-20261028/`，66,110,753 字节，SHA-256：
`b0d2a8447074e5c8badecd1b313a19a6b671a72c5221528359fe6ff2e64c59d5`。
打包后的实际运行时 SHA-256 `e6570ecd1d33bd3117724391c4e71103431f9939e47bbbdf51a6f8ba30c3646b`，
与准备目录/manifest 一致；无 Node 全局的浏览器 realm 和完整双设备 DOM 探针再次通过。
固定后端九补丁验证及 Native 编译内网地址验证通过，合成账号源未进入最终二进制。
沿用私网 HTTP Debug 构建，无 Authenticode 签名、无 updater 产物；未安装此 NSIS。
