# 共享组件浏览器样板

用于 ADR0058 的真实共享组件验收，不挂载 App、账户、Gateway、Tauri 或模型请求客户端；
样例只更新内存状态，不上传文件、不写产品配置。它不随 GUI/Web 的产品入口打包。

在仓库根目录启动：

```powershell
pnpm --filter zeroagent exec vite --config test/design-system-browser/vite.config.ts
```

访问 `http://127.0.0.1:18481/`。先确认该端口空闲，不应替换其他开发进程。

类型检查和独立构建：

```powershell
pnpm --filter zeroagent exec tsc --noEmit -p test/design-system-browser/tsconfig.json
pnpm --filter zeroagent exec vite build --config test/design-system-browser/vite.config.ts
```

检查默认、hover、按下、禁用、忙碌、选中和选中 hover；使用 Tab/方向键核对焦点和分段控件。
打开 Tooltip/菜单/模型/思考/弹窗，核对 Portal 的主题、字号、边界避让和 Escape 后的焦点返回。
在浅深主题、100%/125%/150% 字号及桌面/手机视口比较；触控和减少动态由真实设备/浏览器提供。
模型数据完全为样例，仅验证分组定位、连续拖动与宿主能力显示，不代表真实模型支持这些档位。

这里的宿主切换只设置已有 CSS 宿主标记和显式能力参数，不模拟原生窗口、安全区、软键盘、
系统返回、认证和远程租约。浏览器样板通过不能替代 Native、真机与在线工作台验收。
