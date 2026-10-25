# 0031：MCP 进程和阻塞 I/O 的拥有期

- 状态：Windows/Ubuntu WSL2 MCP 运行与锁定平台交叉编译通过；macOS 运行和完整应用验收待完成
- 范围：Go MCP stdio 客户端、SSE 清理通知和支持端进程生命周期

锁定 SDK 的 CommandTransport 关闭 stdin 后等待并直接杀主进程，未调用已有
process.Configure 所设置的进程树 Cancel；其 stdout 为不关闭的包装。
阻塞写入若不能响应调用取消，Manager 等待调用结束后才关闭会话会形成等待环。

改用 SDK IOTransport 保留 JSON-RPC 和协议实现，单独拥有命令、管道和进程树。
取消进行中的写入使部分消息不可恢复，终止该会话并先回收树再关闭管道；
普通等待结果的取消继续使用 SDK 通知。取消通知的独立预算为一秒，不改变正常
工具预算。关闭先提供最多三秒 EOF 退出机会，保留根身份到回收树后才执行 Wait。
stdio 的未完成启动失败也必须回收已启动命令，不退回无拥有期的启动路径。

Windows 进程以暂停状态创建，加入匿名、关闭即回收的 Job 后恢复主线程，
避免首次运行和 Job 绑定之间创建未绑定后代。Job 不允许 breakaway，嵌套受宿主
系统约束；绑定或恢复失败时回收暂停进程并报错。关闭 Job 的拥有句柄不交给子进程。
实现依据 [创建标志](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)、
[Job 分配](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)
和 [恢复线程](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-resumethread)。
Unix 沿用独立进程组，Linux/Darwin 观察未回收根的退出状态后再清理进程组。

Windows cmd/bat 使用显式 cmd.exe 参数转发，关闭自动运行和延迟变量展开。
对 argv 先作 CRT 反斜杠/引号编码，再对 shell 元字符作两层 caret 转义，
覆盖 cmd /C 与常见 npm/npx 批处理 %* 转发的两次解析；脚本路径仅转义一层。
支持空参数、引号、反斜杠、百分号及 shell 字符。NUL/CR/LF 显式拒绝，
避免换行截断为另一条批处理语句；不声称任意脚本自行拼接参数后仍可恢复原值。
支持配置 cwd 中的命令及 home 路径。

首次真实运行证明，照搬旧 Native 的双引号翻倍算法会让 Go 的旧式 argv 解析器
把后续参数合并；CR 在批处理转发时也未保真。该失败源码和日志保留，不能用
静态字符串测试代替实际参数接收。新算法参考 [cross-spawn 实现](https://github.com/moxystudio/node-cross-spawn/blob/master/lib/util/escape.js)，
Go 的解析差异见 [Go 源码](https://go.dev/src/os/exec_windows.go)，
CR/LF 拒绝也与 [Rust 当前批处理入口](https://github.com/rust-lang/rust/blob/master/library/std/src/sys/args/windows.rs) 一致。

SSE 也经过现有独立清理预算包装；此前仅 Streamable HTTP 经过该包装。
验证必须覆盖挂起取消 POST、未读取 stdin 的实际子进程、正常 EOF 和根退出后
仍存活后代、窗口隐藏、批处理特殊参数、失败启动/绑定清理和跨平台构建/运行。
专项不代替实际账户、对话、应用和完整平台矩阵。

Windows 全 MCP 与选定 backend 范围共 148 个通过事件，0 失败，2 个原有条件跳过；
实际 batch 的 Go 接收、Node .cmd/.bat 转发、阻塞写入和根退出后的后代回收通过。
新补丁和候选仍以同步报告中的来源及验收回执为准。启动/Job 分配失败注入、
GUI 进程中的 PATH/代理继承与非 Windows 实际运行仍需补齐，不能仅据交叉编译关闭这些项。

Ubuntu WSL2 实际运行完整 MCP 包 123 个通过事件，0 失败、2 个原有自托管条件跳过；
使用本轮交叉编译 ELF 的原字节，临时副本和独立数据目录在执行后清理。
这补充了 Linux 进程组运行证据；macOS 与完整桌面包验收仍待完成。

Linux amd64、macOS ARM64/x64 的 MCP 测试二进制均编译成功；对应 ELF/Mach-O
架构和来源在归档前另行校验。macOS 二进制未在本机执行，不计为运行通过。

后续重复验证发现，完整 Go 测试程序的冷启动会挤占 batch 参数用例的五秒期限，
即使 argv 已完整输出也可能在进程退出前被期限终止。后续参数用例以真实 cmd
批处理转发、Unicode echo 接收和 Windows 原生 argv 解析逐项比对，并以原连续引号
错误作反例；五秒期限保留。端到端 Go 子进程和后代回收继续由独立生命周期用例验证。
依据 [cmd 的 Unicode 输出参数](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmd)
与 [CommandLineToArgvW](https://learn.microsoft.com/en-us/windows/win32/api/shellapi/nf-shellapi-commandlinetoargvw)。
这些后续夹具调整在独立第八版副本中进行，第七版不可变证据保留原测试源码。
