# K-brain 最小适配集

固定上游：`51c827d3d56533550e67bc4f78ff7673fa7bd9a3`。补丁顺序和 SHA-256 以
`manifest.json` 为准；不修改 `internal/agent/` 或 `internal/ai/`，不维护第二套 Agent。

本轮范围采用上游公共实现，保留 usa0 安全边界。旧数据迁移、旧版本回退、服务商归档和
额外历史协议容错不在范围内。标准 SSE 使用官方 SDK 的 SSEClientTransport，并以服务器
公告的 endpoint 为准，不提供 Message URL 覆盖、地址猜测或额外协议版本试探。

## 保留理由与撤销条件

| 补丁 | 类别 / 产品需求 | 固定上游缺口与最小切入点 | 上游替换条件 |
| --- | --- | --- | --- |
| `0001-native-mcp-credentials.patch` | usa0 安全：Native 保管 MCP OAuth，逐请求解析、401 刷新、撤销及已知凭据脱敏 | 官方运行器没有 Native 凭据宿主入口。只在启动和 MCP HTTP transport 注入私有回调；能力环境在工具/stdio 子进程启动前清除 | 上游提供等价宿主扩展，且通过 profile/接收方绑定、刷新、撤销、秘密反射和能力继承验证后移除 |
| `0002-windows-selfhost-fixtures.patch` | 测试基础设施：Windows 上实际执行原有 stdio 自托管用例 | 原夹具文件名、共享构建和管道关闭不适合当前 Windows 测试环境；仅修改测试，不增加产品能力 | 固定上游夹具在 Windows 同样可运行且保留原业务断言后移除 |
| `0003-mcp-credential-history-and-legacy-sse.patch` | usa0 安全 + 标准能力修复：跨请求凭据过滤；共享 UI 已展示的标准 SSE | 凭据可能在持续 GET、重连或配置重载后反射；原 factory 没有接入 SDK 的经典 SSE transport。安全部分局限于凭据历史和 MCP 输出；SSE 部分只接 SDK 与正确连接拥有期 | 分别在上游具备等价 Native 凭据保护、标准 SSE 接线及生命周期验证后移除对应改动；不因补丁文件共存而强制一起保留 |
| `0004-owned-mcp-lifecycle.patch` | 生命周期通用修复；含极小的 ZeroAgent 客户端身份设置 | SDK CommandTransport 未回收已配置的子进程树，阻塞写入和优雅关闭可形成等待环；取消通知/DELETE 可能无界。沿用 SDK IOTransport/协议，补充进程与管道拥有期、调用取消和有界清理。客户端 Name/Title 单独设置并通过实际请求校验 | 上游/SDK 提供等价进程拥有期、阻塞 I/O 取消及清理保证，Windows/Linux/macOS 对应验证通过后移除；客户端身份在上游支持配置注入后改用该入口 |

`0003` 文件名的 legacy SSE 仅指 SDK 提供的经典 GET/POST SSE transport；本轮没有自建
JSON-RPC 协商器、历史版本遍历或端点推断。前三项保持此前已核验的原补丁字节；新第四项
只补齐正常执行链所需的生命周期修复、标准调用路径测试和客户端身份。

## 已退出的适配

- `zeroagent.mcp-runtime.v1` 及 `POST /_zeroagent/mcp/runtime`：无第一方生产消费者的
  list/call/status/stop/restart/probe 私有控制面全部移除。
- disabled OAuth diagnostics / `purpose=probe`：随私有诊断删除。普通凭据请求始终要求
  已保存并启用的接收方；额外用途字段拒绝。
- 显式 `messageUrl` 覆盖、`/sse` 推断 `/message`、迟到端点重写及专属旧配置适配删除。
  共享编辑器不再提供该额外字段；GUI 转换和 Native OAuth 对不支持的覆盖明确拒绝。
- 上游也保留的旧前端/Native 源码不为减少行数而机械删除。旧 Native 执行入口仍拒绝执行，
  管理命令不再注册；当前实际执行仍只有 Go manager。

旧 8 项补丁与 manifest 在实施时另存为本地不可变证据，没有清除旧用户数据。

## 本轮验证范围

- Windows Go MCP 全包：91 顶层与 11 子项通过，0 失败；2 个原有自托管条件用例跳过。
  客户端身份覆盖 SDK modern HTTP、legacy HTTP、标准 SSE 的运行时和上游 Probe 请求。
- 同四补丁源码显式开启 `K_BRAIN_TEST_SELFHOST=1` 后，上述两个原有自托管用例另行通过：
  2 通过、0 失败、0 跳过；真实构建 CLI 并验证 4 工具、read/bash 和失败 stderr，临时构建目录已回收。
- SSE 有界取消验证已从被删除的私有 CallRich/RuntimeStop 改为标准 ToolsFor/Tool.Run 和
  LiveManager.Close，仍验证实际取消 POST、HTTP 期限及调用回收。
- GUI MCP adapter：2 项通过，覆盖标准 SSE 往返和额外 Message URL 的拒绝/不反射私有值。
- 四项补丁从固定 pin 逐项 check/apply 并独立重放。1092 个树文件无缺失或语义差异；
  41 份 MCP Go 文件与已运行测试的来源逐字节相同，其余差异只涉及 CRLF/LF。
- Linux amd64 编译及同字节 Ubuntu WSL MCP 实跑通过：88 顶层与 11 子项通过，0 失败，
  2 个原有条件跳过。macOS ARM64/x64 均编译通过，尚无实机运行；全部来源全程未变。
- 真实 Windows sidecar 的 GUI 资源 HTTP 条件项另行通过：4 通过、0 失败、0 跳过；
  使用新 profile 和仅本地的合成凭据，后端正常退出，临时连接文件已删除。

上述证据不代表最终桌面包、真实账号或全部支持端已验收。完整发布矩阵由同步报告跟踪。

2026-10-27 beta.23 后续验收新增第五项通用缺陷修复；前四项补丁字节未改。新增回归覆盖
结果未知记录/项目在后台 lease 存在时拒删、lease 释放后可删、重复删除幂等，以及原请求
收据仍阻止重复提交。它不改变任务结果或数据格式，不自动删除用户历史，也不重试收费请求。


## 2026-10-27 当前后端的应用代码审查技能

`0006-host-owned-code-review-skill.patch`（adapt）只修改 Skills manager 和其回归测试。
Native 在启动前提供 workflow 文件；Go 对 `zeroagent-code-review` 精确名称及
`_zeroagent_builtin.json` 的匹配内容识别 builtIn，拒绝链接标记。沿用同一字段、设置及
SkillsManager 执行入口，拒绝覆盖/创建替换/删除受管理目标；用户同名无标记目录保持普通
用户技能。安装落位及删除在已有写锁下复核，前五项补丁字节不变。此补丁不改 Agent、AI
或协议；技能正文在应用中适配上游现有 subagent API。

当上游提供等价的宿主内置技能注册、所有权与管理保护入口，且真实 Hub/Agent、重启及账号
隔离测试通过后撤销此补丁。参见 ADR 0043；验证结果在本轮同步补充报告记录。


`0007-concurrent-trajectory-section-publication.patch`（adapt）修复四路审查实际触发的不可变
轨迹片段发布竞争。仅在 runtime session 上增加片段写锁，保护存在检查与发布的组合，避免
Windows 在另一个读取者持有文件时重复替换同一摘要目标。模型、工具和审查仍并行；没有
rename 重试、复制删除 fallback、文件格式或协议变化。并发读写回归在未修源码上复现失败。
上游提供等价同内容并发发布保证并通过该回归及真实四路审查后移除此补丁。


## 2026-10-27 ClawHub 商店接线

`0008-clawhub-store-integration.patch`（adapt）补齐当前公开目录/搜索契约、五种 UI 排序、
游标/数量传递与版本/统计/分类/发布者信息。只改 Skills manager、资源 HTTP 路由及测试，
不改 Agent、AI、包名或协议，前七补丁字节保持。公开响应、下载及归档均有体积限制，
保留安全过滤与审核/限流错误；固定版本使用 version 参数，取消及失败清理自己的临时下载。

沿用同一安装器和异步任务；GitHub handoff 仅取固定提交的指定子目录，严格匹配官方
GitHub archive URL，保留原归档路径/链接/冲突保护。contentHash 只做格式校验，内容由
GitHub 提交绑定，不宣称目录摘要独立验签。参见 ADR 0044。上游提供等价接线及同组运行时
验证后撤销本补丁；没有新增旧 API 猜测或第二套商店/技能执行器。

## 2026-10-27 缓存提示的供应商默认与模型继承

`0009-prompt-cache-hint-inheritance.patch`（adapt）把上游原有缓存模式接入固定 Go
设置、模型元数据和路由：供应商自动、模型继承，覆盖可保存/清除/重启恢复，同名模型
保持供应商隔离。解析规则来自上游最后的 `codexPromptCache.ts`（`7cfd13da^`）：
Responses 自动使用会话缓存键，Chat 按主机识别，OpenRouter 只发会话头，none 不发提示。
复用已有传输器和端点能力限制，普通调用及故障转移使用各自目的地的模型配置。

前八补丁及依赖 pin 保持不变；不增加历史格式迁移、第二套 Agent 或缓存命中率承诺。
新增模型缓存字段是可选扩展，不宣称旧后端可直接读取新配置。沿用已有安全缓存键散列
上限，OpenRouter 会话头按上游单独限制到 256 字节。参见 ADR0045；上游 Go 实现提供
等价的保存、继承和出站行为并通过本组测试后撤销本补丁。

## 2026-10-29 beta.24 同步

已撤销 0005：新固定上游已包含未知结果删除、工作者 lease、幂等收据和资源回收的实现与回归测试。其余八项补丁逐项 check/apply 通过，字节保持不变。编号保留以便追溯，不重新编号。当前版本的验证以 beta.24 同步报告为准；上面的历史结果不作为当前版本通过证据。
