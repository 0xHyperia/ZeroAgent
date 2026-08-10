# ADR 0001：以 USA-Zero OAuth 作为账户边界

- 状态：已采纳
- 范围：Desktop、WebUI、Android、Gateway

## 决策

ZeroAgent 使用预先注册的 USA-Zero OAuth 客户端和服务端管理的会话。重复登录只为同一个应用
注册续期或创建会话，不得动态注册新的已授权应用。通用 Gateway Token 登录和旧 ZeroBox
兼容逻辑不属于产品范围。

OAuth state、受支持端的 PKCE、回调白名单、账户绑定、过期和撤销均由服务端验证。客户端不得
从未经验证的回调参数推断用户身份。

## 重新评估条件

USA-Zero 更换身份平台，或某个平台必须使用不同的标准 OAuth Profile 时可以重新评估。替代
方案必须保留撤销、稳定客户端身份、安全回调和账户隔离，并提供活跃会话迁移方案。
