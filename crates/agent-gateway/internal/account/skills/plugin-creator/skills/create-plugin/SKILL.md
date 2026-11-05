---
name: create-plugin
description: 创建包含相关技能及支持资料的个人插件；独立技能交给创建技能流程。
---

# 创建插件
从用户重复完成的工作出发，明确插件用途、输入、主要方法和输出。已有说明就继续整理，不要求先填技术清单。
用户只要一个独立技能时使用skill-creator包；修改已有插件时读取update-plugin。
按需读取references/package-format.md，生成有稳定名称的plugin.json及skills/<技能名>/SKILL.md，长说明放references，避免把普通文档注册成技能。
插件可以组织技能、工具连接和应用视图；本运行环境的可导入包仅提供文本技能与资料，不会因为manifest声明而获得MCP、OAuth、脚本执行或应用权限。
用当前隔离工作区创建真实文件并检查包结构、每个触发条件、正常任务和缺输入场景；只用现有可用工具。用publish_artifact交付ZIP，再说明自定义→插件→添加的导入路径，不自动安装。
用户要求正式提交时先读取prepare-plugin-submission。缺少归档或持久交付工具时给出真实文件内容与剩余步骤，不虚构下载。
