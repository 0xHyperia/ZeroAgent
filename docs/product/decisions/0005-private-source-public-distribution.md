# ADR 0005：公开分发使用独立边界

- 状态：已采纳
- 范围：GitHub Actions、Release、运维

## 决策

`0xHyperia/ZeroAgent` 构建并持有完整 Release。用户可下载的二进制和面向用户的更新说明由
USA-Zero 凭据发布到 `USA-Zero/ZeroAgent`。公开 Release 不附带自动生成的源码归档，也不描述
私有仓库拓扑、Gateway 镜像、凭据或内部部署。

## 重新评估条件

仓库可见性或分发渠道变化时可以重新评估。替代方案必须明确产物清单、发布者身份、Secret
边界、回滚路径和公开内容审核规则。
