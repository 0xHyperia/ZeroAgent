# ClawHub 商店与启动首屏验证

日期：2026-10-27，Asia/Hong_Kong。仅本地修改、测试与 Windows 构建运行，不提交、不推送。

## 实现与来源

固定 K-brain `60e614f07c600b7aa5c0acbb9631d708e33dbb8b` 不变，第八补丁
`0008-clawhub-store-integration.patch` 补齐 Skills manager 与资源 HTTP 接线。前七补丁
SHA-256 全部保持，构建从独立 checkout 重放八补丁，prepared receipt 与实际打包字节一致。
没有修改内部包名、Agent/AI 执行器、账户模型来源或旧数据。

浏览使用公开目录，搜索使用关键词接口；完整传递排序、数量、目录游标及发布者，保留
当前版本、统计、标签、更新时间和安全过滤。搜索遵循官方相关度且无分页。指定版本下载
使用 version 参数，无指定版本使用 latest。统一官方来源链接。沿用原异步安装、冲突处理、
路径/链接/体积校验及内置保护，失败/取消清理本次临时下载。

当前 GitHub handoff 支持固定提交、官方 archive URL 和指定技能子目录，不采用任意地址。
contentHash 只检查格式，不声称已独立验证目录摘要。详情见 ADR 0044。
公开契约依据：[ClawHub API](https://github.com/openclaw/clawhub/blob/main/docs/api.md)、
[HTTP API](https://github.com/openclaw/clawhub/blob/main/docs/http-api.md)。

用户补报启动时出现 LiveAgent，定位为 React 前的静态 HTML 启动页。四处中英文首屏标题与
无障碍名称改为 ZeroAgent，内部 localStorage 键、唤醒回调、主题与性能标记保持。

## 自动化结果

| 验证 | 结果 |
| --- | --- |
| Go 商店专项 | 9 主项、18 子项通过，0 失败；包括目录五排序、查询/游标/数量、空过滤页、嵌套元数据、固定版本 ZIP、实际异步安装、取消、错误清理及固定 GitHub 子目录。 |
| Go 包回归与 vet | `internal/skills`、`internal/backend`、`internal/agent`、`internal/prompts` 四包通过；Skills/backend 的 go vet 通过。 |
| Skills 前端 | 104 通过、0 失败，1 个原有运行连接文件条件项跳过；新增实际 WebUI adapter 参数检查、Desktop 请求参数和版本链接检查。 |
| Native 完整库 | 1,335 通过、0 失败、14 ignored。新增公网运行时项在下列单独显式运行，不把 ignored 计为通过。 |
| Native 商店实际运行时 | `canonical_clawhub_store_runtime_through_facade_and_adapters` 显式运行 1 通过；内部 A 首开、A 重启、B 首开三个 Node 阶段均通过。 |
| 启动与命名 | 24 通过、0 失败、0 跳过；实际执行 HTML 内联脚本，检查默认/zh-CN/en/en-US 首屏及原语言偏好。 |
| Gateway 资源中继 | `go test ./internal/kbrain` 通过。 |
| 来源/打包脚本 | 32 通过、0 失败、2 个原有 Windows 平台权限位条件跳过。 |
| 类型/构建/治理 | Desktop/WebUI 类型检查和两端前端生产构建、Windows 内嵌前端 debug 构建、rustfmt、改动 TS 的 Biome、UI 边界、产品契约和 diff 检查通过。 |

## 公网运行时证据与范围

真正启动 Native profile manager、Go 侧车和公开 facade，加载生产 Desktop adapter 与共享
商店缓存函数。下载两个安装操作均来自公开 `steipete/github`，测试只读取技能文件，不执行
其中指令或脚本；所有文件只进入 Rust 临时账号目录。

downloads/stars/installs/updated 均返回 2 项；newest 首次返回空过滤页及有效游标，保持
继续分页语义。downloads 第二页累计 4 个不同技能，关键词搜索返回 3 项。详情取得公开
版本 1.0.0，指定版本同步下载并安装成功；删除该测试安装后，按 UI 的 install_start 契约
完成异步 latest 下载，实际下载 1,800 字节。搜索接口当时 version=null，异步安装正确保留
未指定版本，而不虚构版本。文件可读、启用状态保存，重启仍在，另一账号未继承安装和选择。

WebUI adapter 实际模块的 manageSkill 消息经测试 HTTP 桥进入同一真实 facade，验证其
浏览/搜索接线；没有把该桥描述为完整生产 WebSocket/设备租约端到端验收。详情预览在 Node
环境用公网 fetch 替代 Native 出网 IPC；没有操作桌面 UI，窗口外观由用户查看。

Go 本地 TLS 夹具另验证审核拒绝、429/Retry-After、响应过大/畸形、损坏 ZIP、取消、安装冲突、
无自动重试及临时文件回收。GitHub handoff 的固定提交和子目录由本地夹具验证，公网实例
本次返回 hosted ZIP。原用户技能、设置、历史和凭据均未清理或迁移。

## 先行失败与限制

Go 新回归先复现原目录误走空搜索、参数缺失和版本丢失，原始 red 日志保留。首次公网
测试错误假定搜索必有版本，改为显式验证合法 null 并从详情验证固定版本下载；第二次 Node
详情测试的 mock 未匹配相对导入，修正到实际模块路径后，三个阶段全部通过。未修改产品
权限或放宽下载、安装、持久化断言来绕过失败。

WSL 未提供可用 Go，补充 Linux race 未执行，不计通过。Windows 构建保留既有 151 个
Native warnings 及前端 chunk 提示；本轮没有做签名安装器或其他操作系统验收。

原始日志：`.codex-artifacts/clawhub-fix-20261027/`。构建运行与健康收据另存
`runtime-receipt.json`；桌面使用内嵌前端，未启动 2120 开发服务器。
