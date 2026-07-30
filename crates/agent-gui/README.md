# LiveAgent

基于 Tauri + React 的桌面 Agent 客户端，支持文本模式、工具模式、MCP 接入和工作目录内的 Skills 渐进式披露。

## 开发

- 前端开发：`pnpm dev`
- 桌面开发：`pnpm tauri dev`
- 前端构建：`pnpm build`
- Windows 平台会自动合并 `src-tauri/tauri.windows.conf.json`
- macOS 平台会自动合并 `src-tauri/tauri.macos.conf.json`

服务地址由启动环境变量独立指定，与 debug/release 构建模式无关：

```powershell
$env:ZEROAGENT_USA_ZERO_ORIGIN="https://usa0.top"
$env:ZEROAGENT_GATEWAY_URL="https://agent.usa0.top"
$env:ZEROAGENT_GATEWAY_PORT="443"
pnpm tauri dev
```

`VITE_USA_ZERO_ORIGIN` 仍可作为 `ZEROAGENT_USA_ZERO_ORIGIN` 的兼容别名。
