# 2026-10-29 远程设备在线状态与授权生命周期

## 复现与修复

完整远程 WebUI 的 `useDesktopGatewaySession.applyExecutionPresence` 曾将选中设备的
任何 `online=false` 推送直接转换为授权失效：清空 credential、释放 WebSocket 并调用
Native 外层 onSelectionInvalid，销毁整个工作台。后续上线推送无法恢复已经失效的挂载。

新增回归先在未修改实现上失败：离线推送后原 selection token 变成空字符串。修复将
presence 更新保留在设备目录状态，工作台与原客户端存活，按既有状态订阅和重连恢复。
持续离线仍在真实状态和目录中显示，不切回本机；固定期限到期、服务端明确拒绝及账号
失效仍拦截。迟到的上线事件不能恢复已拒绝的授权。参见 ADR0046 的本轮补充。

本轮不改协议、Gateway/Native 认证、服务端生命周期或配置持久化，也不迁移用户数据。
不以该修复解释被控设备为何出现离线推送；真实目标崩溃、网络或旧版本仍需其现场证据。

## 本轮验证

- GUI 全量：3724 通过、0 失败、1 个原有 opt-in 资源 HTTP 用例跳过。
- WebUI 全量：899 通过、0 失败、0 跳过。
- GUI/WebUI 类型检查、严格 Biome、产品契约及共享 UI/mirror 检查通过。
- 会话回归覆盖其他设备离线、当前设备离线与恢复、持续离线目录、租约到期、明确拒绝、
  迟到上线和退出失败重试。
- 新增真实二进制 WebSocket 客户端 + React Hook 集成：模型设置保存与终端创建期间分别
  注入离线/上线，两次操作均完成；原 API 实例、token 和选中设备保持，一个 hello，
  没有新 handoff 或重复执行请求。终端为协议夹具，不在用户设备执行 Shell。
- 本轮构建的实际嵌入工厂：无 Node globals 检查及完整双设备 DOM 探针 2 项通过；
  离线/上线期间同一个工作台 DOM 保持挂载，无 onSelectionInvalid，后续切换仍清理旧连接。

## 交付范围

Windows 安装包构建与来源校验结果见随包 build-receipt.json。连接既有内网 Gateway
`http://172.16.0.121:5174`、ZeroAPI `http://172.16.0.121:5173`。仅控制端的前端生命周期
变化，无需为此修复部署 Gateway。不自动安装或启动程序，不操作真实 tkxs，也不调用
收费模型。实际 tkxs 的人工复测尚未完成；上述构建和验收阶段源码未提交、未推送。

Windows x64 内网测试安装包（Native debug + production 前端，未签名）已生成：

- 路径：`D:/code/usa0/src/ZeroAgent/dist/windows-lan-presence-20261029/ZeroAgent_0.4.0-beta.2+lan.presence.20261029_Windows-x64-Setup.exe`
- 大小：66,172,387 字节。
- SHA-256：`f5244b17cbdfce656f9369e3c70864e8089a3404d267b822186db5a9bdf76318`。
- 原生 ProductVersion 核对为 `0.4.0-beta.2+lan.presence.20261029`；包含上述内网地址，
  不包含双客户端测试的 19373/19375 端口地址。
- public/dist runtime 与 manifest SHA-256 一致；针对实际 dist 再执行两项浏览器/DOM
  探针均通过。K-brain 锁定来源、8 项补丁收据和打包暂存 sidecar 哈希校验通过。
- 交付目录同时含 `SHA256SUMS.txt` 与 `build-receipt.json`，记录构建时未提交修复的源码哈希、
  来源基线和验证范围。只需更新发起控制的客户端；本轮未执行安装包或启动应用。
