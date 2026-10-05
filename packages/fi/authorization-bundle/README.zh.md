---
description: "为 dsh --profile 表层添加提供方订阅登录能力的 fi 组合包层，面向组合或定制 profile 的用户。"
kind: "package-bundle"
---

# @fi/authorization-bundle

[English](README.md) | 中文

## 概述

`@fi/authorization-bundle` 在共享 [FI 运行时层](../runtime-bundle/README.zh.md)上添加订阅登录和搜索设置界面。FI Web 和 Desktop 将它放在 base、web-app 和 runtime-bundle 后；自定义 GUI profile 使用相同顺序。该层自身不获取凭据或模型路由；用户在设置中配置授权和密钥。

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

FI Desktop 在本地包集和固定内置 profile 中提供这个私有层，不从 npm 安装。源码或自定义 GUI profile 在 base、web-app 和 runtime-bundle 后列出本层即可获得这些功能：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@fi/runtime-bundle", "@fi/authorization-bundle"]
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

FI 使用不绑定提供方的引导流程，并禁用 DeepSeek 账户界面、账户 Remote、产品分析和 Desktop 产品遥测。只有解析的默认模型属于可用目录分组时，引导才就绪。运行时层负责模型与搜索解析、可选 DeepSeek 访问、适配器及禁用 Session 反馈上传。

基础 bundle 挂载授权服务；该层挂载其 Remote 控制器、Models 订阅页脚和首选搜索卡片。页脚支持 Claude、Codex、Grok、Antigravity 和 OpenCode Console；成功登录后采用模型路由，已有授权可重试设置，无需再次登录。搜索设置提供 Auto、Bing RSS、显式 API 提供方及订阅原生搜索，并通过凭据存储直接提供方密钥。

composer 的 Model 面板把订阅路由放在普通提供方下方、标为“订阅服务”的分区。Antigravity 的目录提供方名称是 `antigravity`，与小写路由标签一致；提供方和模型 id 不变。

此 GUI bundle 为 Codex、Grok 和 Antigravity 配置 `image_gen`；Codex 是显式图片默认值。失败请求不切换提供方。[图片生成包](../tool-image-generation/README.zh.md)负责参考图片编辑、限制及结果行为。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

patch 文档为 `cordis.patch.yml`，通过 `insert` 添加带 FI 前缀的浏览器和 Remote 行。FI 登录客户端插件向通用模型选择器的 `ctx.modelSubscriptions` 注册订阅路由；Cordis 注入控制服务顺序，client-modules 将声明的客户端包纳入浏览器启动 manifest。移除此 GUI 层保留运行时提供方和偏好。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [`@deepseek-ai/dsh-authorization`](../../credentials/authorization/README.zh.md) —— 基础 bundle 挂载、本层使用的 seam。
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

间接影响：显式模型和搜索选择，以及已挂载的图片工具。所属包定义请求 schema 和结果。

#### KV Cache 影响

添加或移除此 GUI 层改变图片工具 schema。搜索提供方偏好不会更改 `web_search` schema 或 prompt。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- FI Web 和 Desktop 自动挂载此 GUI bundle。自定义 GUI profile 需在 runtime-bundle 后显式列出；本包为私有包期间，无法从 registry 安装。
- 移除登录会保留该提供方的 settings 路由；两个动作为何分离，见登录卡片的说明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

manifest 声明 patch 引用的每个包，使已安装 profile 组合与源码检出解析相同的插件。

**Runtime invariant:** 不发布 companion。该层不持有运行时状态：其实质是一份 patch 文档，而它所挂载的 seam 拥有尝试的生命周期。

</details>
