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

Copilot 凭据保留在 `llm-pi-ai/github-copilot`。其他凭据分别存储于 `fi-subscriptions/cursor`、`fi-subscriptions/kiro`、`fi-subscriptions/cline` 和 `fi-subscriptions/gemini-cli`。Cursor 使用浏览器批准及 PKCE 轮询，并在到期前五分钟通过 Cursor 的 OAuth 授权刷新访问令牌；没有刷新令牌或被 Cursor 撤销的授权需要重新登录。Kiro 使用 AWS 设备批准和串行 OIDC 刷新。Cline 接受 Free/Pass 账户页面生成的 API 密钥，并通过模型目录验证。Google 使用 PKCE、校验 state 的本地回调、刷新令牌和 Code Assist 项目资格检查。取消保留原有凭据。FI 不导入其他应用的凭据，也不运行代理进程。

`providers` 仅接受包括 `copilot` 在内的五个规范 ID。原生 `copilot` 路由与 pi-ai 的 `github-copilot` 目录条目独立；两者使用已有 GitHub OAuth 记录。每个 profile 接受 `displayName` 和所选 `models`；省略时展示所有公布模型，空数组隐藏选择器模型。发现忽略选择过滤。`kiroRegion` 选择 AWS 端点。账户需要 Cloud 项目时，由 `geminiProjectId` 提供；`geminiClientId`、`geminiClientSecret` 和 `geminiCallbackPort` 配置安装式应用 OAuth。必须显式配置两个 Google 客户端值；缺失值会在打开回调监听器前拒绝授权，并在网络访问前拒绝令牌刷新。

`requestTimeoutMs`、`streamIdleTimeoutMs`、`authTimeoutMs`、`pollIntervalMs` 和 `refreshMarginMs` 控制截止时间与刷新。目录未提供容量时，`defaultContextWindow` 和 `defaultMaxTokens` 提供保守默认值。准备后的调用固定使用同一账户及配置版本。认证端点拒绝重定向。移除登录只删除 FI 本地凭据；提供方撤销需单独完成。

失败响应的 `Retry-After` 会作为提供方延迟传给重试策略，因此超出策略最大延迟的重置时间不会被重试。Kiro 的 `MONTHLY_REQUEST_COUNT`（429 或 402）和 Copilot 配额失败（402 或配额错误码）会变成 429，其延迟为真实的重置时间：先取已耗尽的配额窗口，再取账户重置日期，最后取下一个 UTC 月初。Copilot 隐藏策略为 `disabled` 的模型；`model_picker_enabled` 被忽略，因为 Free 账户会对所有模型报告 false。

Kiro 发现会在同一次 `requestTimeoutMs` 截止时间内遍历所有 `nextToken` 页面，保持账户和 profile 不变，并去除重复模型 ID。无效页面或重复令牌会使发现失败，而不会返回不完整目录。

模型选择器在每次刷新时为每个提供方获取一次目录。单个模型的元数据使用配置的容量，不再请求凭据或目录。准备生成请求时，仍会根据当前账户目录验证所选模型。

<a id="protocol-sources"></a>
## 协议来源

原生协议改编自本地 auth2api 仓库 `f01e399` 及其截至 2026-11-01 的未提交工作树。Cursor 和 Kiro 的线路协议参考 decolua/9router，Cursor 浏览器授权参考 kaitranntt/CLIProxyAPIPlus。Cursor 令牌刷新参考 PaceBar 提供方说明和 eisbaw/cursor_api_demo（由 auth2api 引用）；Kiro 客户端标识参考 Kiro 更新源和 kaitranntt/CLIProxyAPIPlus；Copilot 客户端标识参考 microsoft/vscode 1.144.0 发行版。Cursor 使用 HTTP/2 Connect protobuf；Kiro 使用 CRC 校验的 AWS 事件流；Cline 使用 OpenAI 兼容聊天及真实 FI 客户端头；Code Assist 复用 FI 的 Gemini 消息和 SSE 编解码器，但使用自身 Google 端点及项目封装。[NOTICE](NOTICE.md) 保留组件归属与分发限制。

所呈现的客户端版本是协议常量：Cursor 3.27.22、Kiro 1.4.62，以及 VS Code 1.144.0 搭配 Copilot Chat 0.72.0。Copilot、Kiro 和 Cursor 的会话与机器标识由已登录账户派生。

Cline 发送调用方的 `maxTokens`，省略时使用 `defaultMaxTokens`，不会按回退上下文估算缩减。其公布的目录不含上下文容量；上游提供方校验实际上下文和输出限制。

<a id="model-experience"></a>
## 模型体验

### 订阅请求

#### 模型看到的内容

模型接收已记录的 `GenerateOptions.system` 提示、对话和函数工具。Kiro 的 Claude 和 `auto` 模型接受推理强度，Kiro 将其作为思考预算接收（minimal 为 1,024 个 token，xhigh 和 max 为 32,000 个）；其推理以推理块返回。Cursor 协议握手公布这些工具；原生 shell 请求被拒绝，不会绕过 FI 执行。工具结果通过常规会话记录重放。授权令牌不会进入模型输入。

#### Token 影响

Cursor 在启动原生运行时序列化已记录的历史，随后在同一流中以原生 MCP 结果发送工具输出。Cursor 和 Kiro 使用本地 BPE 预算限制文本、推理和完整工具调用，因为两种协议都没有输出限制字段；它不是提供方的计费 tokenizer。离线 `o200k_base` tokenizer 与其 MIT 许可证一起打包为私有延迟加载模块；无限额调用和其他提供方不会加载它。其他传输转发输出限制。提供方返回用量时予以保留：Cursor 的轮次总量及缓存和推理明细，以及 Kiro 的 token 用量和积分。

#### KV Cache 影响

对话顺序遵循 pi-ai 重放转换。Cline 推理通过其文档规定的 `X-Task-ID` 跟踪头发送持久化会话 ID；没有会话的直接调用省略此头。Cursor 仅在等待工具结果时保留原生流，期限由 `streamIdleTimeoutMs` 限定。同一步骤的并行调用一起返回，并以任意顺序一起回答。继续运行必须匹配账户、模型、工具和此前记录；每个待处理调用只能消费一次。每个账户使用一个 HTTP/2 会话承载其运行；该会话不会在账户之间共享，并随插件关闭。过期或不匹配的继续请求会失败，不会重复工具。插件销毁会关闭保留的流。重启后不保留服务器 checkpoint。账户头和协议握手不添加会话消息。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

缺少 Google OAuth 客户端配置只会阻止 Google 授权和令牌刷新；其他订阅提供方仍然可用。

- 仅暴露文本输入和函数工具；图像和文档不会转发。不支持停止序列覆盖，推理强度只有 Kiro 的 Claude 和 `auto` 模型接受；Cursor 还拒绝协议无法表达的采样控制，Kiro 接受 `temperature` 和 `top_p` 但不产生效果。目录存在不保证配额或资格。Copilot 仅列出 chat-completions 模型。重启或过期后不能继续待处理的 Cursor 结果。仅限 Cline 产品界面的模型仍不能被外部客户端使用。Google 可能以 `UNSUPPORTED_CLIENT` 拒绝消费者账户；仅有 Cloud 项目并不提供 Code Assist 许可，配额接口可能返回 `SUBSCRIPTION_REQUIRED`。免费层注册省略配置的项目元数据。

**运行时不变量：** 不发布 companion。凭据存储串行处理自身变更，准备后的请求保留其账户，不维护独立身份镜像。

### 开发备注

无。
