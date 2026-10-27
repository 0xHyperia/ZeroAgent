# 2026-10-27 缓存提示默认值与模型继承验证

本轮仅本地修改、测试、构建运行，未推送、打标签、发布或部署。依赖仍为已合入的
LiveAgent beta.23、K-brain `60e614f07c600b7aa5c0acbb9631d708e33dbb8b`。
决策见 [ADR0045](../product/decisions/0045-prompt-cache-provider-and-model-inheritance.md)。

## 最终行为与来源

- 新建托管 OpenAI 分组默认 `auto`；模型缺省没有覆盖，界面显示“继承供应商设置”。
- 保留已有四种明确模式、旧 `promptCachingEnabled:false`、模型覆盖及启停/排序。
  历史关闭值缺少操作来源，不能猜测其为旧默认而批量开启；没有修改真实账号配置来验收。
- 模型覆盖优先于供应商，模型的 `auto` 与“继承”不同。清除覆盖通过空字符串写入，
  重启回读后缺省字段仍表示继承。共享模型 ID 的配置保持供应商隔离。
- 采用上游最后的 `codexPromptCache.ts`（`7cfd13da^`）规则：Responses 的自动模式
  使用会话缓存键；Chat Completions 按主机识别官方 OpenAI/OpenRouter，未知主机不加
  提示。手动 OpenAI 模式发键，OpenRouter 模式只发 `x-session-id`，none 不发提示。
- 复用现有 Go 缓存传输器、端点能力和安全缓存键散列；保留声明支持的 Anthropic 块
  缓存 TTL。官方且声明支持的 Responses 端点可保留显式 no-cache；未知中转不强加它。
  不发送缓存提示不等于服务端没有隐式缓存，本轮没有测量实际命中率、延迟或账单。
- 第九补丁补齐 Go 模型字段、校验、存储和普通/故障转移路由；前八补丁字节不变。
  Native 代理仅新增受控 `x-session-id` 转发，平台地址、凭据、账号及配置版本边界保持。

## 自动化

日志保留在本地忽略目录 `.codex-artifacts/prompt-cache-alignment-20261027`。

| 检查 | 结果 |
| --- | --- |
| `pnpm test:gui` | 全量 3,643 通过，0 失败，1 原条件跳过。 |
| `pnpm test:webui` | 全量 883 通过，0 失败、0 跳过。 |
| 三端类型 | Shared UI、Desktop、WebUI 类型检查通过。 |
| Native 完整库 | `cargo test --locked --workspace --lib`：1,335 通过，0 失败，15 ignored。新运行时项另行显式运行，未把 ignored 当通过。 |
| Go 四个相关包 | config/routing/backend/ai：1,323 通过（含子项），0 失败，4 原跳过；相同范围 vet 通过。 |
| Gateway Go | `go test -json ./...`：21 包通过，552 测试项通过（含子项），0 失败，1 原跳过；设置包 vet 通过。 |
| 构建/来源脚本 | 57 通过，0 失败，2 Windows 原跳过。 |
| 静态检查 | 改动 TS/TSX 的 Biome、UI 边界、rustfmt、diff hygiene 与产品契约（15 功能/83 规则）通过。 |

新增用例覆盖真实共享表单默认继承和选择覆盖、两端默认值/刷新保留、继承的显式清除、
Gateway 双向投影、落盘重开、无关更新保持、非法模式拒绝、同 ID 供应商隔离、普通及
真实 HTTP 故障转移出站请求、OpenRouter 头长度和兼容块缓存 TTL。

## 真实 Native/后端运行时

显式执行
`native_prompt_cache_settings_reach_brokered_requests_after_restart --ignored --nocapture`，
使用按补丁清单真实准备的 Windows Go 后端、生产 Native configuration facade/coordinator、
托管凭据 broker、实际前端设置投影及 HTTP client。所有模型响应来自自有 loopback 服务，
没有调用付费平台模型。

三个阶段均通过：A 首开、A 正常关闭后重开、独立 B profile。合计 65 个合成本地模型请求，
逐次确认只提交一次，并核对实际平台端看到的缓存键、会话头及不应存在的参数。
测试同时验证提供真实读取版本的配置保存、重启后的供应商与模型模式、模型 auto 覆盖
供应商 none、清除覆盖后恢复 none，以及 B 账户仍为默认 auto/继承。私有凭据只由 broker
注入；请求捕获仅记录合成凭据是否匹配。

运行时还复现已有默认投影缺陷：`ActiveModels=nil` 时先遍历 Go map 生成列表、再排序
模型，导致同一未变配置的读取版本可能变化。现仅对缺省派生列表使用已经排好的模型，
显式启用列表及其顺序不改；稳定读取回归与完整运行时通过。未放宽版本校验或重试陈旧保存。

先行日志保留了文件占用导致的构建失败、测试模块路径修正、未携带配置版本的 428、上述
默认投影导致的 412，以及模拟服务 URL 双斜线的夹具错误。最终测试使用真实展示文档的
版本保存；没有用跳过、放宽断言、自动借用新版本或收费请求替代验证。

## 构建与运行

WebUI 生产前端和 Windows 内嵌前端 debug/no-bundle 构建通过；正式安装器、签名及其他
平台验收不属于此次证据。实际打包侧车与九补丁来源收据的哈希核对通过。

本轮已正常替换工作区构建并启动 `target/debug/zeroagent.exe`（PID 60672），其 Go 子进程
PID 60420。本地 Gateway 已按原开发配置更新重启；Gateway healthz/readyz、WebUI
`http://localhost:5174/` 均为 HTTP 200，桌面 Vite 2120 监听数为 0。
继续使用原本地 Gateway 与 `http://172.16.0.121:5173` 平台开发环境。

没有操作桌面界面或等待人工验收；上述自动化不等同于用户实际界面的视觉确认。没有清理、
迁移或覆盖原账号数据，不宣称旧后端可直接读取新增可选字段或提供版本回退。
