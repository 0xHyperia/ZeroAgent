# 0033：MCP 客户端对外产品身份

- 状态：独立后续副本实现中，尚未打包或验收
- 范围：Go MCP 管理运行时和临时诊断发出的 clientInfo

旧 Native 使用 ZeroAgent 作为对外客户端名称。切换 SDK 后，上游 Manager 在 Implementation 中使用 k-brain，旧源码的品牌检查无法覆盖实际新请求。新副本将 SDK Implementation 的 Name 和 Title 统一为 ZeroAgent；运行时和 Probe 共用 Manager 的连接路径。

SDK 继续生成 modern 请求元数据和 legacy initialize，并拥有协议与会话。该改动只修正公开产品身份；版本回退、旧 2024-10-07、已识别 modern 错误及共享刷新额度继续由后续协议兼容阶段处理。

真实请求测试使用 SDK 服务端，记录 HTTP POST 的原始 clientInfo 后原样转交；覆盖 modern HTTP、legacy HTTP、SSE 下的运行时和 Probe，运行时还执行真实工具调用。验证发送出去的 initialize、discover、tools/list 和 modern tools/call 身份，不以构造器常量断言替代。

第八版源码、清单和候选在验收期间保持冻结。后续实现只修改独立副本；在全包、补丁复现和对应候选验收完成前，不以本决策宣称切换完成。
