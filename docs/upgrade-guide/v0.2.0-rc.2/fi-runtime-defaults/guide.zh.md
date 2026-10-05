---
kind: upgrade-guide
description: "FI profile 和 SDK 客户端解析可用的已配置模型，不再隐式选择 DeepSeek；GUI 目录可以没有默认模型。"
---

# FI 运行时默认值

[English](guide.md) | 中文

## 变更

FI 的 Web、Desktop、headless、ACP 和完整 SDK profile 包含 `@fi/runtime-bundle`。新 profile 优先选择已关联的订阅模型，其次选择已配置的 API 提供方。可用的显式模型选择保持不变。没有可用路由时，发送提示前需配置模型；已有聊天保留保存的选择，路由或模型被删除后拒绝提示。

TypeScript 和 Python 的 `DeepSeekConfig` 默认省略 provider/model。JSON-RPC `initialize` 接受同时提供两个字段或同时省略；省略时解析 profile 默认值。`ModelCatalog.default` 可以为 `null`。`currentSelection()` 可以返回 `undefined`；入口等待 `resolveSelection()`。Session 数据格式不变。

FI 默认禁用上游账户界面、账户模型路由、产品分析和 Session 反馈上传。仍可显式配置自定义遥测。搜索使用 Auto：当前模型支持已关联订阅搜索时使用该搜索，否则使用无需密钥的 Bing RSS。仍支持显式搜索偏好。

## 迁移

1. 重启 FI。与旧版默认值完全匹配的 Web、headless、ACP 和 SDK bundle 列表自动迁移；其他 manifest 字段和自定义列表保持不变。
2. 在自定义 profile 的 `package.json` 中，将 `@fi/runtime-bundle` 放在上游 base/mode bundle 后。GUI profile 再将 `@fi/authorization-bundle` 放在其后。确保本地安装包含这些私有 FI bundle。
3. SDK 调用者可同时省略 provider/model 以使用 FI 设置，或同时提供以指定路由。`sdk-minimal` 没有默认模型服务，必须提供两个字段。自定义消费者需处理目录默认值的 `null` 和同步读取的 `undefined`。
4. 在 Models 设置中关联订阅或配置 API 提供方。确认新聊天显示可用模型。删除提供方后，已有聊天需先选择其他模型再继续。反馈上传需要主动配置 `session-telemetry-otel`，FI 默认不发送。
