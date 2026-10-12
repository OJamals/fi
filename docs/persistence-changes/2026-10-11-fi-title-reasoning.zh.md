---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-11-fi-title-reasoning

[English](2026-10-11-fi-title-reasoning.md) | 中文

## 概述

所选模型提供推理等级时，在辅助会话标题请求中记录解析后的推理等级。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-11-fi-title-reasoning
baseline: false
changes:
  - root: "event:session/title-llm-request"
    previous: "2026-09-21-user-question-reply"
    after: "1cb6437add22641c189dc8391565e6bec6217f3530f632eef999f20767307689"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

可选的 reasoningEffort 字段保留已有 Session 记录及当前格式版本。提供方根据捕获的模型元数据选择控制参数，记录的请求与实际发送一致。已提交的历史格式文件保持不变。

<a id="verification"></a>
## 验证

LLM 服务、标题执行器、首消息与全消息提供方以及标题服务生命周期的针对性测试通过，覆盖省略推理等级、捕获的适配器控制参数、修订替代及当前标题快照。

<a id="dev-note"></a>
## 开发备注

无。
