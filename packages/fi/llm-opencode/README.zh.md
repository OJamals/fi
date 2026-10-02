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

`server`、`clientId` 和 `userAgent` 配置 Console 端点及公开客户端标识。默认值匹配已检查的 OpenCode 2.0.20 版本：`https://opencode.ai/console`、`opencode-cli` 和 `opencode/latest/2.0.20/cli`。`requestTimeoutMs`、`streamIdleTimeoutMs`、`refreshMarginMs`、`defaultContextWindow` 和 `defaultMaxTokens` 配置超时及远端未声明的容量。端点仅允许 HTTPS OpenCode 域名，所有请求拒绝重定向。上游客户端变化时需要重新审查这些标识默认值；仅凭发布元数据不能确认传输兼容性。

## Protocol sources

[OpenCode Console 插件](https://github.com/anomalyco/opencode/tree/v2.0.20) 定义设备和组织范围令牌语义。[模型请求实现](https://github.com/anomalyco/opencode/tree/v2.0.20) 定义客户端和会话标头。Auth2api 的适配器提供 v2 目录映射和协议选择的本地参考。

已认证的 `/api/v2/config` 提供启用且支持文本输入和输出的模型、端点 URL、协议、线上模型标识和容量。未声明模态元数据的模型使用文本默认值。支持的包使用 Anthropic Messages、OpenAI Responses 或 OpenAI chat completions。包含提供者前缀的选择标识与线上模型标识在持久化重放中保持分离。准备调用时同时固定模型目录项、账户、组织和选项。发现失败不会回退到公开模型或其他账户。

推理返回 `403 FreeTierError` 时报告 `POLICY_REJECTED`，提示选择其他 Console 模型或使用官方 OpenCode 客户端。结构化的 `403 SsoRequired` 报告 `SSO_REQUIRED` 并提示重新连接。这些失败保留安全的恢复说明，不回显提供者响应字段，也不将其误报为无效 API 密钥；普通认证错误和未识别的响应继续由共享 SDK 处理。

<a id="model-experience"></a>
## 模型体验

### Console model request and response

#### 模型看到什么

模型通过共享 pi-ai 转换读取 `GenerateOptions` 中 FI 记录的系统提示、对话和实际工具声明。远端请求默认值仅接受数字采样字段，不能替换凭据、系统消息、工具或对话输入。请求包含 Console 组织认证和原生会话路由标头。pi-ai 将文本、推理、工具调用、用量、结束原因和重放元数据映射到现有会话协议；消费方取消和空闲超时会终止传输。

#### Token 影响

提供者响应提供令牌数量及缓存用量；远端未声明容量时使用配置默认值。输入转换保留已记录的文本和工具声明，不添加传输专用工具定义。

#### KV Cache 影响

重放保留有序对话块和支持的原生签名。持久会话的路由标头保持稳定，属于模型不可见的元数据。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 此适配器提供文本输入和输出，不提供图像、原生搜索、提供者专用推理控制或远端 MCP/策略安装。上游免费层可能以 `FreeTierError` 拒绝请求；此适配器保留已记录的工具声明，不追加隐藏的兼容工具。免费层配额及 Console 余额由提供者管理。

**Runtime invariant:** 不发布配套检查器。凭据存储负责授权记录串行化；每个准备调用持有一个不可变的目录和凭据代次，没有独立的注册镜像。

组织管理的策略需要官方 OpenCode 客户端；声明策略的目录会被拒绝，不会被静默忽略。

### 开发备注

<details>
<summary>面向维护者的工作背景 — 点击展开</summary>

无。

</details>
