---
description: "FI 订阅登录和原生提供方包，用于配置基于账户的模型访问。"
kind: "package-group"
---

# fi/ — 订阅提供方

[English](README.md) | 中文

## 概述

使用这些包通过订阅账户登录并配置模型路由。授权 bundle 将登录界面和提供方支持组合为可选层。凭据保留在 Harness 凭据存储中；界面显示状态而不暴露令牌。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

每个包负责订阅访问的一部分。这些私有 workspace 包使用 `@fi/<目录名>`，不参与上游 npm 发布系列；workspace 约束同时强制检查这两项属性。

| 包 | 职责 |
|---|---|
| [authorization-bundle](authorization-bundle/README.zh.md) | 可选的订阅组合 |
| [api-authorization-controller](api-authorization-controller/README.zh.md) | 登录和路由采用操作 |
| [client-ui-model-signin](client-ui-model-signin/README.zh.md) | 模型设置中的登录控件 |
| [client-ui-web-search-preferences](client-ui-web-search-preferences/README.zh.md) | 首选搜索设置与凭据控件 |
| [llm-antigravity](llm-antigravity/README.zh.md) | 原生 Antigravity 模型请求 |
| [provider-compat](provider-compat/README.zh.md) | 共享提供方元数据与 OAuth 传输兼容处理 |
| [tool-image-generation](tool-image-generation/README.zh.md) | 基于订阅的图片生成与参考图片编辑 |
| [web-search-preferences](web-search-preferences/README.zh.md) | 用户选择的搜索路由 |
| [web-search-subscription](web-search-subscription/README.zh.md) | 显式选择的原生订阅搜索 |

<a id="related-documentation"></a>
## 相关文档

- [LLM 子系统](../../docs/subsystems/llm-streaming.zh.md) — 模型适配器和重放的职责。
- [凭据子系统](../../docs/subsystems/credentials.zh.md) — 凭据存储和授权。
- [架构](../../docs/architecture.zh.md) — 插件组合和上游扩展点。

<a id="dev-note"></a>
## 开发备注

无。
