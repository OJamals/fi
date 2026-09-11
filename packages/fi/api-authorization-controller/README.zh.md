---
description: "authorization Remote 命名空间，面向构建“让用户登录提供方”的配置界面的维护者。"
kind: "package-reference"
---

# @fi/api-authorization-controller

[English](README.md) | 中文

## 概述

`@fi/api-authorization-controller` 拥有 `authorization` Remote 命名空间：浏览器配置页面借此列出可登录的对象、运行一次尝试、回答它提出的问题并取消它。一次尝试是一场对话，因此 `begin` 是一个流，在页面开启的载体上承载流程的通知、提示与最终结果。没有任何密钥双向穿过该命名空间。它依赖 authorization seam；若该 seam 缺失，每个方法都会以一条指明缺失 composition 行的诊断信息拒绝。

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

在已挂载 `@deepseek-ai/dsh-authorization` 的 composition 中挂载它——[`@fi/authorization-bundle`](../authorization-bundle/README.zh.md) 会同时完成两者。随后浏览器插件在自己的 `inject` 中声明 `remote.authorization`，并驱动这四个方法。

### 列出可登录的对象

```ts
const response = await ctx.remote.authorization.list()
// [{ key: 'llm-pi-ai/anthropic', label: 'Anthropic',
//    methods: [{ id: 'oauth', label: 'Anthropic (Claude Pro/Max)' }],
//    inFlight: false, stored: true }]
```

`stored` 关联了凭据 seam，因此页面无需第二次往返即可渲染“已登录”。只要有任何界面持有该 key，`inFlight` 即为 true——seam 会拒绝第二次并发尝试而非将其合并，因为两者会通过同一个流程向不同的人提问。

### 运行一次尝试

```ts
for await (const frame of ctx.remote.authorization.begin({ key, method: 'oauth' }, signal)) {
  if (frame.kind === 'notice') show(frame.message, frame.url, frame.code)
  if (frame.kind === 'prompt') await ctx.remote.authorization.answer(key, frame.id, await ask(frame.prompt))
  if (frame.kind === 'withdraw') retire(frame.id)
  if (frame.kind === 'settled') finish(frame.status, frame.message)
}
```

该流始终以恰好一个 `settled` 帧结束，失败也不例外，因此界面从该帧渲染终态，而不是从载体关闭去推断——连接中断与登录被拒绝绝不会看起来一样。

### 回答、拒绝与取消

以空字符串调用 `answer` 表示用户拒绝；该尝试将以 `cancelled` 结束，这正是 seam 自身对“拒绝”与“故障”的区分。`cancel` 通过第二次调用撤回该尝试，因为取消按钮无法持有第一次调用的载体。`withdraw` 帧用于撤回流程自己放弃的某个问题（竞争中落败的一方），并让该尝试继续运行。

### 登录留下的路由

针对 `llm-pi-ai/<id>` key 的成功尝试还会确保提供方存在于设置中：当 `llm-pi-ai` 命名空间缺少 `providers.<id>` 时，controller 会写入与模型页面自身“添加提供方”流程相同的空配置，使登录结束时得到的是一条可用路由而不仅是一份已存储的授权。settled 帧以 `route` 报告结果：`created` 表示新建；`already` 表示路由已存在（其配置绝不被动改）；`skipped` 表示没有可提交该写入的 settings 服务，此时授权仍然已存储，模型页面仍是显式路径。由一个常量把 scope 映射到命名空间——`llm-pi-ai` 路由进 pi-ai 的目录命名空间，`fi-antigravity` 路由进 Antigravity 适配器自己的命名空间——没有条目的 scope 登录时不触碰设置，下一个适配器族以一行扩展该映射。

### 移除：登录重置

`revoke(key)` 删除一条已存储的凭据记录，即让过期或损坏的授权可重新登录的重置。settings 路由刻意不受影响：它是用户配置，删除路由归模型页面所有。当某个 key 的尝试正在运行时 `revoke` 会拒绝，因为在存活流程之下删除记录会使其以一个谎言结束。（动词之所以不是 `remove`：客户端命名空间服务本身就有一个同名实例方法，Remote 客户端会拒绝与之冲突的方法名。）

### 采用：登录之后的路由

`listAdoptable()` 回答哪些凭据 scope 可由登录采用成 settings 路由，从而表面可为每个已安装的订阅登录提供“添加该提供方”；今天它是 pi-ai 目录的 OAuth 流程。`adopt(key)` 执行某次已完成登录的其余部分：读取已存储的授权（记录缺失时以 `authorization/no-grant` 拒绝），如路由不存在则写入 `llm-pi-ai` settings 路由，并枚举该路由随后提供的模型。路由 upsert 使用与模型页面自身“添加”流程相同的 `settings.mutate(expectedRevision)`，因此并发的用户编辑优先，绝不会被覆盖。模型列表来自已挂载 `llm` 服务的 `discoverModels({ provider: <id> })`——对目录提供方而言该调用由 pi-ai 自己的 registry 回答，不发生网络调用。若未挂载 settings 或 llm 服务，授权保持存储，模型页面仍是显式路径；调用以 `authorization/adopt-blocked` 如实报告，而非伪装路由已生效。

<a id="understand-the-implementation"></a>
## 理解实现

该 controller 承担 seam 所不承担的传输义务。线上的 key 形如 `<scope>/<id>`，两段都必须是凭据语法所要求的小写连字符标识符；它在此处被解析并重新加标记，因此浏览器传来的字符串绝不会未经检查地抵达 seam。视图逐字段投影，因此提供方返回的额外可枚举属性不会被继续序列化出去。

`Attempt` 是 seam 的推送模型与流的拉取模型之间的缓冲：流程可随时调用 `notify`，而载体按需读取。它同时持有等待浏览器答复的问题，按每次尝试内的 id 索引。被自身 signal 撤回的提示会以 `authorization/withdrawn` 拒绝，而非以“用户拒绝”拒绝，因为 seam 会把后者读作用户说不，从而导致之后真正的失败被误判。

<a id="further-exploration"></a>
## 进一步探索

- [`@deepseek-ai/dsh-authorization`](../../credentials/authorization/README.zh.md) —— 本命名空间所暴露的 seam。
- [`@fi/client-ui-model-signin`](../client-ui-model-signin/README.zh.md) —— 消费它的模型页面界面。
- [Agent Note：模型设置中的订阅 OAuth 登录](../../../.agents/notes/implemented/feature/2026-09-11-subscription-oauth-sign-in.zh.md)

<a id="model-experience"></a>
## 模型体验

无，本包服务于配置表层调用，不注册任何面向模型的内容。

#### KV Cache 影响

无，本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

一次尝试绑定于开启它的载体，因此登录过程中页面刷新会丢失该对话并须重新开始；若流程此前已提交授权，则该授权不受影响。观察某个并非自己发起的 key 的第二个界面只能得知该 key 处于 `inFlight`，并在下一次 `list` 时看到结果——seam 的 `authorization/settled` 事件未被转发，因为应用的转发事件白名单是一个上游文件，本包刻意不去触碰。

<a id="dev-note"></a>
### 开发备注

集成测试针对已安装的 pi-ai 目录而非固定装置进行断言，因此 pi-ai 升级若重命名某个提供方或移除其 OAuth，会在此处失败，而不是悄悄清空登录卡片。

**Runtime invariant:** 不发布 companion。seam 对每个 key 只拥有一次尝试，而本 controller 的每次尝试缓冲都在该尝试自身的流内创建并结束。
