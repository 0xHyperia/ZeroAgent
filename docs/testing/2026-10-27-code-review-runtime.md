# ZeroAgent 代码审查技能运行时修复

日期：2026-10-27（Asia/Hong_Kong）。基线提交 `72658d25`，本轮仅本地修改、测试、构建运行，不推送。
决策及边界见 ADR 0043。

## 修复

原技能只写入 Native 辅助设置目录，当前 Skills Hub 和 Agent 却读取账号后端的 `engine/skills`。
现由 Native profile manager 在启动 Go 前，仅向实际后端目录种入带所有权标记的
`zeroagent-code-review`。复用既有更新备份与同名冲突保留，不复制旧用户技能，不改总开关或
已有选择；另外两个管理技能继续由 Go 管理。目录、入口或标记为链接/异常类型时拒绝采用。

第六项最小 Go 补丁按精确名称和标记内容识别 builtIn，恢复 Hub / Git Review 的内置身份与
SkillsManager 的创建替换、安装覆盖、删除保护；同名用户技能仍保持普通用户所有权。
技能正文使用当前 `subagent` API，每个角色和验证者创建新上下文，不传旧 Agent 参数。
只读/no-tools 是明确写入每次子任务提示的指令，不冒称新建了后端硬性 readonly 权限模式。

真实四路调用进一步复现 Windows 的轨迹片段发布竞争：多个审查者同时通过“不存在”检查，
随后替换被读取者持有的同一摘要文件，造成子任务在请求模型前失败。第七补丁仅在同会话
串行不可变片段的检查/发布；子任务、模型与工具仍可并行。未加入文件替换重试、复制删除
fallback、协议或存储格式变化。两项补丁的撤销条件见补丁 README，前五补丁字节保持。

## 运行时证据

新 Native 集成测试启动真实固定 Go 侧车和公开配置 facade，再调用真实前端 Skills adapter、
Shared Hub 列表视图、Git Review 技能查找、Go Agent / SkillsManager 和 subagent。
三个阶段分别为账号 A 首开、A 重启、账号 B 首开：

- 从实际后端资源取得技能及 builtIn 标志，Hub 生成对应卡片，Git Review 能找到该内置技能。
- 正文与打包资源一致，按实际读取 ETag 保存工作区选择；重启保留、第二账号未自动勾选。
- 公开管理接口拒绝删除及创建替换；单位测试另覆盖安装覆盖和同名用户目录保留。
- 纯本地合成模型要求真实 SkillsManager 在运行中读取正文，然后启动四个独立 subagent，
  每个角色有新上下文，四份 JSON 报告实际返回父任务。三个阶段共验证十二份审查报告。

夹具在独立临时账号/工作区内使用 full_access 避免人工审批，不改变当前用户执行权限。
没有提交平台收费请求、写 GitHub、修改用户工作区或操作桌面 UI。该测试不评估真实模型的
审查质量，也没有对任意未知响应进行重试兜底。

## 验证

| 检查 | 结果 |
|---|---|
| 新 Native / Hub / Agent 集成用例 | 显式运行 1 通过，内部三个 profile 生命周期阶段全部通过 |
| Native 完整库 | 1,335 通过，0 失败，13 ignored（新增运行时用例已另行显式执行） |
| Go backend / skills / agent / prompts | 四包完整测试通过，包含并发发布及所有权保护回归 |
| Desktop 前端全量重跑 | 3,633 通过，0 失败，5 条件 skip；4 个布局用例因同时构建重建 dist CSS 暂时跳过；构建后对应两文件 6/0/0 补验通过（含这 4 项），仅余 1 个外部连接条件未提供 |
| 构建脚本 | 57 通过，0 失败，2 原平台 skip |
| Release 脚本 | 22 通过，0 失败 |
| Desktop/WebUI 类型与前端构建 | Tauri 前置 hook 完成并通过 |
| Windows 内嵌前端 debug 构建 | 通过，七补丁来源与实际 sidecar 打包字节校验通过 |
| 产品契约 / UI 边界 / rustfmt / diff | 通过，14 功能、79 所有权规则 |

原始日志保留在 `.codex-artifacts/code-review-runtime-20261027`。初次 Native 探针先因运行中
侧车被 Tauri copy 占用而构建失败，停止本 checkout 的桌面后，新用例在旧实现上明确复现
“实际后端缺少技能”。Go 所有权及并发发布用例也先复现失败，再以实际修复构建验证。
夹具前期误用设置字段/权限模式、用网络请求次数代替逻辑调用数的问题已改成上游真实字段、
前端模式映射及实际四角色/四报告断言；没有放宽产品行为或跳过新运行时用例。
首轮前端全量因 Edge 的 DevToolsActivePort 短暂 EBUSY 失败，原样重跑通过。

## 当前运行

新 Windows 构建版已启动，实际子进程采用原账号的 `engine` 目录；该目录下技能正文和
应用所有权标记均已存在。当前用户的模型、凭据、对话及执行权限未被重置。
Gateway healthz/readyz 与 WebUI HTTP 均返回 200；原停止的本地 WebUI 已重新启动。
实际账号下的技能正文 SHA-256 与本次内嵌资源一致，桌面 Vite 2120 监听为 0。
人工视觉确认与真实模型质量验证不计入本轮自动验证；没有推送、发布或创建新提交。


运行已安装前端依赖且已准备匹配 Go sidecar 的本地探针：

```powershell
cargo test --locked --workspace --lib canonical_code_review_skill_runtime_through_hub_and_agent -- --ignored --test-threads=1
```

测试会建立并回收自己的临时 profile，不应把当前账号的凭据或工作目录传给合成模型。
