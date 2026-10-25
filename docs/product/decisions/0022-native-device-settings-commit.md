# 0022：设备设置由 Native 提交后确认

- 状态：部分实施；生产入口与客户端版本协议已接线，真实 Go 存储回归通过；真实 Native/Gateway/账号/设备端到端验收待完成
- 关联：ADR 0018、0019、0020、0021

设备 settings.get 从当前 profile 的规范 Go settings、MCP、完整 prompts、全局 skills 文档和同一 SQLite 读取事务生成快照。项目提示词按值中的 workdir 写入系统资源映射，旧 SQL Provider/MCP/模板及前端内存缓存不再作为执行配置来源。快照声明 zeroagent.settings-sync.v1，返回实际 configurationRevision 与独立 uiPreferencesRevision。

settings.update 必须携带该编辑器的读取版本。Native 将 Provider/模型选择、MCP、模板、项目提示词、全局技能、系统、SSH 补丁及秘密、STT、记忆、故障转移和允许同步的 UI 偏好转换为一次规范更新。远程连接权限和自动化仍由桌面及各自版本协议管理。SSH 与一般字段同次提交，不再只提交 SSH 后提前确认。移除项目对应的目录授权在同一个最终 SQLite 事务撤销，晚期失败整体回滚。

全局技能实际由 Go 保存，因此进入规范版本、私有恢复记录和失败补偿。桌面主设置不再先独立推送 Go 技能后套用旧配置版本。原生 UI 记录中的旧 skills 字段只是兼容缓存；执行选择以 Go 文档为准。技能 HTTP 列表/设置路径参与共享锁与变更计数；全局与工作区的 HTTP 读取版本适配见 ADR 0024。技能 Hub 本身通过主设置提交，没有另建独立表单；真实账号与设备端到端验收仍需继续完成。

Native 完成持久化后才构造 accepted=true 回执。沿用 Proto 的 message 字段承载带协议标识的 JSON 回执，包含提交版本、当前公开快照及提交后警告，避免改变独立 Go Gateway 的旧 accepted/message 协议。Go 或 Native 已知失败按 ADR 0019 补偿，未知结果继续阻止后续规范写入。持久化后的代理、界面或广播失败不能改报“配置被拒绝”。

桌面收到已提交通知后只排队重读完整 Native 快照，不再将秘密投递到 WebView 再保存。独立 STT 回执也不能把其版本借给主设置中的其他旧字段；主设置重读完整数据后才接受全局版本。浏览器只允许完整同步基线匹配的同一队列继承前一笔成功回执版本；新的 GET、另一设备、另一窗口、失败或规范化后不一致的结果不能为旧编辑器提供版本。独立 AI 审批、Computer 与设置表单显式传递自己的读取文档。

公开回执和快照移除私有 MCP 值、SSH/STT/代理秘密及一次性秘密侧带。可信桌面到 Gateway 的 STT 侧带另从 Native 所属数据库读取，并核对当前配置与 UI 版本；另一个 profile 或过期快照不能附上当前账号的私有凭据。其内容仍由 Gateway 在公开广播前消费并移除。Native 在阻塞任务排队之前捕获 profile 上下文，并在执行时再次核对所有权；设备请求在等待前绑定原连接的回复通道，避免重连后把旧请求回执发往新连接。

桌面管理的 Gateway 禁用直接 K-brain 聊天转发。远程 WebUI 设置通过 WebSocket RPC 进入 Native，独立电脑/审批适配器的 runtimeConnection 明确为空；本流程不经过通用后端 HTTP 透传。独立 Go 单后端 relay 保留原协议。Native viewer 的直接 HTTP 配置协议由 ADR 0020 覆盖，实际设备连接及账号隔离仍需独立端到端验收。

本改变没有解决 MCP OAuth、未知结果恢复界面、多实例目录所有权、Windows 冷启动、全部模型传输及 Android/真实账号/Docker 验收。旧自建服务商仍仅归档供导出和回退，模型仍只使用托管服务商。不会因此推进发布或同步完成状态。
