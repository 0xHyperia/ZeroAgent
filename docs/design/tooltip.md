# 统一悬停提示

`agent-ui` 的 Tooltip 使用同一深色中性表面、共享 `rounded-xl` 圆角、轻阴影和字号缩放。
标准标签为 14px / 16px，中等字重，约 30px 高度。浅色与深色主题
共用语义变量；统计等结构化内容继承气泡内部的前景、辅助文字和分隔线，不能在黑底上继承浅色页面文字。

默认鼠标静止 350ms 后显示，离开后 80ms 关闭；同一 `TooltipProvider` 内相邻提示在短时间内切换
可即时显示。键盘聚焦立即显示，Escape 关闭，降低动态效果偏好下取消缩放/淡入过渡。
提示距按钮 6px，自动翻转并避让视口；长文字可换行，不显示箭头。

## 图标按钮

新增图标操作使用 `TooltipButton`，保留明确的 `aria-label`：

```tsx
<TooltipButton
  variant="ghost"
  size="icon-sm"
  tooltip="搜索会话"
  tooltipSide="right"
  aria-label="搜索会话"
  onClick={openSearch}
>
  <Search className="size-4" />
</TooltipButton>
```

`tooltipDescription` 可提供一行补充说明，`tooltipShortcut` 只展示已经绑定的快捷键，不能作为快捷键实现。
既有 `title` 可作为接入时的文案输入，组件不会将其写到 DOM，避免与浏览器白色原生提示重叠。
没有提示文案时仍是普通 Button；通用 Button 不被隐式劫持。组件保留同一真实按钮、ref 和事件。

菜单/Popover 的 `render` 可以使用 `TooltipButton`。展开后提示自动让位，不盖住菜单；点击、授权、
提交及取消仍由原宿主处理。不要把重要错误、可点击操作或长表单放在 Tooltip 中。

## 现有控件和结构化内容

`LabelTooltip` 的 `render` 可直接绑定真实按钮，避免额外布局层：

```tsx
<LabelTooltip label="用量说明" render={<button aria-label="用量说明">…</button>} />
```

现有 `children` 包裹方式继续支持。受控 `open/onOpenChange` 和触屏用量环的 `closeOnClick={false}`
继续由调用方持有；受控单触发器具有稳定 ID。复制反馈不需要先悬停，首次点击也能显示结果。

`Tooltip`、`TooltipTrigger`、`TooltipContent` 保留底层 Base UI 组合 API 和共享 handle。
普通组合中的可见提示具有 `role="tooltip"`，描述关联跟随实际打开的触发器，并保留调用方已有描述 ID。
使用独立共享 handle 的高级入口仍须按自身触发器关系提供可访问名称，不用 Tooltip 代替按钮名称。

本轮接入应用轨、侧栏搜索/折叠、标题栏、主题、模型、输入工具、消息操作、资料关闭、新建项目与账户菜单。
Tooltip 仅提供说明，不创建移动端入口，不改变执行权限，不持有草稿、账户或密钥。

## 应用导航四态

`ApplicationRail` 将页面选择和提示分开：`activeId` 由宿主持有，`items[].activeIcon` 可传同一图标库
中匹配的实心资源。未提供时保留原图标；不要对任意描边 SVG 强制 fill。当前 CloudChat 的应用轨
使用 Heroicons，其他共享控件继续保留现有图标。设置和设备是操作入口，不伪造持续选中状态。

| 状态 | 图标 | 背景 | 提示 |
| --- | --- | --- | --- |
| 未选中 | 灰色描边 | 透明 | 无 |
| 未选中悬停 | 深色描边 | 中性浅灰 | 右侧标签 |
| 选中 | 深色实心 | 中性浅灰 | 无 |
| 选中悬停 | 深色实心 | 同一中性浅灰 | 右侧标签 |

浅色使用 rgb(143,143,143) / rgb(13,13,13) / rgb(235,235,235)；深色由共享导航变量适配。
40px 按钮、20px 图标和 rounded-xl 圆角保持稳定；悬停不缩放、不替换图标、不触发导航。
键盘继续显示焦点环及描述提示；触屏不依赖 hover，强制颜色模式为当前页面补充轮廓。

行为验证位于 `crates/agent-gateway/web/test/tooltip-ui.test.mjs`；浏览器和视觉证据见根目录 `design-qa.md`。
