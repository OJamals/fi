# @fi/llm-antigravity

[English](README.md) | 中文

Antigravity OAuth 适配器与 Cloud Code 传输，为 fi 提供 Antigravity 登录与推理能力。

## Table of Contents

- [Summary](#summary)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Summary

`@fi/llm-antigravity` 为 fi 添加 Antigravity OAuth 登录。持有具备 Antigravity 访问权限的 Google 账户的用户可登录一次，适配器将发现其 Cloud Code 项目、存储授权，并通过付费的 Cloud Code 端点路由推理请求。

## What it does

- 在 `ctx.authorization` 上注册 `fi-antigravity/antigravity` 流程
- 运行 Google PKCE OAuth 流程（浏览器 → 回环回调 → 令牌交换 → 项目发现）
- 将授权存储在 fi 的凭据存储中，键为 `fi-antigravity/antigravity`
- 拥有 `fi-antigravity` 设置命名空间：每条路由一份 profile，无 profile 时保持休眠
- 挂载一个 `LlmAdapter`，通过 Cloud Code 传输（带有 Antigravity envelope 的 `streamGenerateContent`）为这些路由提供服务
- 声明模型页面"添加提供方"目录所读取的目录项，并为其命名空间应答模型发现（授权可达实时目录时使用实时投影目录，否则回退到静态目录）
- 通过凭据接缝的串行化 `modifyRecord` 轮换临近过期的访问令牌，并发调用不会丢失刷新

## How it works

OAuth 流程使用 Antigravity 桌面应用的公共客户端 id，回环重定向到 `127.0.0.1:54545`，以及五个 scope（含 `cloud-platform` 与 `cclog`）。交换后通过 `loadCodeAssist` 发现 `cloudaicompanionProject`，它成为每个推理请求所命名的计费项目。

传输将 Gemini `contents`/`generationConfig` 包装进 Cloud Code envelope（`{project, model, request, userAgent: "antigravity", requestId, requestType: "agent"}`），并 POST 到 `v1internal:streamGenerateContent?alt=sse`。

**运行时不变量：** 未发布 invariant companion。流程每次尝试的 PKCE verifier 与回环服务器在该次尝试自身的运行内创建并拆除；只有已提交的授权会持久保留。

<a id="model-experience"></a>
## 模型体验

### 经 Cloud Code 传输的提供方请求

#### 模型看到什么

所选 Antigravity 模型接收一条系统指令（`GenerateOptions.system`，否则为历史消息前导 `system` 消息的文本）、投影为 Gemini `contents` 的其余历史（助手工具调用为 `functionCall` 部件，工具结果为 `functionResponse`）、工具声明与采样字段，并包装在指明用户已发现计费项目的 Cloud Code envelope 中。推理历史不作为文本重放；上游通过签名串接思考状态。此适配器不解析图像与文件块，因此其模型声明纯文本输入，界面会拒绝附件而不是静默丢弃。

#### Token 影响

提供方分词决定确切输入。思考强度映射到捕获派生的预算表（gemini-3.6 预设预算、传统思考预算，或 gemini-3 分级 id 的 `thinkingLevel`）。

#### KV Cache 影响

转换保持逻辑请求顺序。上游按请求无状态；envelope 的会话 id 是传输元数据，不改变模型所读内容。上游报告时，缓存内容 token 以 `cacheReadTokens` 呈现。

### 提供方响应

#### 模型看到什么

上游 Gemini SSE 事件成为 harness 的推理、文本、工具调用、用量与结束块；没有结束原因就终止的流呈现为错误，而不是静默截断的回答。

#### Token 影响

生成内容只有在循环记录后才影响后续输入。用量将提示/候选/思考计数映射为互斥的输入/输出字段，缓存输入单独报告。

#### KV Cache 影响

已记录的响应内容追加到下一个请求，不会使其更早的可复用前缀失效。

## Known Limitations and Deferred Work

- OAuth 流程需要浏览器（回环回调）。无头环境需要 `--manual` 模式或预授权令牌文件。
- 模型页面的提供方编辑器无法创建该路由：其 `layoutOf` 只认识上游命名空间，因此 `fi-antigravity` section 渲染为"字段在 settings.yaml 中"且 Apply 被禁用。登录区块的 adopt 链路（或在 settings.yaml 中手写 `fi-antigravity.providers.antigravity: {}`）才是路径。
- 目前仅文本：从附件服务解析 `ImageBlock`/`FileBlock` 字节的工作被推迟，适配器声明 `inputModalities: ['text']`，界面会拒绝附件而不是丢弃它们。
- Stealth 刻意保持最小：UA 字符串与发现请求中的 `ideType: "ANTIGRAVITY"` 是仅有的身份声明，均为捕获派生。
