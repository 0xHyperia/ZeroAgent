# CloudChat 开发进度

## 2026-10-29：按 ADR 0049 继续 ZeroAgent 主线，统一对话框架

- 用户选择当前 ZeroAgent 为主线，选择性移植 LibreChat 对话实现；运营角色/分组/配置管理/审计与语音不列入当前 CloudChat 完成条件。保留七类工作流程、账户/设备边界、正常持久化与生产保障，不以减少目标代替真实任务验收。
- 复用共享标题栏、Button、DropdownMenu 和 Sheet，将八个独立按钮收拢为资料及对话菜单。文件/成果/来源/项目/记忆统一右侧资源面板，宽屏不遮罩并可同时编辑草稿，窄屏模态；原有操作保持可达。
- 从固定 LibreChat 源码直接适配滚动到达/离开滞回判定，保留 MIT 版权和全文，并随 Web 公共资源打包。无 MongoDB、第二 Agent 循环或 LibreChat 应用后端。
- `.codex-artifacts/cloudchat-ui-unification-20261029/` 记录本轮截图、失败/复测日志、来源摘要与 verification.json。整套 Web 1129 项通过、0 失败/跳过；最终非模态返回聊天的局部调整另有 3 项通过。Web/共享 UI/Desktop 类型检查、严格 Biome、产品契约、UI 边界与 Web 构建通过。
- 浏览器检查实际新构建的资料菜单、宽屏并列/同时编辑、Escape 焦点返回、390px 无横向溢出和深色主题。仅本地前端预览 `http://127.0.0.1:52386` 连接既有隔离 Gateway；没有重建或替换运行中的 Gateway 镜像、Native 安装包，不代替 Android 真机或完整外部工作流验收。未推送、发布或部署生产。

总目标 active。不以本轮、阶段或窄测试完成重定义终点。原 main 开发，不推送/发布/部署。

## 2026-10-29：长历史、离线终态及代码 ZIP 补齐

- 审计发现普通历史固定500条、刷新只恢复active Run、ZIP在上传入口被拒绝，三项均影响已确认的用户场景，不能用已有协议测试替代。正在补全上传→隔离解包→实际测试→差异交付、metadata游标分页及离线终态呈现。
- 新增普通会话metadata keyset页（updated_at/id，默认50、最多100），游标校验账户范围；精确user_message_id查询使用独立head DTO，完全省略output/模型请求/公开主题。读取不执行任务，也不覆盖规范历史。账户模型limit偏好采用独立CAS资源，保留显式platform/custom选择和有效自定义数值，避免reasoning更新覆盖；首次未配置返回null，不自动迁移或重置已有本地设置。前端接线及最终生产构建复测仍在进行。
- `.codex-artifacts/cloudchat-history-settings-20261029/`：冻结388份Go输入，官方Linux Go1.26.1下9项新Memory/真实PG18.6/HTTP合同race测试零skip与account vet通过；涵盖513个同时间戳会话、跨账户游标/任务head、未知取消与partial保留、模型偏好并发CAS/配额/指定owned key及跨session读取。该证据不代替尚未重建的最终Web或Gateway镜像。
- `.codex-artifacts/cloudchat-quality-inputs-20261029-v2/`：断网、只读、nonroot的本地固定模板容器离线生成8份质量输入，新增可读中文金额表PNG及无文本层的对应扫描PDF。实际查看PNG确认标签/合计124.75清楚，pypdf确认扫描件无文本；它们将分别验证真实视觉理解和诚实解析限制，不把生成成功或原件SHA当作真实模型质量通过。
- 新Web完整1104项测试、typecheck/Biome/build通过，宿主entry为`index-CGTyxYNV.js`；最终Gateway镜像已重建为`8c32715c…`，Docker内独立entry为`index-vCBxpr3L.js`。真实fresh PG/Redis验证28表、model_limits重启持久、迁移幂等、ready故障恢复、9个401边界及3次SIGTERM0；该环境资源已清理。SDK含ZIP helper的新镜像为`61ff3364…`，15项源码摘要核对及实际容器崩溃恢复通过。完整manifest先写独立私有child事实，模型投影限64KiB后才ACK，避免回收后只剩截断清单。
- 用户已提供专用外部资源并授权：S3最多1GB、USA现账户余额、E2B/Tavily仅现免费计划。凭据仅保存在本机owner-only私有目录，未写源码；SSH只读复用开发平台现OAuth secret，未更改远端配置。账号登录和身份核验成功、模型调用前平台余额10；Tavily初始Researcher配额1000/用量0。E2B实际Console确认剩余$100赠送credit、未绑卡、Hobby，开始受控远端模板验收。
- `.codex-artifacts/cloudchat-external-20261029/r2/`：真实R2官方adapter 32MiB原件完整SHA/中文metadata、真实备份条件gate、冲突PutIfAbsent拒绝覆盖且原字节不变通过。40次请求，应用PUT payload合计33,563,270B，3个专用对象及canary清理确认，pending0；未执行真实数据库恢复。
- `.codex-artifacts/cloudchat-external-20261029/tavily/`：一次真实basic搜索获得Cloudflare官方文档，正式Fetcher核DNS/IP和redirect后抓取22064B/460行原文、摘要及行号一致。未用advanced/extract；即时usage尚可能延迟，不能据此宣称不消费credit。七场景真实模型内容及完整Web链路仍待逐项验收。

## 2026-10-29：启动实际实现

- 确认原工作区干净，main=`b634fefd5194ca3a52082d9cd10fc4c9150ab27d`；读取产品契约和适用决策。
- 已建立 ADR 0048、架构和场景验收台账。
- 已实现持久 Run 存储、服务端执行、规范历史、账户请求去重、执行代次、显式取消、断线重放；Web 及 Android Native 有界流式接线。生产 Web 构建的真实浏览器操作已验证发送、增量输出、刷新接续、停止后保留部分输出。
- S3 官方 SDK 适配器、原件元数据及删除清理流水线已实现。原件通过独立读取完整性校验；UTF-8 文本可形成有行号的模型上下文和账户受控引用摘录。官方 E2B SDK/Go 客户端的 32MiB 分块传输、PDF/Office 隔离解析、持久解析阶段与删除取消已通过协议/真实本地 Linux 夹具和真实 PG 验证；真实 E2B 模板、执行和费用仍未验收。图片以 vision_ready 保持零 OCR 文本，只在原件复验后发送视觉字节；生产浏览器验收已通过。
- Web 托管密钥列表/创建仅返回遮罩元数据，复制按指定 ID 实时校验平台密码与当前账户；切号、退出及轮换竞态均检查。登录刷新协调及退出失败重试已验证，不承诺平台 legacy access JWT 可单独立即撤销。
- 外部条件：已建立本任务专用的真实 PostgreSQL 18.6、Redis 8.2.10，私有连接仅保存在 ignored artifacts。当前没有 E2B/S3/USA 测试配置与付费额度；已集中询问，独立实现继续。未调用收费服务。
- Web 已接持久附件/文件库/原文行/下载、编辑/重生/分支、Markdown/JSON 导出、项目/显式记忆。分支原子复制选中前缀，不覆盖原对话，继承项目，丢失回执按原请求回查。项目指令、已关联资料与主动开启的记忆形成新调用的 fresh context，公开 provenance 只含 ID/版本/摘要。
- Go 唯一模型/工具循环已集成：执行、文件载入、成果发布与搜索/网页/来源工具均先记稳定事实。Parser/会话共享账户按日分配预留，同一次未知分配不造新 VM；Parser 支持按原 create ID/scoped metadata 对账并确认全部终止。Memory/真实 PG 与实际本地 HTTP 合同通过。
- 成果具有不可变版本、所属会话/任务和账户库，跨新会话/新 VM 载入旧版修改后沿同 family 生成 v2，旧版字节保留。成果库已增加真实 keyset 分页及失败恢复。搜索摘要与网页正文快照明确区分，行号引用打开账户内正式快照。
- 模型参数/推理档位已冻结到 Run/hash/PG 事实并接 Web send/edit/regen；Cloud 明确使用平台支持的 CC 路径与有效缓存配置，设备设置能力保留。历史通过 heads/有界正文分页读取，超大消息显式按需取回；模型窗口包含明确遗漏范围，`read_history` 受控查阅当前会话，未生成持久摘要。
- 执行限制改为启动配置：初始 2 worker、15 分钟、12 模型轮、32 工具调用；VM 仍单次 300 秒。单账户入场、公平 claim 和拒绝后的草稿恢复已接，默认初始 1 执行/20 排队，跨进程 policy 由 PG 记录；SSE 连接另有可配置的全局/账户上限。
- SDK journal 改为私有 SQLite WAL/FULL 按 ID 读取；Gateway 持久保存终态后 ACK 回收大结果，ID/hash/scope 长期保留，旧 ID 410 不重执行。已加真实 SIGKILL/重启、迟到 checkpoint 不能覆盖终态、稳定 scopeKey/namespace 错配拒启及内部 token 可轮换测试。此处不是新增 CloudChat 数据权威。

## 当前有效验证证据

- `.codex-artifacts/cloudchat-final-linux-20261029-003423/`：官方 Linux Go 1.26.1 冻结输入上全模块 race/vet 通过，26 包、1050 个父子测试 pass 事件、0 fail、7 个明确 opt-in skip；后续实际 Go 修改仍须定向复验。固定 10 账户×3 任务的本地协议负载，2/4 worker 均无重复或丢失，首轮覆盖全部账户、每账户最大执行 1；这不是外部模型/E2B SLA。
- Run Memory/PostgreSQL、Session Memory/Redis 同合同测试全部通过；真实 PostgreSQL 发现过空 usage 扫描缺陷，修复后保留失败及复测记录。文件 Memory/真实 PostgreSQL 合同和真实 SDK → 本地 S3 协议 → HTTP 的生命周期/故障测试通过。
- 新增 HTTP 回归验证过期刷新只轮转一次、迟到刷新不覆盖新 Cookie、越权不消费令牌、退出清理失败保留重试入口但撤销本地权限，以及完整性、删除竞态和引用账户隔离。
- Web Run 协议/DOM、移动流、托管密钥客户端与 React 交互测试及完整 typecheck 通过；Android aarch64 `cargo check --locked --lib` 和 Windows 移动桥定向 Rust 测试通过。尚无真机验收。
- `node scripts/check-zeroagent-product-contract.mjs` 通过；新增所有权/功能映射更新后需复验。
- `.codex-artifacts/cloudchat-browser-20261029/browser-verification.json` 与截图记录本地生产构建浏览器证据；`.codex-artifacts/cloudchat-infra-20261029/` 保存真实数据库/缓存合同日志、源清单。它们不等于外部模型、真实 S3 或 E2B 验收。
- `.codex-artifacts/cloudchat-browser-files-20261029/`：生产 `index-D1HbUZWR.js` 真实 chooser 上传中文资料、模型收到同一原件摘要、引用打开 L1–L3、浏览器下载 SHA 匹配、重生保留草稿/原对话、JSON 导出规范消息与同一 file ID。此处模型和 S3 为明确的本地协议服务。
- `.codex-artifacts/cloudchat-browser-work-20261029/`：生产 `index-YrkoGRAV.js` 浏览器验证正确的重生说明、生成期间保留草稿/有效停止、项目创建与归属、显式记忆默认关闭/保存/开启、编辑分支继承项目。发现并修正项目面板默认选择问题：DOM 回归通过，下一生产构建复查未完成。
- 用户流程驱动的修复：重生确认不再描述删除原对话；Cloud 不显示未实现的队列操作；分支标题避免重复后缀，编辑分支使用新问题摘要。既有 Desktop 默认排队与替换语义保留。
- `.codex-artifacts/cloudchat-browser-artifacts-20261029/`：`index-C_QIu-Ln.js` 浏览器正式生成 v1→下载→新会话引用→不同 VM 载入→v2→旧版再下载 SHA 不变→刷新仍在；项目面板自动选择已归属项目已复查通过。第一轮本地 S3 夹具 metadata 约定错误保留为失败证据，修正后复测通过，未放宽正式产品校验。
- `.codex-artifacts/cloudchat-browser-research-20261029/`：`index-CsGWYMID.js` 浏览器搜索→抓取→行号引用→原文 L1–L2，搜索摘要明确“未抓取网页正文”；图片 chooser 上传→视觉模型收到同 SHA 的 68B 合成 PNG，文件库明确无文字原文。模型/搜索/S3/SDK 均为本地对等夹具，不代表内容质量或真实收费链路。
- 最新完整 Web 两批测试共1072项、Desktop共享操作11项、最终大消息相关63项及typecheck/Biome/build通过。最终本地bundle为 `index-1iys3zOB.js`，SHA256 `2ba539b8a28b2431c734004139926ab4ecd19f9454ae0a178a7792ad6d922f44`。
- Node 全套 31 项（含真实 WSL Python 32MiB/PDF/Office，零 skip）通过；随后两项 journal guard 新增回归通过。`.codex-artifacts/node24-linux-journal-20261029/` 记录官方 SHA 核验的 Linux Node24.14.1，最新 17 项 journal/service 与额外 POSIX 权限验收通过，含源码前后 hash。无真实 E2B 分配。
- `.codex-artifacts/cloudchat-browser-large-fixed-20261029/`：`index-CslhmT5o.js` 浏览器复测超长消息分段、完整 TXT 下载摘要、关闭后 DOM 4674 字符/AX 75ms及草稿保留；PNG 实际解码320×180、下载摘要匹配，390px 对话/成果布局无横向溢出。首轮整串进入 DOM 的失败保留在旧 `cloudchat-browser-history-chart-20261029/`，没有删除失败案例。
- `deploy/cloudchat/` 候选overlay静态Compose合并校验、最终SDK镜像及实际容器崩溃恢复通过：只读/nonroot/断网/SIGKILL137/换hostname恢复、未知回执/410去重、token轮换和scope错配拒启；最新COPY/envd/cleanup-only均已重建验收，演练资源按任务身份清理。
- `.codex-artifacts/garage-s3-3911c96a83e04251/`：真实 Garage v2.5.0，32MiB Put/Get/Head/完整摘要、重启、无效签名、原件 HTTP 中文文件名/下载/外账户拒绝/删除已过；无外部存储和费用，不代表远端 IAM/TLS/冗余或选定生产厂商。
- `.codex-artifacts/cloudchat-backup-conditional-garage-20261029/`：补充真实条件写入严格失败：原件首次写入/摘要/metadata正确，带不同bytes再次`PutIfAbsent`却返回nil而非`ErrTargetNotEmpty`；立即失败，没有假称确认原件是否被覆盖，没有执行后续重启verify。Garage运行时互通通过不等于支持备份恢复的条件写语义；该原始失败已保留。
- `cloudchat-backup-conditional-guard-20261029/`与`cloudchat-backup-conditional-guard-garage-20261029/`：强制恢复前/直接Put的有界singleflight探测已完成。完整Linux真实PG/Redis/Node的原DR及新0/1对象场景、并发/取消/未知/清理负例通过；不支持时在pg_restore之前拒绝，正式PUT0、DB空、认证/journal/config不变。真实Garage socket记录2/2条件PUT均有`If-None-Match:*`，私有探针确被改写；确认nonce/完整SHA后精确清理，再次启动服务仍安全拒绝。此处通过的是门禁拒绝，不是Garage条件恢复支持。清理状态与能力分类分别报告，不做普通PUT降级。
- `.codex-artifacts/cloudchat-backup-20261029/`：一致备份/受保护配置/SQLite journal 与隔离 PG/Redis/本地 S3 协议恢复演练通过，旧 cookie/device/Run 授权被撤销，unknown/retired 回执保留；补充实际 PG 恢复未来时间历史的单调消息排序测试已通过。
- `.codex-artifacts/cloudchat-template-20261029/`：固定官方镜像及 wheel hash 的 E2B 模板候选，在断网 nonroot/只读本地容器生成 PDF/DOCX/XLSX/PPTX/PNG并核对合计124.75及解析定位。中文默认缺字和CFF/PDF兼容负例保留，最终固定SHA的官方Noto TrueType默认中文PNG/PDF及文字提取已过，Poppler零警告；字体仅build期安装，不在Git中保存17MB二进制。未进行远端 E2B build/allocation；provider envd、远端模板及执行仍待验收。
- `.codex-artifacts/cloudchat-executor-reconcile-final-20261029/`：最新 SDK Node35项零skip（含真实Linux Python）/tsc、重建镜像 `sha256:15789543dc587c41f15b019c70d2890379e07136fa60c95ec43d451cd466239c`、41次内部HTTP的完整容器smoke、14文件source audit通过；相应源码含envd≥0.5.2执行检查和精确create HMAC的cleanup-only发现，网络/版本漂移不隐藏owned VM清理身份。Parser Memory+真实PG和Run定向HTTP验证不借观察恢复执行。
- `.codex-artifacts/cloudchat-startup-redaction-20261029/`：实际编译CLI拒绝含合成密码的畸形DSN并退出1，启动日志不再转发可能含完整DSN的driver错误；没有连接实际应用数据。
- `.codex-artifacts/cloudchat-quality-inputs-20261029/`：离线生成六份内容验收输入及独立基准，实际执行代码夹具两项测试确认原版本确实失败；未调用真实模型，不标为质量通过。
- `.codex-artifacts/cloudchat-browser-public-final-20261029/`：最终宿主bundle真实浏览器复查每Run公开主题确认、取消保留草稿、编辑主题持久快照、4轮合成研究后原文L1–L2引用、none关闭及xhigh刷新/实际发送保存、刷新后联网默认off。确认前0Run/0model，移动确认取消不增任务；390px无溢出/确认按钮可见，控制台0error。此处模型/搜索仍为本地对等夹具。
- `cloudchat-production-review-20261029/public-calendar-result.json`：修复公研阶段误将相对日期固定到UTC的回归。真实Go loop HTTP捕获证明UTC2026-12-31T16:30Z、HK偏好下提供2027-01-01日历基准及真实UTC时间，但不发时区ID/locale/私有canary；private完整指导保持，单位/HTTP/聚焦Linux race/vet通过。
- `.codex-artifacts/cloudchat-gateway-final-20261029/`：完整Gateway镜像及隔离A/B/C实跑：实际UID10001/GID999/0700、只读/cap0/no-new-privileges、嵌入静态资源及401、全新PG18.6/Redis8.2.10的27表、缓存故障ready503/恢复200、Gateway重启数据保留、真实Garage signed HEAD ready200；接SDK缺key时如实ready503、health200、0操作/分配、优雅退出0。候选appversion与宿主构建不同，嵌入bundle另有独立摘要，不能混同本地CUA的bundle。任务容器/卷/网络及合成凭据已清理。
- 本任务专用WSL PostgreSQL/Redis在完成验证后已通过原PID、启动时间、可执行路径及owner marker核验并优雅停止；测试数据与证据保留，未修改其它服务。所有浏览器协议fixture已关闭。
- `.codex-artifacts/cloudchat-gateway-context-final-20261029/`：补充排除各层级`.codex-artifacts`后，最终本地Gateway索引为 `sha256:042c472c236a9c57b5adb3ea11b1826e841b87b95e71b268c8862eb16c318937`；与A/B/C验收版本的runtime platform manifest/config完全相同，独立StageA再次核对binary及37个嵌入资源摘要一致。变化仅为构建attestation/index，不重复宣称新数据库验收；最终源观察清单明确不是逐层context证明。
- 最新可用主镜像以 `cloudchat-gateway-calendar-final-20261029/result.json` 为准：本地tag `zeroagent-gateway:cloudchat-local`，索引 `sha256:9826237af12a864a5c75e1aaa83f0724b993e8d6ab680a825db27bde1c5ea2c6`，binary SHA256 `19808fb4059d051efb4a9912b8b62658ebdb1abd3085f986cb0657a059b0d8f7`。已包含公研日期修复并完成一次新StageA；37个前端资源与既有Docker版本一致。原A/B/C基础设施证据保留，不重复宣称重测。
- 独立Linux备份CLI位于 ignored `cloudchat-backup-cli-final-20261029/`：CGO关闭的linux/amd64产物SHA256 `d3df5cdc43801f8b09e254939a627d6c5ee1224fa9b8b31a4c4b7746f5f3564b`，实际Linux无私有配置时只返回静态错误并退出1；需要显式私有配置、Node24及PG原生工具。Gateway依赖图不链接该独立CLI包。备份探针测试基础设施也已核验停止，旧PGdata保留、旧Redis4文件摘要不变。

## 当前能力边界与剩余验收

- 长历史当前采用完整持久历史、分页和受控查阅；未生成持久语义摘要。任务可重放进度/准确取消，正式成果已能在原VM终止后从新会话/新VM接续；不宣称透明恢复原VM内存或跨generation自动继续未知操作。真实基线任务若无法完成，将继续改进实现，不以下调验收替代。
- SDK 当前单 Gateway/sidecar 固定成对路由，多实例调度尚未开放。已有有限本地容量基线及隔离完整恢复，真实并发/费用和生产存储恢复仍需校准。
- 账户独立“平台默认/自定义”UI及CAS持久已实现，默认模式同时省略两个limit，未配置账户保持原本地设置。具体模型参数支持及缓存命中仍需真实平台能力验收。
- 生产审查的content/cache白名单、恢复消息顺序、取消未知终态和公开研究阶段隔离已完成Memory/实际HTTP/PG/Redis及相关Linux race/vet复验；Web每Run公开主题确认及thinkingEnabled映射已完成最终构建和真实浏览器复查。
- 真实模型内容质量、E2B模板及完整远端执行、Android真机及实际业务容量仍未最终验收。真实R2完整性/条件写和Tavily搜索抓取已具局部证据，专用配置与额度现已到位；Gateway/SDK完整候选镜像已本地构建并实跑，正在启动真实OAuth的隔离本地Web。未部署生产、未推送。

总目标仍为 active。完整七类场景、内容质量、资源成本、恢复演练和关键真实外部服务均未达到最终验收，不是生产候选交付。
