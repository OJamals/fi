---
kind: upgrade-guide
description: 未显式配置搜索偏好的 FI profile 现在跟随聊天的已关联订阅模型，或使用免费的 Bing RSS 搜索，而非 DeepSeek 搜索。
---

# FI 自动搜索默认值

[English](guide.md) | 中文

## 变更

`fi-web-search-preferences` 的提供方默认值从 `deepseek-official` 改为 `auto`。省略 `provider` 的 profile 在发起聊天的模型路由具有匹配的已存储 OAuth 授权时，使用原生订阅搜索；否则使用免密钥的 Bing RSS 搜索。自动路由使用精确的订阅聊天模型。现有显式引擎选择继续生效。显式订阅搜索支持可选系列/模型覆盖值，并仍在发送前要求授权。

## 迁移

1. 在“设置”→“插件”→“首选网页搜索”选择“自动（跟随聊天模型）”，或在 `fi-web-search-preferences` profile 项中设置 `provider: auto`。无需搜索 API 密钥。
2. 要自动使用订阅搜索，请从“设置”→“模型”登录，并为聊天选择该订阅模型。要让所有模型都使用免费搜索，请选择“Bing（免费）”或设置 `provider: bing-rss`。要保留 DeepSeek 搜索，请显式选择 DeepSeek 官方搜索。
3. 执行网页搜索，确认出现来源。自动路由在聊天具有关联订阅时采用该订阅，否则采用 Bing；请求发送后的提供方失败会显示。
