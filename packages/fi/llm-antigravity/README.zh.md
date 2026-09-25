---
description: "面向配置或扩展付费 Cloud Code 推理的维护者，介绍 Antigravity OAuth、刷新授权、原生 Gemini 传输与 fi LLM 适配器。"
kind: "package-reference"
---

# @fi/llm-antigravity

[English](README.md) | 中文

Antigravity OAuth 适配器与 Cloud Code 传输，为 fi 提供 Antigravity 登录与推理能力。

## 目录

- [概述](#summary)
- [功能](#what-it-does)
- [工作原理](#how-it-works)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="summary"></a>
## 概述

`@fi/llm-antigravity` 为 fi 添加 Antigravity OAuth 登录。持有具备 Antigravity 访问权限的 Google 账户的用户可登录一次，适配器将发现其 Cloud Code 项目、存储授权，并通过付费的 Cloud Code 端点路由推理请求。

<a id="what-it-does"></a>
## 功能

- 在 `ctx.authorization` 上注册 `fi-antigravity/antigravity` 流程
- 运行 Google PKCE OAuth 流程（浏览器 → 回环回调 → 令牌交换 → 项目发现）
- 将授权存储在 fi 的凭据存储中，键为 `fi-antigravity/antigravity`
- 拥有 `fi-antigravity` 设置命名空间：每条路由一份 profile，无 profile 时保持休眠
- 挂载一个 `LlmAdapter`，通过 Cloud Code 传输（带有 Antigravity envelope 的 `streamGenerateContent`）为这些路由提供服务；模型目录中的提供方名称为小写路由 id `antigravity`
- 声明模型页面"添加提供方"目录所读取的目录项，并为其命名空间应答模型发现（授权可达实时目录时使用实时投影目录，否则回退到静态目录）
- 通过凭据接缝的串行化 `modifyRecord` 轮换临近过期的访问令牌，并发调用不会丢失刷新
- 每次登录与刷新都通过凭据接缝解析 Google OAuth 客户端 id 与密钥，绝不作为仓库字面量；两者均未配置时，登录与刷新会显式失败并指出这两个引用名

<a id="how-it-works"></a>
## 工作原理

OAuth 流程使用一个 Google 已安装应用 OAuth 客户端、回环重定向到 `127.0.0.1:54545`，以及五个 scope（含 `cloud-platform` 与 `cclog`）。交换后通过 `loadCodeAssist` 发现 `cloudaicompanionProject`，它成为每个推理请求所命名的计费项目。

### OAuth 客户端配置

客户端 id 与密钥从不随本仓库分发：GitHub 密钥扫描会把 Google 已安装应用的客户端 id 与密钥对等同于已泄露的凭据来标记，且运行该适配器的部署方拥有决定使用哪个 Google OAuth 客户端进行认证的权限。`resolveAntigravityOAuthClient(ctx, refs?)` 在凭据接缝已挂载时通过 `ctx.credentials.resolve(ref)` 解析两者，否则回退到启动环境——这与 `llm-pi-ai` 与 `fi-web-search-preferences` 使用的回退方式相同。这两个引用默认为 `ANTIGRAVITY_OAUTH_CLIENT_ID` 与 `ANTIGRAVITY_OAUTH_CLIENT_SECRET`；`FiAntigravityConfig` 的 `oauthClientIdRef`/`oauthClientSecretRef` 字段（均为 `Volatile<string>`）允许部署方在不重启的情况下实时改用其他引用名。登录前请将这两个值设置为环境变量、写入 `.env` 文件（fi home 目录或启动目录），或作为已存储的凭据（网页版模型页面会写入它们）。两者缺失任意一个都会使登录尝试与任何令牌刷新显式失败，并指出这两个引用名及每个可设置的位置；`listModels` 与静态目录在未登录时仍照常工作。

传输从 `@fi/provider-compat` 读取固定于捕获结果的端点、CLI 指纹版本、客户端、构建号与认证方式，在该指纹中加入运行时操作系统和架构，再将 Gemini `contents`/`generationConfig` 包装进 Cloud Code envelope（`{project, model, request, userAgent: "antigravity", requestId, requestType: "agent"}`），并 POST 到 `v1internal:streamGenerateContent?alt=sse`。

订阅能力消费者从包根调用 `resolveAntigravityGrant(ctx, signal)`，使令牌刷新继续由凭据存储串行处理。原生 Gemini 消费者从 `@fi/llm-antigravity/transport` 导入 `callAntigravityGeminiNative`；`action: "generateContent"` 返回汇总后的原生 Gemini JSON，`streamGenerateContent` 返回原生 SSE。同一传输还导出 `callAntigravityImageGenerations` 与 `callAntigravityImageEdits`，它们将 OpenAI Images 请求字段投影为原生 Gemini 请求，并在不增加第二套 SSE 解析器的情况下返回 OpenAI Images JSON。传输保留 `groundingMetadata` 等候选项元数据；网页搜索提供方负责依据验证与结果投影。

每次上游 fetch 都拒绝重定向。原生请求、内联媒体、响应总量、SSE 行与 SSE 帧上限是正整数调用选项；省略原生请求、内联媒体与响应总量上限时使用捕获所得的 20 MiB 协议/安全上限，fi 图像投影则复用部署中已验证的附件策略。非成功响应和流内提供方错误只暴露状态诊断；取消操作或返回的流都会取消上游读取器。

**运行时不变量：** 未发布 invariant companion。流程每次尝试的 PKCE verifier 与回环服务器在该次尝试自身的运行内创建并拆除；只有已提交的授权会持久保留。

<a id="model-experience"></a>
## 模型体验

### 经 Cloud Code 传输的提供方请求

#### 模型看到什么

所选 Antigravity 模型接收一条系统指令（`GenerateOptions.system`，否则为历史消息前导 `system` 消息的文本）、投影为 Gemini `contents` 的其余历史（助手工具调用为 `functionCall` 部件，工具结果为 `functionResponse`）、工具声明与采样字段，并包装在指明用户已发现计费项目的 Cloud Code envelope 中。图像生成模型请求原生 `IMAGE` 响应模态；聊天适配器保留常规系统指令与函数声明，`gemini-3.1-flash-image` 已在真实适配器路径请求中接受这两者。Gemini `generateContent` 签名可能属于推理、可见文本、图像或函数调用部件；`ReplayEnvelope.response.nativeParts` 保留精简的部件顺序与签名元数据。生成图像在发布其 `ImageBlock` 前会完整通过附件服务准入。显示附件包含规范化光栅；已签名原生图像部件则把已验证的原始字节保存为私有持久文件引用，因此即使规范化或切换模型，重放仍发送签名所覆盖的精确字节。重放 envelope 不保存图像 base64。用户与工具结果的图像引用通过持久附件服务已验证的图像策略解析为 Gemini 内联数据，并受固定 20 MiB 汇总上限约束。持久文件引用在会话日志中保持结构化，但 LLM 运行时会在适配器分发前将每次出现（包括嵌套工具结果）替换为确定性的句柄文本，其中包含文件名、字节数、摘要与只读保存路径。模型通过已挂载的文件工具读取该路径；任意二进制文件并非 Antigravity 原生输入。

#### Token 影响

提供方分词决定确切输入。思考强度映射到捕获派生的预算表（gemini-3.6 预设预算、传统思考预算，或 gemini-3 分级 id 的 `thinkingLevel`）。

#### KV Cache 影响

转换保持逻辑请求顺序。上游按请求无状态；envelope 的会话 id 是传输元数据，不改变模型所读内容。上游报告时，缓存内容 token 以 `cacheReadTokens` 呈现。

### 提供方响应

#### 模型看到什么

上游 Gemini SSE 事件按原生部件顺序成为 harness 的推理、文本、图像、工具调用、用量与结束块；没有结束原因就终止的流呈现为错误，而不是静默截断的回答。生成图像数量与解码后总字节数使用已挂载附件策略的限制；附件服务只有在解码并验证真实光栅后才接受声明的图像媒体类型。

#### Token 影响

生成内容只有在循环记录后才影响后续输入。用量将提示/候选/思考计数映射为互斥的输入/输出字段，缓存输入单独报告。

#### KV Cache 影响

已记录的响应内容追加到下一个请求，不会使其更早的可复用前缀失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- OAuth 流程需要访问所显示的浏览器 URL 及其位于 `127.0.0.1:54545` 的回环回调；它不提供手动代码输入路径。
- 原生 Gemini 传输返回提供方 JSON 与元数据；消费它的网页搜索包负责依据要求、引用与面向用户的投影。
- Antigravity 兼容元数据仍固定于捕获结果。`@fi/provider-compat` 拥有端点与 CLI 指纹字段；更新该生成记录需要新的捕获证据。
- Stealth 刻意保持最小：UA 字符串与发现请求中的 `ideType: "ANTIGRAVITY"` 是仅有的身份声明，均为捕获派生。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
