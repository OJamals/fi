---
description: "为 dsh --profile 表层添加提供方订阅登录能力的 fi 组合包层，面向组合或定制 profile 的用户。"
kind: "package-bundle"
---

# @fi/authorization-bundle

[English](README.md) | 中文

## 概述

`@fi/authorization-bundle` 为基于 base 的 `dsh --profile` 组合添加订阅登录、模型访问、图片生成和首选网页搜索。FI Desktop 将它放在上游 base 与 Web bundle 之后。源码和自定义 profile 通过在 `@deepseek-ai/dsh-base` 后列出该层来启用。该层自身不获取凭据或模型路由；用户在设置中配置授权和密钥。

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

### 安装进 profile

FI Desktop 在本地包集和固定内置 profile 中提供这个私有层，不从 npm 安装。已声明 `@deepseek-ai/dsh-base` 的源码或自定义 profile，只需在其后列出本层即可获得这些功能：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@fi/authorization-bundle"]
    }
  }
}
```

标准的层路径同样适用：

```text
dsh plugin --profile <name> add @fi/authorization-bundle
dsh plugin --profile <name> remove @fi/authorization-bundle
```

add 命令会对 profile 做协调并激活该层；它通过 profile 的包管理器解析包名，该解析会访问 npm registry，未注册的 `@fi/*` 名称会在那里因拉取错误而失败，且不改动 profile。在源码检出中，请如上把该层列入 `dsh.profile.bundles`，并让它保持为 profile 的 workspace 依赖。

### 你得到什么

该层挂载授权服务、其 Remote 控制器、Models 订阅页脚、原生 Antigravity 适配器、提供方 HTTP 兼容处理和 FI 首选网页搜索。页脚支持 Claude、Codex、Grok 和 Antigravity；成功登录后采用模型路由，已有授权则可重试设置，无需再次登录。提供方兼容处理提供捕获派生的请求头及 Grok 订阅端点，不改变普通 API-key 请求。“首选网页搜索”卡片选择 DeepSeek、Exa、Perplexity、Parallel、Tavily、Serper、Brave Search 或订阅原生搜索，并通过凭据存储直接提供方密钥。

composer 的 Model 面板把四条订阅路由放在普通提供方下方、标为“订阅服务”的分区。Antigravity 的目录提供方名称是 `antigravity`，与小写路由标签一致；提供方和模型 id 不变。

该层还配置一个 `image_gen` 工具，包含 Codex、Grok 和 Antigravity 目标。Codex 是显式默认值；工具调用可以选择另一个已配置的提供方，失败请求不会切换提供方。`cordis.patch.yml` 中的 `fi-image-generation` 行负责模型选择和默认提供方。[图片生成包](../tool-image-generation/README.zh.md)负责参考图片编辑、限制及结果行为。Claude 没有原生光栅图片生成目标，但可以通过此工具使用另一个已登录的提供方。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

patch 文档为 `cordis.patch.yml`，通过一个 `insert` 块添加带 FI 前缀的行。它把基础 `web` 行的完整配置替换为稳定 FI 路由和现有 `http` fetch 提供方，并在 FI 路由拥有现有设置命名空间时禁用已被取代的基础 DeepSeek 提供方。FI 登录客户端插件向通用模型选择器的 `ctx.modelSubscriptions` 服务注册四条路由 id；Cordis 注入控制服务顺序，client-modules 插件把声明的客户端包纳入浏览器启动 manifest。上游 bundle 文档保持不变；移除此层会恢复上游组合并读取同一份已存储 DeepSeek 设置。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [`@deepseek-ai/dsh-authorization`](../../credentials/authorization/README.zh.md) —— 本层所挂载的 seam。
- [`@fi/api-authorization-controller`](../api-authorization-controller/README.zh.md) —— 从浏览器驱动该 seam 的 Remote 命名空间。
- [`@fi/client-ui-model-signin`](../client-ui-model-signin/README.zh.md) —— 本层携带的模型页面订阅登录区块。
- [`@fi/llm-antigravity`](../llm-antigravity/README.zh.md) —— 本层携带的 Antigravity OAuth 适配器与传输。
- [`@fi/provider-compat`](../provider-compat/README.zh.md) —— 提供方元数据、请求头与版本更新。
- [`@fi/tool-image-generation`](../tool-image-generation/README.zh.md) —— 基于订阅的图片生成与编辑。
- [`@fi/web-search-preferences`](../web-search-preferences/README.zh.md) —— 实时首选提供方路由。
- [`@fi/client-ui-web-search-preferences`](../client-ui-web-search-preferences/README.zh.md) —— 首选搜索设置与直接提供方凭据控件。
- [`@fi/web-search-subscription`](../web-search-subscription/README.zh.md) —— 被首选路由复用的引用证据门控订阅原生搜索。
- [Agent Note：模型设置中的订阅 OAuth 登录](../../../.agents/notes/implemented/feature/2026-09-11-subscription-oauth-sign-in.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

间接影响：该层挂载[图片生成工具](../tool-image-generation/README.zh.md#model-experience)和未修改的上游 `web_search` 工具，由相应包负责其 schema 和结果。

#### KV Cache 影响

添加或移除此层会改变已挂载的图像工具 schema。搜索提供方偏好不会更改 `web_search` schema 或 prompt。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- FI Desktop 自动挂载本组合包。其他 profile 必须显式列出；本包为私有包期间，无法从 registry 安装。
- 移除登录会保留该提供方的 settings 路由；两个动作为何分离，见登录卡片的说明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

manifest 声明 patch 引用的每个包，使已安装 profile 组合与源码检出解析相同的插件。

**Runtime invariant:** 不发布 companion。该层不持有运行时状态：其实质是一份 patch 文档，而它所挂载的 seam 拥有尝试的生命周期。

</details>
