# Windows 内网安装包构建记录

- 日期：2026-10-27（Asia/Hong_Kong）。用户要求构建安装包，未授权本轮安装、提交或推送。
- 基础提交：`bfefe7523f789afea85f9ef943fc0265ef07453a`，附本轮远程访问构建默认值修复。
- 版本：`0.4.0-beta.2+lan.20261027`，Windows x64 / NSIS。
- Gateway：`http://172.16.0.121:5174`；USA-Zero / ZeroAPI：`http://172.16.0.121:5173`。

两个来源均固化进程序。按 ADR0036 使用 debug 构建允许精确的私网 HTTP 来源，内嵌经过
生产前端构建的桌面页面，无需桌面 Vite。正常正式构建的 HTTPS 限制保持。远程设置原先仅
读取进程环境，导致快捷方式启动时回到官方 Gateway；现按运行时有效覆盖、编译默认值、
官方默认值的顺序解析。空白运行时值不遮蔽编译默认值。远程访问仍由用户开启，不修改账号
数据、设备凭据、托管模式或当前配置格式。

## 自动验证

| 检查 | 结果 |
| --- | --- |
| Native 完整库（官方默认构建） | 1,336 通过、0 失败、15 项既有 ignored。 |
| 内网构建的真实设置函数 | 1 项通过；子进程分别清空运行时变量、提供显式覆盖、提供空白值，验证构建默认值和覆盖优先级，不修改父进程环境。 |
| 前端类型与构建 | 桌面和内嵌 Gateway WebUI 均通过。 |
| Windows 内嵌构建及 NSIS | 通过；简体中文/英文安装器，未生成 updater 签名产物。 |
| 来源与载荷 | 打包目录中的后端和 Computer helper 匹配固定 pin、9 个补丁及 SHA 收据；Native 产品版本及编译地址检查通过。 |
| 仓库检查 | 产品契约 15 功能 / 83 规则、rustfmt、`git diff --check` 通过。 |
| 远端匿名 API 探针 | Gateway `/api/status` 和 `/api/desktop/environments` 返回 JSON 401，Sub2API `/api/v1/settings/public` 返回 JSON 200。未使用用户凭据。 |

Gateway 5174 的根页面是开发 WebUI，`/healthz` 和 `/readyz` 返回 HTML fallback，
不计为后端健康或依赖就绪证据。没有修改远端服务配置，没有发起真实模型或收费请求。

首轮 Native 构建因上一份工作区程序占用 sidecar 而失败。结束精确属于本 checkout 的程序
及其自有子进程后，原检查完整通过；没有关闭其他产品或放松断言。已有编译 warnings 保留。
NSIS 对非数字 build metadata 的 Windows 数字版本字段使用 0，完整产品版本字符串保持。

## 交付

`dist/windows-lan-20261027/ZeroAgent_0.4.0-beta.2+lan.20261027_Windows-x64-Setup.exe`

- 大小：55,838,554 字节。
- SHA-256：`9b0e191f9e9febdde995e04e6482aa37917435c9afbca8824f9344048de0750f`。
- Authenticode：`NotSigned`。本轮不使用或更换正式签名材料。
- 同目录保存 `SHA256SUMS.txt` 和 `build-receipt.json`。
- 私有构建脚本和原始日志：`.codex-artifacts/lan-windows-installer-20261027/`。

仅生成并检查安装包，不自动安装、操作桌面界面或等待人工验收。实际安装、OAuth 登录及
设备连接由用户操作；本地编译和匿名接口探针不替代这些验收。未提交或推送本轮源码变更。
