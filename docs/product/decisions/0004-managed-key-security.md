# ADR 0004：托管密钥必须二次认证

- 状态：已采纳
- 范围：Desktop、WebUI、USA-Zero 集成

## 决策

USA-Zero 托管密钥可以同步到 ZeroAgent Provider 设置，但界面中必须保持遮罩。显示或复制密钥
前必须重新验证 USA-Zero 密码。通用 Provider 编辑功能不得成为绕过该验证的入口。

## 重新评估条件

USA-Zero 提供更强的 Step-up Authentication，或客户端不再需要接触原始密钥时可以重新评估。
替代方案必须减少 Secret 暴露，并覆盖 Desktop 与 WebUI 的全部显示和复制路径。
