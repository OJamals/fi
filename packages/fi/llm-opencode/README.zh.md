---
description: "OpenCode Console 设备授权、组织范围凭据、已认证文本模型发现与传输。"
kind: "package-reference"
---

# @fi/llm-opencode

[English](README.md) | 中文

## 概述

OpenCode Console 订阅登录位于设置 → 模型。授权组合包挂载此插件；空挂载注册登录和提供者目录项，配置 `providers.opencode-console` 后启用推理。凭据保存在 FI 的规范凭据存储中，键为 `fi-opencode/opencode-console`；授权控制器在登录后创建对应设置路由。

## 目录

- [Authorization and configuration](#authorization-and-configuration)
- [Protocol sources](#protocol-sources)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

## Authorization and configuration

设备授权显示浏览器 URL 和验证码，不监听回调端口。轮询遵守等待和减速响应、最长一小时的设备授权期限、请求超时以及取消信号。浏览器选择的令牌组织优先于旧版无组织范围令牌的排序回退。刷新在凭据存储的记录锁中运行，保留身份信息，在发现模型前保存轮换令牌和变更的组织。凭据撤销或缺失 SSO 时需要重新连接。

`server`、`clientId` 和 `userAgent` 配置 Console 端点及公开客户端标识。端点、OAuth 和目录默认值来自 [`@fi/provider-compat`](../provider-compat/README.zh.md) 的规范 `opencodeConsole` 记录。默认 User-Agent 来自[已验证的客户端抓包](src/client-capture.json)，独立于发布元数据；更新它必须重新抓包并验证实时推理。`requestTimeoutMs`、`streamIdleTimeoutMs`、`refreshMarginMs`、`defaultContextWindow` 和 `defaultMaxTokens` 配置超时及远端未声明的容量。端点仅允许 HTTPS OpenCode 域名，所有请求拒绝重定向。

路由 profile 接受 `displayName` 和已选 id 数组 `models`。省略数组时显示所有已声明模型；空数组隐藏全部模型。发现始终返回完整的已认证目录。选择仅影响模型选择器，不限制显式解析或已准备调用；授权仍决定账户与组织。提供方默认名称使用小写路由 id。

目录读取通过 `catalogRetryCount`（默认 `3`，`0` 禁用重试）和 `catalogRetryDelayMs`（初始延迟，默认 `500`）重试已识别的暂时性网络故障。每次重试的延迟翻倍，上限为 `requestTimeoutMs`；所有尝试和等待共用该截止时间及调用方取消信号。重试耗尽时报告网络错误代码、目标主机、尝试次数和恢复提示。认证、重定向、证书错误、无效目录和令牌交换不会重试。该策略遵循 [Undici RetryHandler](https://github.com/nodejs/undici/blob/main/docs/docs/api/RetryHandler.md) 记录的有界退避方案，不替换应用的 fetch 传输。

## Protocol sources

规范[提供方元数据](../provider-compat/src/provider-settings.json) 固定 OpenCode Console 插件与模型请求的源码引用，涵盖设备令牌、组织范围和客户端/会话标头。Auth2api 的适配器提供 v2 目录映射和协议选择的本地参考。

已认证的 `/api/v2/config` 提供启用且支持文本输入和输出的模型、端点 URL、协议、线上模型标识和容量。未声明模态元数据的模型使用文本默认值。支持的包使用 Anthropic Messages、OpenAI Responses 或 OpenAI chat completions。包含提供者前缀的选择标识与线上模型标识在持久化重放中保持分离。准备调用时同时固定模型目录项、账户、组织和选项。发现失败不会回退到公开模型或其他账户。

OpenAI 兼容推理收到 `403 FreeTierError` 时，使用与 auth2api 兼容的流式传输和工具选择重试。Chat 后端以 HTTP 400 或 5xx 拒绝受限选择时，再尝试一次 `auto`；本地验证仍拒绝未声明或禁用的工具。如果 `https://opencode.ai/inference/openai/v1/chat/completions` 仍返回 `403 FreeTierError`，则最后尝试一次将原始请求发送至 `https://opencode.ai/zen/v1/chat/completions`，保留模型、授权凭据、组织、请求头和对话。此路由恢复要求返回 SSE，且不适用于其他端点、协议、身份验证错误或 SSO 失败。持续的免费层拒绝报告 `POLICY_REJECTED`。结构化的 `403 SsoRequired` 报告 `SSO_REQUIRED` 并提示重新连接；其他错误继续由共享 SDK 处理。

<a id="model-experience"></a>
## 模型体验

### Console model request and response

#### 模型看到什么

模型通过共享 pi-ai 转换读取 `GenerateOptions` 中 FI 记录的系统提示、对话和实际工具声明。远端请求默认值仅接受数字采样字段，不能替换凭据、系统消息、工具或对话输入。请求包含 Console 组织认证和原生会话路由标头。pi-ai 将文本、推理、工具调用、用量、结束原因和重放元数据映射到现有会话协议；消费方取消和空闲超时会终止传输。

#### Token 影响

提供者响应提供令牌数量及缓存用量；远端未声明容量时使用配置默认值。OpenCode 提示组装在记录请求头之前补充缺失的 `read` 和 `shell` 兼容声明。其 schema 分别要求字符串类型的 `path` 和 `command` 字段；空 schema 无法通过 Console 免费层校验。已有同名工具保留原定义。新增声明消耗输入令牌且不能执行；不带 Session 的直接适配器调用在转换时获得相同声明。

#### KV Cache 影响

重放保留有序对话块和支持的原生签名。会话路由标头使用 OpenCode 的降序时间戳编码，在适配器生命周期内对同一持久会话保持稳定。这些标头属于模型不可见的元数据。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 此适配器提供文本输入和输出，不提供图像、原生搜索、提供者专用推理控制或远端 MCP/策略安装。免费层配额、模型可用性和 Console 余额由提供者管理；目录中列出模型不代表推理可用。

**Runtime invariant:** 不发布配套检查器。凭据存储负责授权记录串行化；每个准备调用持有一个不可变的目录和凭据代次，没有独立的注册镜像。

组织管理的策略需要官方 OpenCode 客户端；声明策略的目录会被拒绝，不会被静默忽略。协议选择仅接受三种支持的包名，可带 `aisdk:` 前缀；继承的 JavaScript 对象属性名不能声明协议。

### 开发备注

<details>
<summary>面向维护者的工作背景 — 点击展开</summary>

无。

</details>
