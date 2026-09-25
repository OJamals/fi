---
description: "模型页面的订阅登录区块，面向使用 Claude Pro/Max、ChatGPT Plus/Pro、SuperGrok/X Premium 与 Antigravity 推理的用户，以及扩展其提供方范围的维护者。"
kind: "package-reference"
---

# @fi/client-ui-model-signin

[English](README.md) | 中文

## 概述

`@fi/client-ui-model-signin` 为模型设置页面添加一个订阅登录区块，服务于那些价值在于用户已持有订阅的提供方——Claude Pro/Max、ChatGPT Plus/Pro、SuperGrok/X Premium 与 Antigravity。它通过模型区块的页脚扩展槽位渲染。紧凑选择器只列出 Host 已注册 OAuth 流程的提供方，因此缺少适配器的 composition 会直接省略该提供方。当提供方以密钥认证时，请使用 API 密钥字段。

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

模型页面 API 密钥提供方列表下方有一个“使用您的订阅登录”区块，为 Anthropic (Claude Pro/Max)、OpenAI Codex (ChatGPT Plus/Pro)、xAI (SuperGrok/X Premium) 与 Antigravity 提供紧凑且可访问的提供方选择器。已配置且未带密钥的可用 OAuth 路由显示在登录控件下方，保留编辑与删除操作；带 `apiKeyEnv` 的 profile 留在 Models 主列表。选择器宽度受限，与未登录提供方的状态和操作并列；已登录提供方的管理操作占据下方整行。窄屏时控件上下排列，不产生水平滚动。选中的提供方显示其状态点、无障碍状态标签和仅属于它的可用操作。未登录的提供方提供“添加提供方”；单击即运行实时登录对话，再调用 Host 的 `adopt(key)`，以 upsert 该提供方的 settings 条目并回读其模型。已存储授权提供“设置提供方”，因此提供方可完成或重试设置而无需再次进行 OAuth。采用结果报告条目结果，并将模型列表放在折叠控件后面。

已登录的提供方显示“重新登录”，以替换过期 refresh token，并显示“移除登录”，以撤销已存储的授权而不触碰其 settings 条目。选择器只改变可见提供方；它不会启动认证或改变推理选择。未完成的本地认证或采用会禁用选择器。实时登录对话会显示其提供方名称，而完成的采用会选中其提供方并显示该结果。区块监听 `credentials/record-updated` 与 `credentials/reference-updated`，因此任何地方删除授权都会重新提供登录。它为列表显示加载和失败状态以及重试，检查每个一元 Remote 回复，并保留被拒操作的诊断。开始操作会清除先前的采用横幅，而操作标识会阻止已关闭或被替代的登录发布迟到的采用结果。

该区块是唯一的登录界面：两个位置的提供方行都保持为纯路由行，不夹入任何凭据 UI。Antigravity 原生的「添加提供方」编辑器只采用已存储的授权；没有授权时，它会引导用户回到此区块，而不会打开另一段登录对话。

### 增加另一个提供方

`src/client/store.ts` 中的 `SUBSCRIPTION_PROVIDER_IDS` 负责路由 id 与顺序；`OFFERED` 由此生成凭据键。Host 未注册的提供方会被跳过。连接后的可用行通过 `ctx.modelSettingsSubscriptions` 注册，因此 Models 页面只分组可用 OAuth 路由；流程消失时，其行会回到主列表。挂载通用模型选择器时，本插件向其 `ctx.modelSubscriptions` 服务注册静态 id，把可用订阅模型分组放在带标签的底部分区，而不更改选择或认证。这里只提供 `oauth` 方式；Models 页面另行收集 API 密钥。

<a id="understand-the-implementation"></a>
## 理解实现

注册通过 `settings.models.footer` 与 keyed 的 `settings.models.provider-editor` 槽位完成。后者只替换 Antigravity 的通用编辑器，并共享 footer 的 store，因此可采用已存储的授权而不复制登录流程。区块的行集合由本包的 `OFFERED` 白名单与 Host 已注册流程连接而成，因此 Antigravity 尽管不在 pi-ai 目录中，也能在同一区块渲染；可采用性连接来自 `listAdoptable`，其 scope→route 映射由两个适配器族共享。页脚在本地保存选择，从未完成尝试派生活跃提供方，并在外部刷新移除当前选择时回退到第一个剩余提供方。

store 同一时间只持有一次尝试，并把每个流帧折叠进去。`applyFrame` 是该状态之上的纯函数：`withdraw` 只撤回当前屏幕上的那个问题，而结束态会清除仍在显示的任何问题。每次登录、采用与移除都有操作标识，因此迟到的 Remote 回复不能改写较新的快照。该状态中不保存任何密钥——用户输入的答复直接经由 `answer` 送出，草稿随即丢弃。

<a id="further-exploration"></a>
## 进一步探索

- [`@fi/api-authorization-controller`](../api-authorization-controller/README.zh.md) —— 本卡片所驱动的 Remote 命名空间。
- [`@deepseek-ai/dsh-client-ui-settings-models`](../../client/ui-settings-models/README.zh.md) —— 它所扩展的页面，以及它注册进入的槽位契约。
- [`@deepseek-ai/dsh-client-ui-model-selection`](../../client/ui-model-selection/README.zh.md) —— 它所贡献的仅供显示的订阅分组。
- [Agent Note：模型设置中的订阅 OAuth 登录](../../../.agents/notes/implemented/feature/2026-09-11-subscription-oauth-sign-in.zh.md)
- [Agent Note：composer 模型选择器中的订阅提供方](../../../.agents/notes/implemented/feature/2026-09-15-subscription-model-picker-section.zh.md)

<a id="model-experience"></a>
## 模型体验

无，本包是浏览器侧 UI 插件层，不注册任何面向模型的内容。

#### KV Cache 影响

无，本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 移除登录会删除授权但保留 settings 条目；删除该条目是模型页面自身的动作，因此过期 token 的重置不会顺带改写提供方配置。

- 区块会在凭据失效通知时（密钥走 `reference-updated`，授权走 `record-updated`）以及自身操作结束后重新加载其行；第二个标签页中完成的 OAuth 也通过同一 record 事件通告。

<a id="dev-note"></a>
### 开发备注

测试使用脚本化的 Remote 回复，包括手动释放的采用回复，以覆盖响应失败与已被替代的异步工作。

**Runtime invariant:** 不发布 companion。Host 是唯一事实来源；卡片状态由 `list` 与其所发起尝试的帧重建。
