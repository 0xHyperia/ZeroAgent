# ADR 0007：v2 执行、账户存储与平台边界

- 状态：已采纳，分阶段实施；不代表迁移已完成
- 范围：Desktop、设备 WebUI、Gateway、Cloud Chat、Android

## 决策

设备 Agent 采用精确锁定的 K-brain 执行与规范历史，不保留第二套前端 Agent 循环。Tauri
持有原生进程，前端消费 HTTP/SSE；ZeroAgent Adapter 持有账户、Provider 和执行目标语义。
Gateway 继续通过 USA-Zero OAuth、设备所有权和工作区租约授权远程请求。

后端根目录与映射使用稳定 profile：离线本地 profile 与已认证账户 profile 分离。认证
profile 从可信 USA-Zero 来源与账户 ID 派生不透明 scope，不能使用端口或未经验证的回调
参数。切换 profile 必须停止/隔离旧执行、取消订阅并清除展示缓存。安装身份不随登录改变。
具体目录、迁移日志和账户激活接口在实现中同步记录并用账户 A/B 测试验证。

托管 Provider 不能使用通用 confirm-only secret reveal。优先采用受认证的模型代理；若需
后端存储原始托管密钥，必须实现后端级禁止读取/导出策略和二次认证边界。前端隐藏按钮
不足以达成契约。自建 Provider 的本地能力继续可用。

Cloud Chat 保留账户化云端执行服务，并适配 v2 共享 UI 与能力模型；其本地工具在服务端
不可用。Android 保留 WebUI 壳、OAuth、安全存储和更新通道，不启动或打包桌面 sidecar。
新的图片、STT 或其他服务只有具备账户资源归属和 Secret 隔离后才对托管端开放。

## 数据迁移与回滚

迁移只从明确的 ZeroAgent 来源读取，保留旧数据及附件。旧记录没有可信账户归属时先留在
隔离本地 profile，不在首次登录时自动认领。迁移必须可重复、可中断恢复，失败项可见。
checkpoint、分支、工具结果与附件均纳入夹具。

回滚使用迁移前一致性快照；v2 产生的数据需要规范导出或经验证的回迁，不能假定旧版本
能够读取。不得覆盖旧数据来使升级测试通过。

## 验收

覆盖锁定后端真实执行、跨账户拒绝、租约撤销、断线与 ACK 恢复、Secret 绕过路径、账户切换、
数据重入/失败/回滚、Desktop 独立本地运行、Cloud Chat 能力拒绝及 Android 真机登录更新。
支持端、品牌、签名、双仓库分发和生产就绪属性保持产品契约不变。
