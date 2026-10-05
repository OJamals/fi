---
description: "面向用户与维护者的部署默认模型选择说明，用于选择、配置或调试新创建的 agent（智能体）初始使用哪个模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-default-model

[English](README.md) | 中文

## 概述

为会话未指定模型的新 agent 提供共享默认 provider 和模型。Provider、模型和推理强度都是即时 Config 字段。保存的选择更新当前 profile patch，并用于后续读取；会话级选择仍由入口负责。

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

在创建 agent 且未显式给出模型路由的任何地方挂载本包。该服务回答一个问题——新 agent 应该使用哪个模型？——因此创建 agent 的入口查询它，而不必重新实现默认值。

### 配置默认值

组合同时提供 provider 和 model，或同时省略。即使没有挂载配置编辑器，消费者也可读取即时引用；可用性策略见下文。

仅包含 provider/model 的旧版完整 profile 覆盖通过 ConfigEditor 继承 profile 解析策略。显式 `selectionPolicy` 覆盖该策略；后续保存模型选择时保留策略。

```yaml
- name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek
    model: deepseek-chat
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 省略 | 已注册提供方路由；与 `model` 同时配置 |
| `model` | 省略 | 提供方模型 id；与 `provider` 同时配置 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-default-model) 列出所有接受的字段。`reasoningEffort` 是可选的；保存不含此字段的选择，会从 profile 的完整配置覆盖中移除此字段。

### 读取与更改默认值

创建新 agent 前等待 `resolveSelection()`，返回可用选择或表示需要设置的 `undefined`。`currentSelection()` 返回独立的已配置或最后解析的选择，也可返回 `undefined`。`saveSelection()` 显式保存完整选择；传入 `undefined` 清除选择但保留策略配置。自动解析不写入 profile。

```text
const selection = await ctx.agentDefaultModel.resolveSelection()
await ctx.agentDefaultModel.saveSelection({ provider, model, reasoningEffort: 'high' })
```

没有配置编辑器时，`saveSelection()` 不执行写入。`selectionPolicy: configured` 保留配置的 provider/model；两者同时配置或同时省略。`available` 需要 LLM、Credentials 和 Settings 服务，保留可用显式选择，然后优先订阅授权，再选择已配置 API 提供方；失败的目录和无法解析的模型被跳过。`subscriptionCredentials` 将路由映射到授权键；`credentiallessProviders` 显式允许无凭据自动选择。已有 Session 的不可用选择由消费者诊断；已配置凭据不保证生成成功。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该服务如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中完整说明。

### 设计理念

此服务保留已验证的 Config 引用，并在 `currentSelection()` 中读取。`saveSelection()` 捕获提交值，并按提交顺序串行写入 profile，包括调用重叠的情况。每个调用方收到各自的写入失败；一次写入被拒绝不会阻止后续保存。消费者优先使用会话级选择。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 即时默认选择与 profile 写入 |
| — | 不发布 invariant 配套模块，因为解析值派生自配置和实时提供方元数据，并非独立观察。 |

### 行为说明

`currentSelection()` 返回分离的选择值。已捕获的选择保持稳定，后续操作则读取更新后的 Config 引用。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域时再阅读以下页面。

- [Core 子系统](../../../docs/subsystems/core.zh.md)——`Agent` 句柄与 `AgentOptions` 路由选择。
- [agent-loop 包](../agent-loop/README.zh.md)——agent 在请求时如何解析提供方与模型。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-default-model)——每个受支持配置字段及其源声明。
- [core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

通过该服务提供给入口的 `ModelSelection` 间接影响；模型可见请求由请求组装与提供方适配器负责。

#### KV Cache 影响

更改默认值只影响之后从它解析选择的 agent。请求日志已经指明选择的现有会话仍沿用该选择，因此本服务不会使其已建立的前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定该服务的范围。它们是当前包约束，不是任务积压。

- **单一的进程级默认值**——该服务只拥有一个默认值；按会话的模型选择仍由入口负责。
- **持久化需要 profile 配置编辑器**——没有编辑器时，保存默认值不会保留选择。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
