---
description: "为 dsh --profile 表层添加提供方订阅登录能力的 fi 组合包层，面向组合或定制 profile 的用户。"
kind: "package-bundle"
---

# @fi/authorization-bundle

[English](README.md) | 中文

## 概述

`@fi/authorization-bundle` 为任何基于 base 的 `dsh --profile` 表层添加订阅登录能力：它挂载 authorization seam、其 Remote 命名空间，以及模型设置页内的登录卡片，使持有 Claude Pro/Max 或 ChatGPT Plus/Pro 订阅的用户能够使用其已付费的推理能力。没有任何 profile 默认包含它；需要登录能力的 profile 把它列在 `@deepseek-ai/dsh-base` 之后。该层在一次登录实际运行之前保持惰性：它自身不注册任何模型路由，也不获取任何凭据。它不是供导入的库。

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

已声明 `@deepseek-ai/dsh-base` 的 profile，只需在其后列出本层即可获得登录能力：

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

有三行进入组合。`@deepseek-ai/dsh-authorization` 挂载 `ctx.authorization`，即插件登录流程所注册的 seam。`@fi/api-authorization-controller` 拥有 `authorization` Remote 命名空间，浏览器表层由此可以列出流程、运行一次尝试、答复其提问并取消它。`@fi/client-ui-model-signin` 为每个提供方已注册 OAuth 流程的模型提供方卡片添加登录行，按 pi-ai 目录目前为 Claude Pro/Max 与 ChatGPT Plus/Pro，并实时渲染流程的通知、设备码与提示。流程提交的授权在模型页面管理的既有设置下为该提供方的路由提供认证。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部——点击展开</summary>

patch 文档是 `cordis.patch.yml`：一行挂载 seam，另有一个 `insert` 块加入 Remote 拥有方与浏览器卡片。行 id 以 `fi-` 为前缀，遵循本仓库对 fi 自有行的约定。顺序无需人工编排：`AuthorizationService` 声明了 `static inject = ['credentials']`，因此 Cordis 会持有它直到 base 层的 `credentials` 行就绪。浏览器行是一个 `dsh.client` 包，因此 client-modules 的 node 半边会像其他上游浏览器插件一样把它扫描进 `window.__DSH_BOOT__`。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [`@deepseek-ai/dsh-authorization`](../../credentials/authorization/README.zh.md) —— 本层所挂载的 seam。
- [`@fi/api-authorization-controller`](../api-authorization-controller/README.zh.md) —— 从浏览器驱动该 seam 的 Remote 命名空间。
- [`@fi/client-ui-model-signin`](../client-ui-model-signin/README.zh.md) —— 本层携带的模型页面卡片。
- [Agent Note：模型设置中的订阅 OAuth 登录](../../../.agents/notes/implemented/feature/2026-09-11-subscription-oauth-sign-in.zh.md)

-----

<a id="model-experience"></a>
## 模型体验

无，本包是一份组合 patch 文档，不注册任何面向模型的内容。

#### KV Cache 影响

无，本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- profile 必须显式列出本组合包；没有自动挂载机制。在保持 delta 增量时这是刻意安排，但若某个 composition 添加了具备登录能力的插件却遗漏本层，将既无登录也无诊断，因为那些流程根本不会注册。
- 移除登录会保留该提供方的 settings 路由；两个动作为何分离，见登录卡片的说明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

测试断言该 patch 始终是良好的一行加 `insert` 块、manifest 会发布它，以及在 credentials 就绪前保持挂起的行为成立，因为三者中任何一处笔误都会静默地什么也不挂载。

**Runtime invariant:** 不发布 companion。该层不持有运行时状态：其实质是一份 patch 文档，而它所挂载的 seam 拥有尝试的生命周期。

</details>
