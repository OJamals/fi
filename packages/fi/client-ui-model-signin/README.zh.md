---
description: "模型页面的订阅登录卡片，面向使用 Claude Pro/Max 与 ChatGPT Plus/Pro 推理的用户，以及扩展其所提供提供方的维护者。"
kind: "package-reference"
---

# @fi/client-ui-model-signin

[English](README.md) | 中文

## 概述

`@fi/client-ui-model-signin` 为模型设置页面添加 OAuth 登录，服务于那些价值在于用户已持有订阅的提供方——Claude Pro/Max 与 ChatGPT Plus/Pro。它通过模型区块自有的扩展槽位渲染在每个 pi-ai 提供方卡片内部，因此该区块本身不被修改。只有当 Host 确实为该提供方注册了 OAuth 流程时，对应行才会出现，这使得展示具备自我修正能力：缺少该适配器的 composition，或移除了某个登录的 pi-ai 版本，都只会什么都不显示。当提供方以密钥认证时，请使用模型页面已提供的 API 密钥字段。

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

将它挂载到同时挂载了模型页面与 [`@fi/api-authorization-controller`](../api-authorization-controller/README.zh.md) 的浏览器 composition 中；[`@fi/authorization-bundle`](../authorization-bundle/README.zh.md) 会把这些全部组合好。

### 用户看到什么

每个已注册 OAuth 流程的 pi-ai 提供方卡片都会新增一行登录区：一个带无障碍标签的状态点，以及一个带有该流程自身标签的按钮（“Anthropic (Claude Pro/Max)”、“OpenAI (ChatGPT Plus/Pro)”）。开始登录后，按钮会被实时对话替换——需要打开的页面、需要输入的设备码、流程提出的任何问题——并以一条由用户关闭的终态信息结束。成功的登录还会在路由不存在时写入该提供方的 settings 路由，因此卡片会汇报这次尝试留下了什么。已登录的提供方仍会提供重新登录入口（替换过期 refresh token 的方式）与“移除登录”动作：后者在 Host 侧以 `revoke` 动词撤销已存储的授权（因 Remote 客户端的命名空间服务占用了 `remove` 一词），把该行恢复为可登录状态，而不触碰路由。

### 页脚：为尚无路由的提供方添加

行卡片需要有一张提供方卡片可扩展，而在全新安装中根本不存在任何 pi-ai 路由。模型区块为此准备了第二个槽位 `settings.models.footer`：一条"使用您的订阅登录"区域，列出 Claude Pro/Max 与 ChatGPT Plus/Pro，使用相同的 OAuth 按钮运行相同对话，随后链接 Host 的 `adopt(key)`——upset settings 路由并回读它随后提供的模型。采用横幅报告路由结果（created 或 already present），并按已安装目录顺序列出所选提供方可用的每个模型 id；模型区块自身的 `settings/document-updated` 刷新把新行插入到页面已有行旁边。

已存储授权的提供方（早先登录完成）显示为已订阅而非可采用，因此页脚列表仅在添加第二个提供方时重新增大，而其自身席位的采用横幅仍保留最后一次采用的证据。

### 增加另一个提供方

`src/client/store.ts` 中的 `OFFERED` 即列表与顺序。新增一项只需一行；Host 未注册的提供方会被跳过，因此该列表是建议性的而非权威性的。始终只提供 `oauth` 方式——模型页面已以普通字段收集 API 密钥，为同一件事开第二道门只会让页面更糟。

<a id="understand-the-implementation"></a>
## 理解实现

注册通过 `settings.models.provider-card` 完成，这是模型区块为其自身包之外分发的插件所声明的带键槽位。该区块以行的 settings 命名空间作为 `entryKey` 分发它，对 pi-ai 适配器族拥有的每个路由而言即 `llm-pi-ai`，因此本插件在该键下注册一次，即可接收全部 pi-ai 卡片——内置的、新增的与手工声明的都包含在内。

store 同一时间只持有一次尝试，并把每个流帧折叠进去。`applyFrame` 是该状态之上的纯函数，这使得对话的顺序规则无需载体即可测试：`withdraw` 只撤回当前屏幕上的那个问题，而结束态总会清除仍在显示的任何问题。该状态中不保存任何密钥——用户输入的答复直接经由 `answer` 送出，草稿随即丢弃。

<a id="further-exploration"></a>
## 进一步探索

- [`@fi/api-authorization-controller`](../api-authorization-controller/README.zh.md) —— 本卡片所驱动的 Remote 命名空间。
- [`@deepseek-ai/dsh-client-ui-settings-models`](../../client/ui-settings-models/README.zh.md) —— 它所扩展的页面，以及它注册进入的槽位契约。
- [Agent Note：模型设置中的订阅 OAuth 登录](../../../.agents/notes/implemented/feature/2026-09-11-subscription-oauth-sign-in.zh.md)

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无，本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

移除登录会删除授权但保留 settings 路由；删除路由是模型页面自身的动作，二者刻意分离，使过期 token 的重置永远不会顺带改写提供方配置。

卡片会在凭据失效通知时以及自身尝试结束后重新加载其行，因此在第二个标签页中运行的尝试只会在下一次此类刷新时更新到当前页面。

<a id="dev-note"></a>
### 开发备注

卡片的测试通过脚本化的 store 而非真实载体来驱动它，而顺序规则之所以放在 `applyFrame` 中，正是为了能以这种方式断言。

**Runtime invariant:** 不发布 companion。Host 是唯一事实来源；卡片状态由 `list` 与其所发起尝试的帧重建。
