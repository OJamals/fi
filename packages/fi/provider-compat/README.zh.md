---
description: "面向 FI 维护者，提供 auth2api 规范元数据以及仅用于订阅的 Codex WebSocket、Claude 和 Grok HTTP 传输。"
kind: "package-reference"
---

# @fi/provider-compat

[English](README.md) | 中文

## 概述

`@fi/provider-compat` 让 FI 的四份提供方元数据、已捕获的线上指纹、OAuth 设置和发布来源与 auth2api 保持同步。它仅在 pi-ai 解析出已存储的订阅 OAuth 授权后应用 Codex、Claude Code 和 Grok CLI 请求头。显式 profile key、普通已存储 API key 以及环境 API key 仍使用正常端点。Grok 订阅推理使用 CLI Responses 端点；无关请求保持不变。

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

在 `@deepseek-ai/dsh-llm-pi-ai` 之后挂载本插件。Codex 默认使用优先尝试 WebSocket 的 `auto`；显式的 `sse`、`websocket` 和 `websocket-cached` profile 选项保留 pi-ai 的传输语义。可选配置 `websocketMaxPayloadBytes` 以正整数字节数限制每条接收的 WebSocket 消息；默认值为 104857600（100 MiB）。

```yaml
- - '@fi/provider-compat'
```

直接订阅 HTTP 客户端先调用 pi-ai 的 `Models.getAuth(provider)`，要求 `source === 'OAuth'`，并为本次请求冻结结果。`authorizationHeaders(auth)` 保留字符串值请求头，仅在授权头缺失时添加 `Authorization: Bearer <auth.apiKey>`。客户端随后调用 `subscriptionEndpoint(provider)` 和 `subscriptionHeaders(provider, model, sessionId, timeoutMs, existingHeaders)`；调用者绝不能记录该授权对象。对于 Anthropic，兼容请求头会在已捕获的 Claude Code beta 集合之外保留 pi-ai 按请求启用的 beta 功能，并把 `mid-conversation-output-config-2026-07-01` 映射为 Claude Code 的线上名称 `per-turn-control-2026-07-01`。

### Claude Code、Codex 与 Grok 的实时模型发现

本插件还会回答 `@deepseek-ai/dsh-llm-pi-ai` 面向其三条订阅路由（`anthropic`、`openai-codex`、`xai`）的可选 `llm-pi-ai/live-models` waterfall，因此已登录账户的新模型无需目录更新即可出现在 `listModels`、模型发现与采纳流程中。`liveModelDiscoveryEnabled`（默认 `true`）与 `liveModelDiscoveryCacheTtlMs`（默认 300000，即五分钟；接受 1,000–86,400,000）是本插件上的 `Config` 字段，因为抓取节奏是部署方的选择，不是常量。每个提供方都会以 `subscriptionHeaders` 为聊天请求已构建的同一身份被询问，只是指向该提供方自己的模型列表端点而非推理端点：

| 提供方 | 请求 | 保留内容 |
|---|---|---|
| `anthropic` | 带 Claude Code OAuth 请求头集合的 `GET https://api.anthropic.com/v1/models?limit=1000` | 以 `claude-` 开头的 `data[].id` |
| `openai-codex` | 带 Codex 账户请求头、`Accept: application/json`，以及复用上一次 ETag 的 `If-None-Match` 的 `GET {codexCli.baseUrl}{codexCli.modelsPath}?client_version={codexCli.version}` | `models[]` 中可用的 `slug`/`display_name`，丢弃 `visibility: "hide"` 的条目 |
| `xai` | 带 Grok CLI 请求头的 `GET {grokCode.cliBaseUrl}/models` | `data[].id` |

每次抓取都在 10 秒超时与受限响应体大小下运行，任一阶段的失败——网络、非 2xx、尚无缓存列表时收到 304、报文格式不正确——都会回退到上一次缓存的列表，或在从未成功抓取过时回退到空列表；调用方会把它原样并入已安装目录，因此一次故障永远不会破坏列表或请求。此处绝不记录已解析的令牌，也不进行任何后台轮询——只有当 `listModels`、发现或某次请求真正触达该路径时，才会检查（并在其 TTL 到期后刷新）每个提供方的缓存。

### 同步现有规范快照

导入命令接受显式来源，因此 FI 不依赖相邻 checkout 路径。

```sh
node scripts/fi-provider-settings-sync.mjs --updater ../auth2api/tools/update-provider-settings.mjs --settings ../auth2api/src/provider-settings.json
```

添加 `--check` 可执行只读新鲜度检查。该命令拒绝凭据字段、保留所有已接受的元数据，将 updater 逐字节复制到 `scripts/vendor/auth2api/`，并记录源仓库、commit、dirty baseline 状态与精确哈希。只有该路径会替换 vendored updater。

### 检查或应用公开发布更新

更新命令导入 auth2api 的 updater 模块，而不复制其发布逻辑。

```sh
node scripts/fi-provider-settings-update.mjs --check
```

移除 `--check` 可使用来源固定的 vendored updater 原子更新 FI 快照。每日运行的 [FI 提供方设置工作流](../../../.github/workflows/fi-provider-settings-update.yml) 会在公开元数据变化时创建或更新评审。新的公开版本不会推进 `fingerprintCapturedVersion`；新的脱敏捕获仍是独立的评审操作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

适配器解析一次权威 OAuth 结果，并冻结其 access token 用于发送。HTTP wrapper 在添加元数据或改写 Grok 端点之前检查最终 bearer 值。Codex 的请求级 WebSocket factory 在缓存查找之前验证并复制最终认证请求头，保留提供方 User-Agent、版本、originator、账户、beta、会话和请求标识符。Harness 归属使用独立请求头。

每个插件实例拥有一个稳定 connector。修补后的 pi-ai 缓存按端点、认证请求头、代理 URL 和 connector 标识分区，隔离连接与回退状态。凭据或元数据变化后不能复用原连接。默认 `auto` 与 `websocket-cached` 保留增量上下文复用；显式 `websocket` 发送完整上下文。网络握手失败保留 pi-ai 的已认证 SSE（Server-Sent Events）回退；认证或端点准备无效时，会在任一传输发送前失败。

受维护的 `ws` connector 使用 pi-ai 现有的 HTTP/HTTPS/ALL_PROXY 与 NO_PROXY 解析，包括提供方环境覆盖，并使用受维护的 HTTPS 代理 agent。它禁用重定向与压缩，执行配置的消息大小限制，并保留 SDK 连接超时和请求取消。插件 dispose（资源释放）只清理其 connector 的缓存与回退记录，终止待连接和已打开的 socket，并等待关闭。已发送的 HTTP 请求仍由调用者的请求 signal 管理。

[固定补丁记录](pi-ai-patch.pin.json) 记录 npm 版本、完整性值、原始 dist 文件哈希、补丁哈希与移除条件。补丁不向 pi-ai 添加 Node 导入，并保持未提供 factory 时的构造路径不变。生成的元数据与 vendored updater 仍是 auth2api 的字节稳定投影；发布更新绝不意味着新的指纹捕获。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`@deepseek-ai/dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.zh.md) —— 模型目录、认证和流式传输的所有者。
- [`@fi/llm-antigravity`](../llm-antigravity/README.zh.md) —— Antigravity 的原生适配器和 OAuth 流程。
- [提供方设置快照](src/provider-settings.json) —— 生成的元数据和发布来源。
- [Updater 来源记录](../../../scripts/vendor/auth2api/origin.json) —— 精确的 auth2api 来源与 vendored 字节哈希。
- [官方 Codex WebSocket 协议常量](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs) —— 规范记录中 WebSocket beta 的第一手来源。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包改变传输路由和提供方要求的请求头，但不添加模型可见输入。

#### KV Cache 影响

无，因为请求内容与模型参数不变。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- WebSocket 兼容性需要固定的 pi-ai 补丁和服务端 `ws` connector。不保证延迟或吞吐量改善；性能取决于网络和提供方。
- pi-ai 未通过公开运行时 API 暴露内置 OAuth scopes，因此自动 scope 漂移诊断可覆盖规范元数据，但无法比较 SDK 私有常量。
- 发布自动化更新公开发布字段和来源。需要捕获的运行时请求头会保留其记录版本，直到单独的指纹捕获通过评审并写入规范记录。
- 实时模型发现只会列出 `llm-pi-ai` 已经限定的范围：已存凭据解析为 `OAuth` 的完整目录路由（没有 `models` 列表）。环境或 API 密钥鉴权的路由，以及经过筛选的 `models` 列表，根本不会触达本插件的抓取逻辑——那道限制完全在 `@deepseek-ai/dsh-llm-pi-ai` 中，不在这里。
- 实时列表按提供方为整个插件实例缓存，而非按账户缓存；若某部署让多个账户共用同一提供方路由，看到的会是最近一次刷新的那个账户的列表，直到下一个 TTL 边界。

<a id="dev-note"></a>
### 开发备注

**Runtime invariant:** 不发布 companion，因为认证检查针对短暂的单次发送；SDK 拥有连接与缓存状态，插件则通过上下文生命周期释放其 connector 和 socket。
