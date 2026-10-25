# ADR 0008：托管模型凭证与账号设置隔离

- 状态：已采纳，实施与验收中
- 关联：ADR 0003、0004、0007；LiveAgent v2.0.0-beta.20

## 决策

K-brain 通用 Provider secrets 接口的 `confirm: true` 不是 USA-Zero 二次认证。托管密钥不写入
K-brain 配置，也不交给模型发现接口。原生 ZeroAgent 为已激活的账号创建 loopback 模型代理，
代理用于执行的真实密钥只保留在其内存中。Desktop 账号密钥列表与模型绑定已按 ADR 0016
切到 Native 遮罩接口和 key ID 解析；WebUI/Android 的原始密钥路径仍需适配，不能把桌面
结果泛化为全部客户端均未接触原始密钥。K-brain 只保存随机能力凭证和本机地址。通用查看、配置导出、
备份最多取得该能力凭证，不能得到真实密钥。已有 USA-Zero 密钥页面保留二次认证复制流程。

代理只转发构建时固定 USA-Zero HTTPS 来源的模型发现、OpenAI Chat/Responses、Anthropic
Messages 和 Gemini 模型接口。拒绝账号管理路由、浏览器 Origin、任意上游地址、重定向与
透传 Cookie。错误响应不回显上游诊断。保留 SSE；空列表原子撤销全部凭证，列表删除撤销
对应凭证，轮换保留能力标识并替换真实密钥。账号切换、更新与退出关闭代理并终止活动请求。
K-brain 子进程单独重启时代理继续使用同一凭证，避免重新分配端口导致配置失效。

原生设置目录同样按账号隔离，离线默认读取新的本地 profile。旧 `.zeroagent` 配置库保留为
显式迁移来源。每个 SQLite 文件独立初始化 schema；不能用进程级单一 initialized 标志。
WebView 中含工作区、模型选择等信息的缓存跟随稳定 backend storageId，不跟随监听端口。
安装 ID 保持独立，不随账号变更。激活不同账号前断开旧设备连接、关闭本地 Gateway，清除
无作用域活动设备凭据；各账号的安全存储凭据仍保留以供重新认证激活。

同一原生进程完成首次 profile 激活后，后续切换到不同账号/离线 profile 必须重启原生进程。
只重载 WebView 不能清除已排队的原生设置写入、终端注册表和后台订阅。切换先关闭执行后端、
模型代理与设备连接，再通过 Tauri 的退出清理和重启流程释放其他资源；新进程先重新验证账号，
再激活目标目录。普通 token 刷新和同账号后端重连不重启。该行为仍需原生 UI 验收。

首次绑定前也不能打开默认离线库：自动化、记忆、进程日志/恢复、Gateway 与规划提醒、
WebDAV 自动同步、上传清理和技能初始化均在 profile 选择之后启动。未绑定 profile 的
后台请求不能抢先启动 K-brain。即使后端启动失败，进程也已经绑定该 profile，切换仍需重启。
记忆、浏览器自动化登录态与新的原生 checkpoint 保存到 profile 设置目录；浏览器扩展的
静态安装文件使用独立的 `.zeroagent/extension`。开发配置目录只改变根位置，仍保留 profile
子目录，发布构建不接受该开发覆盖。

旧 ZeroAgent 0.3.23 的 checkpoint 确实位于 `.liveagent/checkpoints`，迁移器保留该只读来源，
仅按 ZeroAgent 自身 SQLite 导出的会话 ID 读取，不扫描该目录。新数据不能再写入该共享路径。

设备运行器直接读取已验证 profile 对应的 OS 凭据，不再复制或读取无作用域的“活动”记录。
未激活账号时不读取旧记录；Get/Set/Activate 接口拒绝其他 profile，退出先断开连接并撤销
进程内活动 scope。设置 IPC 和 SQLite token 字段不能覆盖设备凭据。新 profile 保持官方
账号 Gateway 与原有远程访问默认关闭状态，不采用上游首次初始化自动转为本地 Gateway 的行为。

## 验证与限制

必需证据包括真实锁定 K-brain 的模型执行及 secrets/export 检查、代理的路由限制、流式传输、
轮换、撤销与关闭，账号 A/B SQLite 和缓存测试，以及首次登录/注销/离线/重启验收。
实现、类型检查和单元测试不能替代真实模型或安装包验证。当前完成情况以同步报告为准。

此方案防止新增后端接口绕过托管密钥保护。它不把本机已获授权的模型执行权限当作密钥复制
权限，也不声称能防御获得系统进程调试权限的本机管理员。

新增 MCP OAuth 也遵循 profile 边界：使用 `ZeroAgent MCP OAuth` Keyring service，条目与缓存
标识包含设置 profile 和服务 ID 的摘要；文件降级落在该 profile 的设置目录。不会读取另一个
产品的全局 `LiveAgent MCP OAuth` 或旧全局文件。OAuth 注册、发现和回调页展示 ZeroAgent 身份。
