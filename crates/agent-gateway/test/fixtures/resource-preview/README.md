# 表格格式验收原件

`complete-sheet.xlsx` 是纯合成 XLSX，不含账号、真实用户资料或外部数据源。由仓库根目录的 `scripts/generate-sheet-preview-fixtures.py` 生成（开发工具需要 XlsxWriter 3.x）；更新时将生成的 `.codex-artifacts/sheet-complete-20261101/表格完整验收.xlsx` 复制至本目录。运行测试不依赖 Python。

覆盖四类条件格式、六个迷你图、九类经典图表、PNG、文本形状、表格主题、合并、冻结、隐藏工作表与空表。B17 的公式是 `=1+1`，刻意保存缓存值 41；只读预览应显示 41，不能重新计算为 2。可直接拖入本地开发环境的“验收”项目检查正文与输入区封面。
