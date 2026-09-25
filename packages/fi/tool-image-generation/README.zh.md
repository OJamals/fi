---
description: "通过已存储的 Codex、Grok 或 Antigravity 订阅 OAuth 选择性启用图像生成和编辑。"
kind: "package-reference"
---

# @fi/tool-image-generation

[English](README.md) | 中文

## 概述

使用本包可通过现有 Codex、Grok 或 Antigravity 订阅登录，从文本生成一张栅格图像或按顺序编辑工作区图像。部署会显式启用每个提供方和图像模型。调用绝不使用 API key 计费或回退到其他提供方；认证仅在工具运行时解析，因此未登录启动仍然安全。

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

在 FI profile 中挂载本插件，并配置至少一个显式目标和一个默认提供方。

### 何时选择本包

当部署存储订阅 OAuth 并需要模型可调用的文生图或工作区图像编辑时，请选择本包。当订阅 transport 不可用，或需要本工具未提供的厂商控制项时，请选择独立的 API key 图像提供方。

### 最小配置

```yaml
- name: '@fi/tool-image-generation'
  config:
    defaultProvider: codex
    targets:
      codex:
        imageModel: gpt-image-2
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `defaultProvider` | 必填 | 工具调用省略 `provider` 时使用的已配置提供方 |
| `targets` | 必填 | 将 `codex`、`grok` 或 `antigravity` 映射到显式 `imageModel` 的非空映射 |
| `timeoutMs` | `180000` | 整个操作的超时；1 至 600000 毫秒的整数 |
| `maxOutputBytes` | `33554432` | 生成图像的最大解码字节数；1 至 67108864 的整数 |

生成的[配置目录](../../../docs/config-catalog.zh.md#fitool-image-generation)是已接受字段及其 JSDoc 的完整来源。

`image_gen` 接受必填的非空 prompt、仅限已配置目标的可选提供方，以及可选且有序的 PNG、JPEG 或 WebP 工作区路径。Codex 和 Grok 接受一至五个引用；Antigravity 接受一至三个。本包会在访问文件系统、凭据或网络之前拒绝超量引用。它不发送 size 或 quality 字段，因此所选提供方保留其原生默认值。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部机制 — 点击展开</summary>

插件为 Codex 和 Grok 创建一个 pi-ai 凭据适配器，并使用 Antigravity 包的授权解析器和原生图像 transport。每次调用解析一个所选目标，通过执行环境文件系统读取已接受的引用，并在发送前通过 attachment 服务存储标准化输入。

响应读取器只接受一张 base64 图像，在分配前限制 JSON 与解码字节数，根据字节识别 PNG、JPEG 或 WebP，拒绝声明媒体类型不匹配的响应，并把完整栅格验证委托给 attachment 服务。成功结果包含安全 JSON 和一个持久 `ImageBlock`，且排除原始图像数据。HTTP 失败会保留状态但不保留响应正文；结果不明确的 POST 失败不会重试；插件卸载会中止并等待活动任务。

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置验证、凭据适配器和生命周期连接 |
| [`src/tool.ts`](src/tool.ts) | 工具 schema、文件系统投影、提供方选择和持久结果 |
| [`src/provider.ts`](src/provider.ts) | 订阅 transport、原生请求正文和有界响应解码 |
| [`src/raster.ts`](src/raster.ts) | 共享字节签名识别 |
| [`tests/expected/image-result.json`](tests/expected/image-result.json) | 模型可见值的包内 golden |
| — | 不发布 runtime invariant companion；被消费的服务拥有可变关系。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [`dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.zh.md) — 已存储的 Codex 和 Grok OAuth 解析。
- [`@fi/llm-antigravity`](../llm-antigravity/README.zh.md) — Antigravity 授权和原生 Gemini transport。
- [`dsh-attachment`](../../attachment/attachment/README.zh.md) — 持久图像引用和图像限制。
- [`dsh-fs`](../../fs/fs/README.zh.md) — 执行环境文件系统访问。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#fitool-image-generation) — 模型接收的准确 `image_gen` schema。

-----

<a id="model-experience"></a>
## 模型体验

### 图像生成工具

#### 模型看到的内容

生成的 [`image_gen` schema](../../../docs/tool-catalog.zh.md#fitool-image-generation)仅公开已配置的提供方。成功结果包含所选提供方与模型、标准输入和输出引用、可选的安全 generation id、简洁文本和一个持久输出图像。

#### Token 影响

插件可见时，工具 schema 会添加固定 token。每次调用会附加有界 JSON、简洁结果文本和一个图像 block；输入路径影响调用 token，提供方生成的栅格字节遵循所选适配器的图像 token 计量。

#### KV Cache 影响

已配置的提供方 enum 和默认提供方说明在一次插件挂载期间保持前缀稳定。配置变更会替换这些 schema token，而每次工具调用会在可复用前缀之后附加新的结果内容。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制避免本包声称它未提供的厂商控制项或 transport。

- Claude 没有受支持的栅格输出 transport。Claude 对话只能通过已配置的 Codex、Grok 或 Antigravity 目标调用本工具。
- 引用必须是可读的工作区图像。不支持 mask、不透明的提供方 file id 和远程结果 URL。
- 账户和模型可用性可能变化。缺失或非 OAuth 授权会在执行时失败。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
