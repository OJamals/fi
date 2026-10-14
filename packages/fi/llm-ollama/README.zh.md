---
description: "Ollama Cloud 订阅登录、设备凭证和原生模型请求。"
kind: "package-reference"
---

# @fi/llm-ollama

[English](README.md) | 中文

## 概述

在设置 → 模型中使用现有账户和订阅登录 Ollama Cloud。FI 创建独立的 Ed25519 设备身份，显示 Ollama 授权页面，并且仅在 `/api/me` 确认账户后保存私钥。这是 Ollama 原生设备授权，不是 OAuth 2.0。无需 Ollama 守护进程、复制 API 密钥、回调端口或其他应用的凭证文件。

## 目录

- [授权与配置](#authorization-and-configuration)
- [协议来源](#protocol-sources)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="authorization-and-configuration"></a>
## 授权与配置

运行时 bundle 注册登录流程和提供方目录项。授权成功后保存 `fi-ollama/ollama-cloud`；授权控制器在 `fi-ollama` 设置中创建 `providers.ollama-cloud`。配置支持 `displayName` 和选中的 `models`。省略模型列表时列出所有公布的生成模型；空列表隐藏全部选择器模型。发现功能独立于选择。

`deviceName` 标识公钥授权请求。`authTimeoutMs`、`pollIntervalMs` 和 `requestTimeoutMs` 限制授权及轮询；取消或失败保留原有凭证。移除登录会删除 FI 本地凭证。要远程撤销，请在 Ollama 账户中撤销相应设备。私钥不会进入浏览器状态或推理请求体。

请求使用 Ollama 的 SSH 公钥编码和 Node 的 Ed25519 实现，对方法及带时间戳的请求 URI 签名。仅允许固定 HTTPS 云端账户、目录、模型信息及聊天补全端点，拒绝重定向。发现功能读取 `/api/tags`；准备请求时读取 `/api/show` 中的上下文容量和工具支持。仅在元数据缺少容量时使用 `defaultContextWindow`。`defaultMaxTokens` 限制输出，`streamIdleTimeoutMs` 限制停滞流。准备好的调用保留同一代凭证和配置。

<a id="protocol-sources"></a>
## 协议来源

推理 HTTP 401 报告 `CREDENTIAL_REVOKED` 并提示重新登录，而不是诊断 API 密钥无效。此诊断不复制提供方的错误响应体。

实现遵循 Ollama 的[设备授权 URL](https://github.com/ollama/ollama/blob/63b4f61ca926d382b9010e6e15aee93449eab2ac/app/auth/connect.go)、[Ed25519 授权头](https://github.com/ollama/ollama/blob/63b4f61ca926d382b9010e6e15aee93449eab2ac/auth/auth.go)、[云代理签名](https://github.com/ollama/ollama/blob/63b4f61ca926d382b9010e6e15aee93449eab2ac/server/cloud_proxy.go)和[账户客户端](https://github.com/ollama/ollama/blob/63b4f61ca926d382b9010e6e15aee93449eab2ac/api/client.go)。维护中的 pi-ai 转换负责 OpenAI 兼容消息和流式响应。

<a id="model-experience"></a>
## 模型体验

### 云模型请求和响应

#### 模型可见内容

模型通过 `GenerateOptions` 接收 FI 已记录的系统提示、对话和工具定义。未声明工具支持的模型拒绝带工具的调用。适配器通过现有会话事件投影文本、提供方返回的推理、工具调用、用量和结束原因。签名头不含模型可见内容。

#### Token 影响

连接器不添加提示或工具声明。Ollama 提供用量计数。上下文容量来自模型元数据或配置的回退值；输出限制来自请求或配置的默认值。

#### KV Cache 影响

有序对话重放使用现有 pi-ai 重放元数据。设备签名和时间戳是 HTTP 元数据，不改变已记录的模型输入。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 仅提供文本输入。不开放图像输入、原生搜索、推理强度覆盖或停止序列覆盖。云端可用性和订阅限制由 Ollama 决定；登录或目录发现成功不保证模型访问。本地删除凭证不会远程撤销设备。真实授权和推理需要 Ollama 账户。

**运行时不变量：** 不发布 companion。凭证存储拥有修改操作；准备好的调用捕获不可变身份和模型元数据，没有独立的注册镜像。

### 开发备注

无。
