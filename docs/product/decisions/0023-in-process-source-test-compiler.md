# 0023：源码测试使用进程内转译器

- 状态：已实施；最终全量结果见本阶段验证回执
- 关联：ADR 0022

Windows 下原有 esbuild 同步 worker 在源码测试加载模块时出现长时间等待。原有 kbrain-import-acceptance 用例在 HTTP 夹具收到请求前达到 30 秒外层期限；CPU 采样和逐文件记录将等待定位到同步 worker 的 Atomics.wait。关闭 worker 后每次转换都启动独立进程，隔离用例仍超时，因此没有采用。该诊断不等同于真实 Go 后端的冷启动根因。

测试工具改用锁定版本的 Babel TypeScript、JSX 和 CommonJS 转换，关闭项目外部 Babel 配置。曾试用 Sucrase，虽然导入用例加快，但 GUI/shared 循环依赖中的转出函数过早读取为 undefined，导致九个聊天用例失败；该方案已移除。Babel 的循环依赖行为由原有聊天用例及新增语义回归共同验证，没有添加自定义导出提升补丁。

import.meta 通过 AST 位置替换为每个测试文件独立的对象，只提供该源文件的 URL；引号中的文本、对象身份、指令序言与 JSX 行为有针对性回归。最多缓存 256 份、16 MiB 的纯转换文本，不缓存执行后模块或模拟状态。测试加载器仍各自拥有模块缓存与模拟对象。

此变更只影响源码测试工具。生产 Vite 编译和独立 TypeScript 类型检查保留原流程；用例期限、业务断言和跳过条件未放宽。失败、试验及最终全量日志分别保留，不能将试验通过计入最终编译器结果。scripts 目录不在仓库 Biome 的 files.includes 范围内；脚本通过自身语义测试和 diff 检查验证。

转换器行为参考 [Babel CommonJS](https://babeljs.io/docs/babel-plugin-transform-modules-commonjs)、[Babel TypeScript](https://babeljs.io/docs/babel-plugin-transform-typescript) 与 [Babel JSX](https://babeljs.io/docs/babel-plugin-transform-react-jsx) 文档。
