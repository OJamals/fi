---
description: "FI 所属的实时网页搜索偏好路由，可在 API key 与订阅原生提供方之间选择。"
kind: "package-reference"
---

# @fi/web-search-preferences

[English](README.md) | 中文

## 概述

本包为 FI 用户提供一个首选搜索设置，同时保留 DeepSeek Harness 的 `WebSearchProvider`、`WebRuntime` 和 `web_search` 接口。稳定的 `fi-preferred-search` 注册项为每个新调用取得当前设置快照，创建所选提供方，并返回其标准化结果，不执行回退。进行中的调用继续使用其原始提供方和选项。

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

在现有 web runtime 中选择稳定路由，并挂载本包：

```yaml
- id: web
  config:
    searchProvider: fi-preferred-search
    fetchProvider: http
- id: fi-web-search-preferences
  name: '@fi/web-search-preferences'
```

FI authorization bundle 提供此覆盖层。同级的[浏览器设置包](../client-ui-web-search-preferences/README.zh.md)在“设置”→“插件”中添加“首选网页搜索”。用户可以选择 DeepSeek 官方搜索、Exa、Perplexity、Parallel、Tavily、Serper、Brave Search 或订阅搜索。直接提供方密钥通过 Credentials 写入；密钥字面量绝不会进入设置文档或 Session 日志。

本包中的所有直接提供方都使用 API key。本包不提供 Exa、Perplexity 或 Parallel MCP OAuth。订阅搜索复用从“模型”页面获得的 Codex、Grok、Antigravity 或 Claude 授权。选择订阅搜索不会启动 OAuth、采用推理路由或更改聊天模型。用户必须选择订阅系列和精确搜索模型 id。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `deepseek-official` | 下一次搜索使用的提供方 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | DeepSeek 凭据引用；保留上游字段名 |
| `exaApiKeyEnv` | `EXA_API_KEY` | Exa 凭据引用 |
| `perplexityApiKeyEnv` | `PERPLEXITY_API_KEY` | Perplexity 凭据引用 |
| `parallelApiKeyEnv` | `PARALLEL_API_KEY` | Parallel 凭据引用 |
| `tavilyApiKeyEnv` | `TAVILY_API_KEY` | Tavily 凭据引用 |
| `serperApiKeyEnv` | `SERPER_API_KEY` | Serper 凭据引用 |
| `braveApiKeyEnv` | `BRAVE_SEARCH_API_KEY` | Brave Search 凭据引用 |
| `subscriptionProvider` | 无 | `codex`、`grok`、`antigravity` 或 `claude` |
| `subscriptionModel` | 无 | 精确的原生订阅模型 id |

生成的[配置目录](../../../docs/config-catalog.zh.md#fiweb-search-preferences)列出所有端点、模型、结果、超时和响应限制字段。

<a id="understand-the-implementation"></a>
## 理解实现

Host 在插件生命周期内注册一个提供方。每次 `search()` 在解析凭据或授权前复制已解析设置，然后委托给上游 DeepSeek、Exa 或 Perplexity 提供方、FI 本地 Parallel、Tavily、Serper 或 Brave 适配器，或者订阅提供方。每个可配置端点基础地址必须使用 HTTPS，FI 才会解析或发送凭据。FI 本地适配器实现相同的提供方中立请求/结果类型，在投影前验证外部响应字段，取消失败响应的正文，并且失败时只报告提供方和 HTTP 状态。卸载会中止活动操作，并且并发卸载调用会等待同一次排空。缺失所选凭据或订阅配置不完整时会显式失败；不会尝试其他提供方。

DeepSeek 辅助请求日志继续使用 `web/deepseek-search-llm-request`。面向模型的工具 schema、结果格式、来源上限、fetch 提供方、agent loop、Session 格式和 SDK 投影继续由上游拥有且保持不变。

FI 路由在单独注册的基础行被禁用时拥有现有 `web-search-deepseek` 设置命名空间。其 schema 保留上游 `apiKey`、`apiKeyEnv`、`baseURL`、`model`、`apiVersion`、`maxTokens` 和 `maxUses` 字段名与默认值；FI 另外要求 `baseURL` 使用 HTTPS。移除 FI 层后，上游行使用同一份已存储 DeepSeek 设置恢复。

不发布运行时 invariant companion：同一个路由对象拥有每次设置快照、委托、abort signal 和卸载路径，不存在可能分歧的独立观测关系。

<a id="further-exploration"></a>
## 进一步探索

- [Web 子系统](../../../docs/subsystems/web.zh.md)
- [上游 DeepSeek 提供方](../../web/web-search-deepseek/README.zh.md)
- [上游 Exa 提供方](../../web/web-search-exa/README.zh.md)
- [上游 Perplexity 提供方](../../web/web-search-perplexity/README.zh.md)
- [FI 订阅原生提供方](../web-search-subscription/README.zh.md)

<a id="model-experience"></a>
## 模型体验

### 首选搜索路由

#### 模型看到什么

只有未修改的上游 `web_search` 工具及其标准化结果。提供方选择不会进入工具 schema 或 prompt。

#### Token 影响

不增加 prompt 或 schema token。搜索结果保留所选上游提供方已有的有界内容。

#### KV Cache 影响

无。面向模型的工具定义未更改。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 卡片管理提供方选择、直接提供方密钥及订阅系列/模型。高级端点和限制字段仍可通过 `cordis.yml` 或已存储设置文档配置，但尚无手写控件。
- 订阅可用性在搜索期间检查，因为 OAuth 刷新是异步的。
- 常规测试模拟厂商 transport。真实直接提供方和订阅调用需要相应用户凭据或授权。

<a id="dev-note"></a>
### 开发备注

无。
