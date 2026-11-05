# 文本插件包
使用根plugin.json描述name、description及interface；技能位于skills/<小写连字符名称>/SKILL.md，每份含name和description前置元数据。
Codex兼容包可用.codex-plugin/plugin.json和显式skills目录；所有引用路径应为包内相对路径，不含..、绝对路径或链接。
普通references、README及assets中的文本不自动注册为技能。独立技能使用根SKILL.md，不必套插件。
当前文本导入限制：最多64文件，每份64KiB，展开共256KiB，ZIP350KB；不包含二进制、可执行脚本、依赖或凭据。
不声明当前没有提供的工具服务、账户连接或应用权限。归档应包含实际创建的文件，并在交付前重新打开检查。
