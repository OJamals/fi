---
description: "Cursor、Kiro、Cline Free/Pass 与 Gemini Code Assist 的原生授权和推理。"
kind: "package-reference"
---

# @fi/llm-subscriptions

[English](README.md) | 中文

## 概述

此私有插件通过原生账户协议连接 Cursor、Kiro、Cline Free/Pass 和 Google Code Assist。设置 → 模型提供授权流程；登录成功后创建对应提供方路由。GitHub Copilot 保留 pi-ai 设备登录和令牌刷新；本插件提供其实时聊天目录和推理。

## 目录

- [授权与配置](#authorization-and-configuration)
- [协议来源](#protocol-sources)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="authorization-and-configuration"></a>
## 授权与配置

Copilot 凭据保留在 `llm-pi-ai/github-copilot`。其他凭据分别存储于 `fi-subscriptions/cursor`、`fi-subscriptions/kiro`、`fi-subscriptions/cline` 和 `fi-subscriptions/gemini-cli`。Cursor 使用浏览器批准及 PKCE 轮询，授权过期后需要重新登录。Kiro 使用 AWS 设备批准和串行 OIDC 刷新。Cline 接受 Free/Pass 账户页面生成的 API 密钥，并通过模型目录验证。Google 使用 PKCE、校验 state 的本地回调、刷新令牌和 Code Assist 项目资格检查。取消保留原有凭据。FI 不导入其他应用的凭据，也不运行代理进程。

`providers` 仅接受包括 `copilot` 在内的五个规范 ID。原生 `copilot` 路由与 pi-ai 的 `github-copilot` 目录条目独立；两者使用已有 GitHub OAuth 记录。每个 profile 接受 `displayName` 和所选 `models`；省略时展示所有公布模型，空数组隐藏选择器模型。发现忽略选择过滤。`kiroRegion` 选择 AWS 端点。账户需要 Cloud 项目时，由 `geminiProjectId` 提供；`geminiClientId`、`geminiClientSecret` 和 `geminiCallbackPort` 配置安装式应用 OAuth。必须显式配置两个 Google 客户端值；缺失值会在打开回调监听器前拒绝授权，并在网络访问前拒绝令牌刷新。

`requestTimeoutMs`、`streamIdleTimeoutMs`、`authTimeoutMs`、`pollIntervalMs` 和 `refreshMarginMs` 控制截止时间与刷新。目录未提供容量时，`defaultContextWindow` 和 `defaultMaxTokens` 提供保守默认值。准备后的调用固定使用同一账户及配置版本。认证端点拒绝重定向。移除登录只删除 FI 本地凭据；提供方撤销需单独完成。

Kiro 发现会在同一次 `requestTimeoutMs` 截止时间内遍历所有 `nextToken` 页面，保持账户和 profile 不变，并去除重复模型 ID。无效页面或重复令牌会使发现失败，而不会返回不完整目录。

<a id="protocol-sources"></a>
## 协议来源

原生编解码器依据 auth2api 修订 `05e9e0a68a6e952044fd2c03186722577c6de37a`。Cursor 使用 HTTP/2 Connect protobuf；Kiro 使用 CRC 校验的 AWS 事件流；Cline 使用 OpenAI 兼容聊天及真实 FI 客户端头；Code Assist 复用 FI 的 Gemini 消息和 SSE 编解码器，但使用自身 Google 端点及项目封装。[NOTICE](NOTICE.md) 保留组件归属与分发限制。

<a id="model-experience"></a>
## 模型体验

### 订阅请求

#### 模型看到的内容

模型接收已记录的 `GenerateOptions.system` 提示、对话和函数工具。Cursor 协议握手公布这些工具；原生 shell 请求被拒绝，不会绕过 FI 执行。工具结果通过常规会话记录重放。授权令牌不会进入模型输入。

#### Token 影响

Cursor 在启动原生运行时序列化已记录的历史，随后在同一流中以原生 MCP 结果发送工具输出。它使用本地 BPE 预算限制文本、推理和完整工具调用；它不是提供方的计费 tokenizer。离线 `o200k_base` tokenizer 与其 MIT 许可证一起打包为私有延迟加载模块；无限额调用和其他提供方不会加载它。其他传输转发输出限制。提供方返回用量时予以保留。

#### KV Cache 影响

对话顺序遵循 pi-ai 重放转换。Cline 推理通过其文档规定的 `X-Task-ID` 跟踪头发送持久化会话 ID；没有会话的直接调用省略此头。Cursor 仅在等待工具结果时保留原生流，期限由 `streamIdleTimeoutMs` 限定。继续运行必须匹配账户、模型、工具和此前记录；每个待处理调用只能消费一次。过期或不匹配的继续请求会失败，不会重复工具。插件销毁会关闭保留的流。重启后不保留服务器 checkpoint。账户头和协议握手不添加会话消息。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

缺少 Google OAuth 客户端配置只会阻止 Google 授权和令牌刷新；其他订阅提供方仍然可用。

- 仅暴露文本输入和函数工具。不支持推理强度和停止序列覆盖；Cursor 还拒绝协议无法表达的采样控制。目录存在不保证配额或资格。Copilot 仅列出 chat-completions 模型。Cursor 按顺序暴露原生工具调用；重启或过期后不能继续待处理的结果。仅限 Cline 产品界面的模型仍不能被外部客户端使用。Google 可能以 `UNSUPPORTED_CLIENT` 拒绝消费者账户；仅有 Cloud 项目并不提供 Code Assist 许可，配额接口可能返回 `SUBSCRIPTION_REQUIRED`。免费层注册省略配置的项目元数据。受支持的 Cursor 浏览器流程不提供刷新。

**运行时不变量：** 不发布 companion。凭据存储串行处理自身变更，准备后的请求保留其账户，不维护独立身份镜像。

### 开发备注

无。
