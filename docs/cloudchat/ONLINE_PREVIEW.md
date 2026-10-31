# 在线预览实现边界

资料原件保存在对象存储，浏览器通过已有账户文件/成果接口取得受控字节。公共 `agent-ui` 查看器不接触
S3 密钥、账户登录或本机文件系统。宿主提供不可变资源身份、大小、SHA-256 和受控下载，异步完成时重新检查账户。
预览结果不能把 `uploaded`、`processing`、`failed` 等状态改成 AI 文本解析已就绪。

| 类型 | 组件与行为 | 兼容边界 |
|---|---|---|
| DOCX | `docx-preview`，分页 HTML 放入无权限 sandbox iframe | 字体替换及复杂排版可能不同；禁用 HTML altChunks 和外链导航 |
| PPTX | `@office-kit/pptx` + `@office-kit/pptx-preview`，Worker 内逐页生成 SVG，可翻页及缩放阅读 | 静态阅读，不宣称复现动画、SmartArt 或全部嵌入对象 |
| PDF | `pdfjs-dist`，本地打包 Worker、CMap/标准字体/WASM/ICC，逐页 Canvas、分页及缩放 | 已验收中文及两页切换；加密和异常文件提示下载，复杂样本仍需持续覆盖 |
| XLS/XLSX/ODS/CSV/TSV 及已有 Excel 模板/宏容器 | SheetJS Worker，工作表切换、只读表格 | 每张表前 500 行和 80 列；不执行公式、宏或外部连接 |
| ZIP | 检查完整目录及实际展开字节，仅列出路径 | 不解压到服务器；拒绝加密、ZIP64、分卷、重复/越界路径和超限展开 |
| HTML/SVG | 无脚本、无同源权限的 iframe 和限制 CSP，可查看源码 | 私人静态预览不等于站点发布 |
| Markdown | 受限 UTF-8，经 Streamdown 静态排版阅读 | 不执行 HTML；外链图像显示说明，不自动请求；链接仅允许 HTTP(S) |
| 代码/文本 | 受限 UTF-8 源码查看 | 不执行代码；超过文本限制时保留原件供下载 |
| 图片 | PNG/JPEG/GIF/WebP/BMP/AVIF 共用受控查看器、尺寸说明与错误恢复 | 解码前检查逻辑尺寸；当前上限 8 MiB、8192 边长及 1600 万像素 |
| 音视频 | 浏览器原生控件，受控 Blob 字节，不自动播放 | WAV/MP4 已用实际编码样本验收；其他容器仍受浏览器解码能力限制，无转码或自动字幕承诺 |

媒体上传经文件头识别并保留为工作区原件；预览成功不等于完成转写或模型文本解析。
GIF/WebP/BMP/AVIF 的实际样本已在浏览器解码，手机样本与全部异常场景仍需验收。PNG/JPEG 上传与成果已接入同一查看器；
成果保留明确点击“查看图片”的入口，版本切换立即卸载旧预览，原文行号和文本查看继续使用已有来源接口。
旧 `.doc/.ppt`、加密、损坏和超过边界的文件保留原件，提示下载；目前没有部署自动 Office 转换服务。

预览每次最多读取 32 MiB 原件，文本最多 2 MiB；归档最多 2000 项、展开总计 96 MiB、单项 16 MiB。
PPTX 最多 150 页，Worker 操作超过 20 秒可终止。限制用于保证可用性，不代替文件完整性与账户权限检查。
Word 的窄屏阅读重排不改变原件；需要原版分页和排版时下载原件。生产站点脚本必须使用独立内容域与发布访问控制。

PDF 静态资源目录包含依赖版本号，避免长期缓存混用新旧字体与解析资源。Gateway 对随应用打包的 `.mjs`
显式使用 JavaScript MIME，避免 Windows 的宿主 MIME 注册项使模块 Worker 被浏览器拒绝；这不改变上传原件的下载方式。

## 多端接线与失败恢复

桌面工作区的 DOCX、PPTX、PDF、表格、ZIP 和音视频也复用公共查看器；受控 FS 桥继续负责本机/远程设备授权、
路径边界和读取大小。原生返回的 contentHash 是版本缓存指纹，不冒充 SHA-256；宿主从该次授权响应的实际字节生成
查看器快照摘要，并按请求、关闭和目标切换丢弃迟到结果。Web、桌面远程及嵌入移动前端仍通过各自原有适配器读取。
桌面已有的图片缩放/旋转/复制/另存、Markdown 相对文件导航、本地交互 HTML，以及旧 DOC/RTF 转换能力保留；
私人云端 HTML/SVG 的无脚本预览仍与本地工作区的交互 HTML 区分，不扩大云端执行权限。

读取中的取消会终止宿主的 AbortSignal；重新尝试会建立新的请求生命周期。解析、完整性、编码或解码失败时统一提供
重试及下载原件，不改变云端原件/成果状态。Office 的 OLE 加密容器可以保存为原件，浏览器不接受密码或解密；
容器识别不是成功解密或排版的证明。原生运行窗口、多语言及全部加密/复杂格式的实际样本仍需补齐验收。

## 依赖来源

- [docx-preview](https://github.com/VolodymyrBaydalka/docxjs)：仓库原有 0.4.0 系列。
- [Office Kit](https://github.com/office-kit/pptx)：MIT；core 固定 0.28.0，preview 固定 0.21.0。
  上游仍处于 0.x，升级时需以实际 PPTX 样本检查渲染效果，不能使用浮动 latest。
- [PDF.js](https://mozilla.github.io/pdf.js/)：固定 6.4.299，Worker 随构建输出，不使用运行时外部 CDN。
- [SheetJS 安装源](https://docs.sheetjs.com/docs/getting-started/installation/frameworks/)：公共 UI 改用官方 CDN 的
  固定 0.20.3 tarball，由 lockfile 记录完整性；没有继续扩大旧 npm 0.18.5 对新上传文件的解析使用。
- [fflate](https://github.com/101arrowz/fflate)：固定 0.8.3，按流检查归档的实际展开大小。
