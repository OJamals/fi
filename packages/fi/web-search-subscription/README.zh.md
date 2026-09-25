---
description: "通过已存储的 Codex、Grok、Antigravity 或 Claude 订阅 OAuth 选择性启用原生网页搜索，并保留提供方引用和有界响应。"
kind: "package-reference"
---

# @fi/web-search-subscription

[English](README.md) | 中文

## 概述

使用本包可通过现有 Codex、Grok、Antigravity 或 Claude 订阅登录搜索网页。每次挂载都必须显式选择一个提供方系列和一个模型。只有当提供方报告已完成的原生搜索并给出原生引用 URL 时结果才成功；缺少该证据的生成文本会失败。OAuth 由其所属凭据适配器刷新，并在单次请求期间冻结。

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

挂载 web 和凭据服务，选择 `subscription-native`，并以显式提供方和模型挂载本包。本包不属于基础 bundle，也绝不会自动选择账户、提供方或模型。

### 何时选择本包

当部署已通过 `dsh-llm-pi-ai` 或 `@fi/llm-antigravity` 存储订阅 OAuth，且必须使用该提供方的原生搜索结果格式时，选择本包。当部署没有受支持的订阅授权，或需要本包无法表示的厂商控制项时，选择 API key 搜索提供方。

### 最小配置

此示例使用已存储的 Codex OAuth 授权。若要挂载其他受支持系列，请替换两个必填值。

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: subscription-native
- name: '@fi/web-search-subscription'
  config:
    provider: codex
    model: gpt-5.6-sol
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 必填 | `codex`、`grok`、`antigravity` 或 `claude`；无隐式选择 |
| `model` | 必填 | 发送给所选原生端点的精确模型 id |
| `timeoutMs` | `30000` | 整个操作的超时；1 至 120000 毫秒的整数 |
| `maxResponseBytes` | `2097152` | 保留的最大响应字节数；1 至 16777216 的整数 |
| `maxUses` | `5` | 原生搜索使用次数上限；1 至 10 的整数 |
| `maxOutputTokens` | `512` | 生成答案的 token 请求上限；1 至 8192 的整数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#fiweb-search-subscription)是已接受字段及其 JSDoc 的完整来源。

### 结果与失败

Codex 和 Grok 引用来自 Responses URL annotation，Claude 引用来自 `web_search_result_location`，Antigravity 引用来自 Gemini grounding chunk 和 support。提供方把返回来源限制为 `request.maxResults`，并在丢弃来源时设置 `truncated`。它通过可机器路由的 `WebError` code 拒绝未完成的提供方终态、缺失搜索证据、缺失引用 URL、超出响应字节限制和非 OAuth 认证来源。HTTP 失败在 `SubscriptionSearchError.status` 中保留提供方状态，但不暴露响应正文。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

插件在 Harness 凭据存储之上创建一个 pi-ai 模型 registry，并在每次请求中调用一次 `models.getAuth(provider)`。只有带非空 access token 的 `source: OAuth` 才能继续。随后，请求冻结该结果，并应用 `@fi/provider-compat` 的端点和 header 元数据。Antigravity 则调用其包所属的串行化授权解析器和原生 Gemini transport。

`createSubscriptionSearchProvider(ctx, config)` 公开同一构造过程，但不注册第二个 `subscription-native` id。FI 首选搜索路由为单个设置快照操作使用该工厂；普通直接挂载继续使用 `apply()`。

Codex、Grok 和 Claude 携带凭据的 fetch 会拒绝重定向。Antigravity 把发送和上游收集委托给其包所属 transport，后者提供重定向拒绝、取消、响应大小限制和错误脱敏。本包的响应读取器在解析 SSE 或 JSON 前执行配置的字节限制。提供方解析器只接受已完成的原生终态，并把携带引用的提供方字段投影为 `WebSearchSource`；它们不会虚构 URL。插件卸载会中止并等待活动请求，而 `ctx.web.registerSearchProvider()` 负责可逆注册。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件配置、凭据适配器和生命周期连接 |
| [`src/provider.ts`](src/provider.ts) | 冻结认证后的请求发送和提供方特定原生请求正文 |
| [`src/response.ts`](src/response.ts) | 有界 SSE/JSON 解析、完成检查和引用标准化 |
| [`src/types.ts`](src/types.ts) | 提供方选择和保留状态的搜索错误 |
| [`tests/expected/native-search.json`](tests/expected/native-search.json) | 标准化模型可见工具值的包内 golden |
| — | 不发布 runtime invariant companion；web 和 credential 服务拥有本包消费的可变关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web 子系统](../../../docs/subsystems/web.zh.md) — 搜索请求、结果和错误语义。
- [`dsh-web`](../../web/web/README.zh.md) — 提供方注册和显式选择。
- [`dsh-tool-web`](../../web/tool-web/README.zh.md) — 面向模型的 `web_search` 格式和来源限制。
- [`dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.zh.md) — 已存储的提供方 OAuth 和串行化刷新。
- [`@fi/llm-antigravity`](../llm-antigravity/README.zh.md) — Antigravity 授权和原生 Gemini transport。
- [`@fi/provider-compat`](../provider-compat/README.zh.md) — 已捕获的订阅端点和请求 header。

-----

<a id="model-experience"></a>
## 模型体验

本包通过 `dsh-tool-web` 间接影响模型；只有带已完成原生搜索证据和原生引用 URL 时，它才接收提供方生成的答案文本。该工具把有界来源格式化为外部不可信内容，并要求模型引用相关 URL。提供方失败会保持为结构化工具错误，而不会成为无引用答案文本。

#### KV Cache 影响

无直接失效；`dsh-tool-web` 拥有面向模型的 schema 和 prompt 前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制防止本包声称其订阅端点没有公开的控制项。

- Claude 把 `maxUses` 作为原生 `max_uses` 接收；Codex、Grok 和 Antigravity 没有已证明的等价请求字段，因此当原生操作计数超过配置上限时，其响应会在解析后被拒绝。
- Codex 拒绝 `max_output_tokens`，因此 Codex 请求不发送 `maxOutputTokens`。Grok、Claude 和 Antigravity 接收各自的原生 token 字段。
- `request.maxResults` 限制标准化输出，但不会发送到上游，因为这四种 transport 没有共同且已证明的原生结果数量字段。
- `available()` 是本地生命周期检查。缺失或非 OAuth 授权会在首次搜索时失败，因为刷新和认证来源选择是异步操作。
- 四个提供方系列均有通过本插件执行的有界实时原生搜索开发覆盖。模型和账户可用性可能不同；常规测试不消耗订阅配额。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
