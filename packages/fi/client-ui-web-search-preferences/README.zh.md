---
description: "用于选择 FI 网页搜索路由并管理直接提供方凭据的浏览器控件。"
kind: "package-reference"
---

# @fi/client-ui-web-search-preferences

[English](README.md) | 中文

## 概述

此浏览器插件在“设置”→“插件”中添加“首选网页搜索”。它扩展 Host 所属的 `web-search-deepseek` 设置区，并通过凭据 API 管理 API 密钥，不暴露已存储值。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将本包与 [`@fi/web-search-preferences`](../web-search-preferences/README.zh.md) 一起加载。FI authorization bundle 已包含两者。

用户可以选择 DeepSeek 官方搜索、Exa、Perplexity、Parallel、Tavily、Serper、Brave Search 或订阅搜索。直接提供方密钥通过密码控件添加、替换或移除。没有已配置密钥的提供方不能启用。凭据写入会在提供方变更提交前完成，因此被拒绝的写入不会改变活动路由。当 Settings 为只读且 Credentials 报告活动引用可写时，仍可仅保存凭据。

订阅搜索没有密钥字段。用户先从“模型”登录，再选择 Codex、Grok、Antigravity 或 Claude，并输入精确模型 id。此卡片不会启动 OAuth，也不会改变对话模型路由。

<a id="understand-the-implementation"></a>
## 理解实现

FI 本地 controller 绑定 `web-search-deepseek` 设置命名空间，暂存编辑，解析所选提供方已配置的凭据引用，并向呈现组件注入快照 hook。凭据状态仅包含 `configured` 和 `writable`；密钥值绝不会被读回。提供方或引用变化后，过期凭据响应会被丢弃。Host 拒绝以及凭据读取、写入或移除失败会显示在卡片中。

不发布运行时 invariant companion：本包只拥有浏览器呈现，设置与凭据服务各自验证其持久状态。

<a id="further-exploration"></a>
## 进一步探索

- [首选搜索 Host 路由](../web-search-preferences/README.zh.md)
- [凭据子系统](../../../docs/subsystems/credentials.zh.md)
- [Web 子系统](../../../docs/subsystems/web.zh.md)

<a id="model-experience"></a>
## 模型体验

### 首选搜索设置卡片

#### 模型看到什么

此浏览器包不会向模型提供任何内容。卡片更改 Host 设置；面向模型的行为仍由未修改的 `web_search` 工具负责。

#### Token 影响

无。浏览器标签和凭据元数据不会进入模型请求。

#### KV Cache 影响

无缓存影响；本包从不组装模型输入。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 高级提供方端点、模型、结果限制和超时仍是 Host 配置字段，没有专用控件。
- 只有所选提供方运行时才会检查真实厂商可用性。

<a id="dev-note"></a>
### 开发备注

无。
