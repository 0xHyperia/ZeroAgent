# CloudChat 模型调用契约核对

核对日期：2026-10-29。范围为当前本地源码和隔离协议测试，不代表线上部署、真实账号权益或付费模型验收。

## 已核对的来源

平台只读工作区为 `D:/code/usa0/src/sub2api`，HEAD 为
`d24386212451a16fcb694baee016dae7eba79b2d`。下列行号对应本次读取时的工作区文件；不能以平台名称猜测调用能力。

- `backend/internal/server/routes/gateway.go:234`：固定平台 `/v1/chat/completions` 按分组平台派发到 OpenAI 或通用 Gateway handler。
- `backend/internal/handler/gateway_handler_chat_completions.go:305`：Gemini 交给 `GeminiMessagesCompatService.ForwardAsChatCompletions`；315 行走 Antigravity；317 行走 Anthropic 兼容路径。
- `backend/internal/service/gateway_forward_as_chat_completions.go:47`、73 行：Chat Completions 经 Responses 转 Anthropic Messages，并转换回客户端 Chat Completions 响应。
- `backend/internal/service/gemini_chat_completions_compat_service.go:25`、54 行：客户端仍使用 Chat Completions，服务端转为 Gemini 原生调用。47 行明确不把历史 `reasoning_content` 当作 Gemini 思考连续性，不能把它替代 thought signature。
- `backend/internal/service/openai_gateway_chat_completions.go:133`：按服务端 account 的协议与模型能力分流到 Anthropic、Chat Completions 或 Responses。该 account 配置不由 ZeroAgent 浏览器提供。
- `backend/internal/handler/gateway_handler_chat_completions.go:111`：ClaudeCodeOnly 且没有 fallback group 时，Chat Completions 直接 403。不得伪造官方客户端身份绕过。
- 同文件 93 行：GPT Image 生成模型不接受 Chat Completions。图像能力不能冒充普通文本模型。
- `backend/internal/service/openai_gateway_chat_completions_raw.go:99`、104 行：部分 GPT 模型在工具或推理加工具时要求 Responses，CC-only account 会明确拒绝。不能在错误后换源或盲目重发。

验证执行：在平台只读仓库运行
`go test ./internal/pkg/apicompat -run 'TestChatCompletions|TestResponsesToAnthropic|TestAnthropicToChat' -count=1`，通过。
这只证明本地协议转换单元测试通过；没有运行真实模型请求，也没有证明所有平台路由、账户配置和线上的模型目录均兼容。

## ZeroAgent 当前行为与缺口

平台上普通文本和 function tools 使用统一 Chat Completions wire 是有源码依据的公共接口；无需在 ZeroAgent 再实现三套模型或 Agent 编排。平台可能拒绝某分组、模型或功能，这仍须保留为明确错误。

本轮已经接入唯一的 Go 工具循环，初次审查时发现的“工具增量立即失败”与“length 当完整结束”已修正。实现入口为 `crates/agent-gateway/internal/account/cloud_run_runtime.go` 的 `generate`，循环在 `cloud_run_model.go:98`；模型请求始终由服务端解析当前 owned key，走固定平台 `/v1/chat/completions`，不自动换源、换协议或重发失败模型请求。

`cloud_model_stream.go:99` 的有界 SSE 解析器累计 index/稳定 ID/name/arguments，只有明确 `tool_calls` 终止且完整 JSON 校验成功后才给执行器调用。`[DONE]` 不补造成功终止。`length`、`content_filter`、连接截断分别保留 partial/usage 并返回明确状态。`cloud_run_tools.go` 的 `execute` 先写持久 prepared/执行代次，再执行 SDK；未知结果只查询原 operation ID。工具未在本轮声明时，不产生工作区或外部执行。

代码、命令与文件能力只在 SDK 健康检查明确 enabled 时声明；创建工作区前原子预留账号 UTC 日秒数，文件解析与会话 VM 使用同一稳定 operation ID 预留账本，网络策略由 Go 核验，模型不能选择 owner、sandbox、template、网络或凭据。SDK 缺配置时普通文字仍可用。`cloud_runtime_config.go` 的默认值为 2 workers、15 分钟 Run、12 轮模型与 32 次工具调用；运维配置范围分别为 1..16、30 秒..1 小时、2..32、1..48，启动后不可修改。每次工具超时、参数/返回/文件读取和账号日预算仍单独有界。Run 延长不续 VM 寿命：每次 conversation VM 仍预留 300 秒并在实际 ExpiresAt 前截止。临时 VM 路径不作为下载地址。

`cloud_run_research.go:99` 将搜索次数先记入独立持久预算，搜索摘要与抓取正文分别持久化后才给模型来源 ID；每轮重查删除状态，不能从旧工具结果恢复已删除正文。`publish_artifact` 只有对象存储全量校验后 ready 的不可变版本才给成果引用 `【成果:VERSION_ID】`。这些能力均通过本地实际 HTTP/S3/SDK 协议夹具，不代表外部平台/E2B 付费验收。

联网须在每 Run 显式提供 `public_research:{topic}`（规范 UTF-8 最多 8KiB，缺省关闭），该批准主题纳入请求 hash 和 PostgreSQL 快照。唯一 Go 模型循环先在公开研究阶段仅传批准主题、必要系统指令和此阶段已持久公共来源，不读取项目、记忆、附件或私有历史；仅声明并在执行前授权 search/fetch/read_source。公开草稿不进入可见 output 或 canonical assistant，usage 和来源事实照常保存。结束后单向撤销该阶段 capability，再读取 fresh 私有上下文进行综合；综合阶段不提供 search/fetch，read_source 仅限本 Run 来源，旧 capability 不能重新授权网络。两阶段共用总 round/call/time 限制，至少保留最后一轮综合，不建立第二套循环。取消/未知外部结果仍遵守原事实边界。

## 参数快照与明确限制

`cloud_run_parameters.go` 的 `CloudRunModelParameters` 作为 `model_parameters` 写入 Run 独立 JSONB 列，纳入接受请求的规范指纹，并在恢复读取的小投影中返回。重试使用同一请求 ID 但参数改变会 409；等价缺省值不产生第二条历史或第二次模型调用。保存不包含服务地址、headers、cookie、API/OAuth 凭据。

`cloud_run_replay.go` 将请求身份与执行快照分开：指纹只使用规范逻辑内容、文件/成果引用 ID、模型及参数；服务端补充的资源名称、摘要等可信 metadata 只进入 `RequestContent`。当前会话授权和输入形状校验后，先按账户与 `client_request_id` 查已受理任务，再检查新请求所需的资源和密钥。丢失受理回执后，即使附件、成果已删除或密钥已撤销，相同请求仍返回原任务，改变逻辑内容仍为 409；不会重绑原执行会话、重复历史或模型调用。资源校验失败还会再次查重，以覆盖并发受理窗口；存储故障不当作不存在。返回原任务前复核当前会话，退出或跨账户不能借旧指针恢复读取。Store 事务内仍保留原子去重。此指纹用于当前未发布的新 Run，不增加旧协议 hash 兼容或数据迁移。

文本内容块仅接受 `type/text`，图片块及嵌套对象也使用严格字段白名单，图片 detail 仅 auto/low/high。未知内容参数在接受前 400；模型组装边界再次投影已保存的文本/图片结构，不重写规范历史。浏览器不能通过 `prompt_cache_breakpoint` 等内容内字段绕过缓存参数限制。

| 字段 | CloudChat 当前语义 |
| --- | --- |
| `request_format` | 仅 `openai-completions`；省略采用此值。显式 Responses/其他格式 400，桌面原有格式能力保留。 |
| `context_window` | 0/省略使用平台窗口；显式范围 1024..2000000，逐轮做估算预检。 |
| `max_output_tokens` | 0/省略采用平台默认；显式范围 128..1000000，发送为 CC 的 `max_completion_tokens`，必须小于已设置的窗口。设置窗口而省略输出时固定为 min(8192,window/4)，返回实际快照。 |
| `input_modalities` | `['text']` 或 `['text','image']`；省略保留文本+图片入口。配置文本专用时，图片内容明确拒绝，不能当作已经看见。真实模型是否支持仍由平台授权与能力校验。 |
| `provider_cache_mode` | 缺省 `auto`；仅 `auto`/`none`。 |
| `model_cache_mode` | 缺省继承供应商；显式 `auto`/`none` 覆盖供应商。 |
| `time_zone` | IANA 时区，经 Go 校验并内嵌 tzdata；缺省 UTC，不接受主机相关的 Local。保存到请求指纹。 |
| `locale` | 最长 64 字符的有界语言标签语法（如 zh-HK、en-US），缺省 und；只作偏好，不是城市或授权证据。 |
| 顶层 `reasoning_effort` | `none/minimal/low/medium/high/xhigh/max` 或省略；UI `off` 映射 `none`。实际模型具体档位仍可能由平台拒绝，错误不自动重发。 |

ADR 0045 的 CC 自动模式只对官方 OpenAI/OpenRouter 主机附加提示；固定 USA 自定义 CC origin 不满足此条件，因此这里 `auto` 与 `none` 都不附加客户端提示。这不关闭平台自身的缓存机制，也不承诺命中率。手动 `openai-key`/`openrouter-session` 在不同分组没有一致保证，CloudChat 显式 400，不能套用桌面可用即声称云端可用。

证据：平台 `backend/internal/pkg/apicompat/types.go:665`、`chatcompletions_to_responses.go:61` 定义并传递 `max_completion_tokens`，转换器默认下限在 `types.go:866` 为 128（平台部署可另设下限）；`openai_gateway_scheduling.go:60`、`handler/openai_chat_completions.go:163` 会先提取 OpenAI 缓存身份；Anthropic/Gemini 的 CC 转换路径不提供相同客户端手动缓存参数保证。`chatcompletions_to_responses.go:53` 对推理模型剥离采样参数；当前 ProviderModal/CloudChat 页面没有 temperature/top_p 用户设置，本轮不新增这两个开关，显式未知字段 400。

私有综合的日期指导提供服务端真实UTC时间、已验证偏好时区的本地日期/时间。公开研究仅提供真实UTC时间和解释相对日期所需的日历日期基准，不发送时区ID、locale或本地钟点。客户端只传格式偏好，服务端校验并决定当前时间，也不据此推断城市或权限。香港00:30时的本地日期与UTC前一日分别处理，避免公开研究把“今天”固定解释为UTC日历。

上下文估算使用 UTF-8 JSON 字节/3、每条消息固定开销及每张图 4096 的估算额度，图片 base64 原始长度不当作文本 token。`context.budget` 仅记录估算数、输出预留、窗口和方法，不记录正文；超限返回 `model_context_window_exceeded`，不修改规范历史、不支付新一轮模型调用。它不是精确 tokenizer，平台实际 token/模型窗口仍是权威。

## 有界历史与用户可见的省略

账户模型limit偏好独立保存在`zeroagent_cloud_model_limits`，按user/owned平台key/model隔离，
更新使用expected_version，过时设备返回409。`platform`模式在新Run中省略context/max两个
字段；允许在偏好内保留上一对有效自定义数值供切回使用，不代表将它们发给模型。
`custom`必须同时指定有效窗口及输出上限并保留输入空间，不承诺逐字段继承。
缺失偏好返回null，已有本地设置保持，只有显式保存才写账户资源；普通reasoning/model选择
更新不替换该资源。该偏好不是连接配置，不保存URL、凭据或请求格式，也不改变桌面参数契约。

`cloud_history_*` 将读历史分为消息 heads（ID/角色/时间/字节数/SHA256）和有界正文。PostgreSQL 在数据库内计算 heads，不把每条历史正文拉进 Go；Memory 以最多 101 个浅引用选择一页，不先复制整个会话。普通 Web 分页默认 50、最大 100 条，向前 cursor 绑定当前账户与会话的原有 `(created_at,id)`；正文和 usage 共用 2MiB 页预算，usage 单条另限 64KiB。超预算消息返回 `content_omitted:true/content:null` 与原字节数/hash；显式单条读取仍硬限 32MiB，超限 413，不以截断片段冒充全文。

每轮模型先保留该 Run 用户消息，至多检查其前 63 条 heads；正文默认 2MiB、按已设窗口调整且最高 8MiB。较早未纳入消息形成 `history.context` 选择/省略索引，明确 `not_summarized:true`。fresh 项目指令/记忆仍在每次请求重新读取，不把历史省略伪装成已经总结。必要时可调用无 SDK 也可用的 `read_history`：只读本 Run 当前会话的用户消息前缀，分页 metadata 或返回总共最多 8KiB 的 JSON UTF-8 原始片段，明确 complete/offset/hash。它不等于看见图片像素或解析文件原件。

检索记录在下一次模型请求前重查 owner、当前会话、前缀和 hash；删除/变更后不从旧私有 tool receipt 恢复正文。旧规范历史保持；新用户/助手/通用 append 在会话写锁内取 `max(server now,latest message time+1µs)`，防止同 tick 或时钟回退把助手排到问题前。已有相同时间的历史继续稳定 tuple 排序，不虚构旧顺序、不 backfill。Run 的真实接受时间与其用户消息的逻辑排序边界分别处理。

这些有界读取与明确省略已经接通。长期会话的用户可控持久摘要、语义检索仍需后续设计与验收，当前不声称完成自动摘要。

## SDK 结果回收

取消会核对本 Run 的 executing/unknown 操作元数据和本次执行实际使用的工作区，不扫描操作 Input/Result，也不让其他会话的待清理状态影响当前任务。远端操作结果或工作区终止尚未确认时，保存为 `interrupted/cloud_cancellation_outcome_unknown`，保留 partial 和清理事实；不能因收到取消请求就覆盖为 clean cancelled。只有已确认事实才给 cancelled，未知操作不重发。

Go 在工具结果（或 VM 创建/清理所需事实）成功持久提交后，best effort 调用 scoped `Acknowledge`。失败不改变已经保存的执行结果，未知/执行中结果不 ACK；事实提交失败则保留 SDK 原结果并把 Run 标为中断。已回收 ID 的 410 `operation_result_retired` 仍视为曾执行，不能当作新工作重发。文件解析与成果发布在各自私有步骤事实保存后使用相同边界；没有逐步持久 journal 的临时 load transfer 暂不 ACK。

当前内部 `cloudModelStream`/`cloudModelRound` 已表达安全文本增量、稳定工具调用、usage、finish reason 和类型化错误。协议解析器只做有界输入和事件归一化，不新增另一个 Agent 循环。

唯一 Go 循环在完整收到并校验工具参数后，先保存稳定 operation ID 与 prepared 事实，再调用 SDK。工具结果归入下一轮规范 messages；未知结果查询原 operation ID，不能换新 ID 自动重试。取消与 Run 执行代次继续约束提交。

## 本地协议验证与剩余验收

已通过 Gateway 全套 `go test ./...`、`go vet ./...`，以及 Memory/真实隔离 PostgreSQL 工具账本、参数快照和 public view 同合同。聚焦实际本地 HTTP 夹具在 `cloud_run_tools_test.go`、`cloud_run_research_test.go` 与 `cloud_run_parameters_test.go`：碎片多工具与累计 usage、跨轮文件操作、跨账号、取消远端执行并清理 VM、未知效果不重发、凭据/authority 参数不进 SDK、SDK 禁用仍支持文字、400/401/403/500 不重试不改端点、来源先持久后引用、删除来源不恢复、搜索未知不二次消费、成果 S3 校验及真实鉴权下载。成果续改会真实终止旧 fixture VM，在新会话/新 VM 从校验后的 S3 原版上传，再发布同 family 的新不可变版本，旧版字节与归属仍保留。另有 6 轮模型/5 次工具完成、配置上限保 partial 不多执行、参数规范去重与冲突、无效参数 0 模型调用、估算超限不截历史、文本模态拒绝图片的回归。

继续保留以下协议验收要求；不能把本地测试通过等同于全部生产能力完成：

- owned Anthropic/Gemini 元数据仍向固定本地平台 origin 发送 CC，请求与 usage/工具 SSE 的结构符合真实兼容层；不得依赖假成功替身证明线上兼容。
- 参数跨多个 SSE 事件拆分、两个工具并行出现、工具后仍有文本：只在参数完整且 JSON/schema 有效后执行，每个稳定调用至多准备一次。
- 403 ClaudeCodeOnly、400 图像模型/格式不支持：保留明确错误，不伪造官方身份、不换第三方 URL、不重发可能已计费的请求。
- 流中断、丢失终止、未知工具结果：保留已提交 partial/usage，并准确标识 interrupted/unknown。
- 区分 stop、tool_calls、length、content_filter、上游 error；不能把 length 或没有完整终止的连接当作完整完成。
- 参数快照、内容指纹、模型权益、跨账号、退出/刷新、输出 secret 反射及取消竞态，必须从真实生产入口验证。

生产凭据、付费模型、实际平台分组权益、E2B 外部执行及设备真机验收仍须单独记录，不能由上述本地测试推定完成。
