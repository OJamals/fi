---
description: "为基于 base 的应用 profile 提供共享 FI 提供方、默认模型、搜索和反馈配置。"
kind: "package-bundle"
---

# @fi/runtime-bundle

[English](README.md) | 中文

## 概述

FI 私有运行时层在 `@deepseek-ai/dsh-base` 后挂载订阅适配器、提供方兼容处理和首选搜索。Web、Desktop、headless、ACP 和完整 SDK profile 包含它。GUI profile 另行挂载 [authorization-bundle](../authorization-bundle/README.zh.md)，由该层负责图片工具组合。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

在本地安装的 profile 中，将本 bundle 放在上游 base 和应用 bundle 后。FI 私有包无法通过公共 registry 获取。自定义 bundle 列表显式启用本层；与旧版默认值完全匹配的列表迁移到当前模板。

本层清除继承的 DeepSeek 默认模型，并启用 `agent-default-model.selectionPolicy: available`。可用的显式选择优先；否则已关联订阅授权优先于已配置的 API 提供方，同级按提供方 id 稳定排序。`subscriptionCredentials` 配置授权键。没有可用路由时，GUI 报告没有默认模型并提示设置；自动化入口必须先配置模型。自动选择仅保留在运行时；显式选择通过配置编辑器持久保存。

DeepSeek 账户服务和账户模型路由被禁用。其 API-key 提供方仍可选：Models 设置可删除并重新添加，同时保留凭据。已有聊天保留模型选择；删除路由后，发送下一条提示前需选择可用模型。

搜索默认使用 Auto：当前模型支持已关联的原生搜索时使用该搜索，否则使用无需密钥的 Bing RSS。仍支持显式提供方覆盖。[搜索偏好包](../web-search-preferences/README.zh.md)定义路由、密钥和错误行为。

通过 `session-telemetry-otel.mode: DISABLED` 禁用 Session 反馈上传，反馈不会将 Session 日志发送至上游收集端。GUI 层还禁用产品分析和 Desktop 产品遥测。主动启用遥测的部署负责其端点和共享策略。

本层挂载原生 Antigravity、OpenCode Console 适配器和[提供方兼容处理](../provider-compat/README.zh.md)。它不为 headless、ACP 或 SDK 组合添加模型可见工具 schema。

<a id="understand-the-implementation"></a>
## 理解实现

`cordis.patch.yml` 是完整实现；manifest 声明每个插入插件的依赖。导出模块没有运行时 API。本 bundle 不拥有可独立观察的运行时状态，因此不发布 invariant 配套模块；挂载的服务负责其生命周期。

<a id="further-exploration"></a>
## 进一步探索

- [默认模型服务](../../core/agent-default-model/README.zh.md) —— 解析和显式持久保存。
- [授权 GUI 层](../authorization-bundle/README.zh.md) —— 浏览器登录和设置。
- [升级指南](../../../docs/upgrade-guide/v0.2.0-rc.2/fi-runtime-defaults/guide.zh.md) —— 已有 profile 和 SDK 调用者。

<a id="model-experience"></a>
## 模型体验

### 默认选择与搜索路由

#### 模型看到什么

本层为新 Agent 选择模型。搜索选择保持现有 `web_search` schema。已有 Session 请求头保持不变。

#### Token 影响

本层不添加提示文本或工具 schema；路由后的搜索结果仍为普通工具结果。

#### KV Cache 影响

模型选择影响后续新请求。已有聊天保留所选模型和日志前缀；搜索路由保留已挂载工具 schema。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 已配置凭据和可解析目录表示选择已就绪；实际生成仍可能遇到认证或配额错误。
- `sdk-minimal` 保持独立的显式路由 profile，不包含本层。

<a id="dev-note"></a>
### 开发备注

本层依赖上游 base 行。仅供浏览器的设置和 Remote 控制器属于 authorization-bundle。
