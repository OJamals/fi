---
kind: upgrade-guide
description: "自定义非系统消息替换需要紧邻的计量事件才能更新上下文构成总量。"
---

# 为自定义上下文替换提供计量

[English](guide.md) | 中文

## 变更

`contextBreakdown` 现在保留系统提示词和聚合价格，不再为每条消息保存价格。检查点版本从 5 变为 6；旧缓存行被丢弃，并从会话日志重建。会话日志和其他投影键不变。

自定义生产方替换非系统消息范围时，若没有紧邻在前的 `compaction/summary` 或 `compaction/prune` 事件，构成总量将保持不变。内置的带计量压缩和单个系统提示词改写仍保留现有估算行为。

## 迁移

1. 保留现有会话日志，无须手动删除缓存或改写日志。
2. 自定义替换生产方应使用压缩服务，或在替换前紧邻记录匹配的计量事件。其 `shadowedRange`、`shadowedSeqs` 和 `shadowedTokenCount` 必须使用 token meter 的固定启发式规则描述实际被替换的表层。
3. 回放具有代表性的自定义替换，将 `contextBreakdown.systemTokens + contextBreakdown.messageTokens` 与 `tokenMeter.measure(session).nodes[].heuristicTokens` 的总和比较，并在生产方测试中覆盖检查点恢复。
