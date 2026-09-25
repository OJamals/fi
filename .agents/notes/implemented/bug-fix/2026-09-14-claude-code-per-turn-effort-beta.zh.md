# Agent Note: Claude Code 单轮 effort beta

Status: implemented

[English](2026-09-14-claude-code-per-turn-effort-beta.md) | 中文

## Problem

Anthropic 订阅 wrapper 曾用已捕获的静态集合替换 pi-ai 按请求生成的 `anthropic-beta` 请求头。pi-ai 会为逐消息 effort 发送带 `output_config` 的 system message，因此启用该字段的 beta 丢失后，Anthropic 会以 `messages.<index>.output_config: Extra inputs are not permitted` 拒绝请求。

## Decision

`subscriptionHeaders()` 会合并按请求生成的 Anthropic beta 与已捕获的 Claude Code beta 集合。它把 pi-ai 的公开名称 `mid-conversation-output-config-2026-07-01` 映射为 Claude Code 2.1.270 实际发送的线上名称 `per-turn-control-2026-07-01`。wrapper 会保留其他按请求生成的 beta，并移除重复项。

公开版本发现继续与线上捕获分离。自动 updater 可以推进发布元数据，但 `version`、`fingerprintCapturedVersion` 及其他需要捕获的字段会保留已评审证据，直到记录新的协议捕获。

## Alternatives considered

**让已捕获的静态 beta 集合覆盖所有请求。** 这会丢失 pi-ai 根据实际请求体选择的功能 beta，并再次触发已报告的拒绝。

**不改写 pi-ai 的公开 beta 名称。** [Anthropic 文档使用该名称](https://platform.claude.com/docs/en/build-with-claude/effort)，但 Claude Code 2.1.270 实际发送私有线上名称 `per-turn-control-2026-07-01`。订阅传输遵循产品请求。

**重新实现 Anthropic 请求体。** 这会重复 pi-ai 的消息转换、工具、thinking、流式传输和回放行为。缺陷仅存在于兼容请求头替换中。

## Consequences

逐消息 effort 请求会保留所需 beta，同时继续携带静态 Claude Code 兼容请求头。loopback 传输测试会在缺少精确 Claude Code beta 时拒绝 `output_config`。发布更新测试会保留自动刷新的发布元数据与需要捕获的协议字段之间的区别。
