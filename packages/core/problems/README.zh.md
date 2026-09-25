---
description: "供有界生产方与完整快照消费方使用的、按修订版本管理的 Workspace 诊断注册表。"
kind: "package-reference"
---

# @deepseek-ai/dsh-problems

[English](README.md) | 中文

## 概述

`dsh-problems` 是编码诊断的规范 Host 注册表。生产方在规范 Workspace 路径下原子替换一个来源的完整贡献；消费方检查或订阅分离且顺序确定的快照。只有可见内容变化时，修订版本才递增。

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

在 Host 上挂载一次插件，然后使用生产方当前的完整贡献调用 `ctx.problems.replace(workspaceRoot, source, problems)`。空替换会清除该来源。`inspect()` 返回当前完整快照；`subscribe()` 交付后续完整替换，并返回受 effect 作用域管理的 disposer。

每个调用方都必须提供文件系统提供方的规范 Workspace 进程路径。输入接受 `error`、`warning`、`info` 或 `hint`、Workspace 相对路径、从一开始的位置，以及可选的独占结束位置。无效输入或超过配置限制会在状态变更前失败；首次空替换或被拒绝的替换不会保留 Workspace 状态。

默认限制为每个 Workspace 32 个来源、每个来源 500 个问题、总计 2,000 个问题、16,384 个 UTF-8 消息字节、256 个来源/代码字节和 4,096 个路径字节。

默认不挂载任何生产方。本包以可用能力接缝的形式发布：未来的诊断生产方（lint 运行器、任务失败解析器、LSP 诊断转发）替换自己的来源，`dsh-tool-problems` 则读取当前已注册的所有来源。

<a id="understand-the-implementation"></a>
## 理解实现

进程本地服务为每个具有已接受可见状态的规范 Workspace 保存一个来源映射。替换会把完整贡献验证并复制到本地候选状态、比较规范化后的可见内容、一次提交，然后通知相互隔离的监听器。排序依次按严重性、路径、起始位置、来源、代码和消息。

<a id="further-exploration"></a>
## 进一步探索

- [Problems 工具](../tool-problems/README.zh.md)——有界模型检查。
- [LSP 能力接缝](../../lsp/lsp/README.zh.md)——未来诊断转发可以并列挂载的只读导航接缝。

<a id="model-experience"></a>
## 模型体验

无，因为此注册表不注册提示、工具 schema 或模型可见事件。

#### KV Cache 影响

此处不产生模型 token 或缓存条目。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- 状态为进程本地派生数据；重启后生产方必须重新发布。
- 生产方替换完整来源贡献；不支持增量诊断 delta。
- 目前没有随附包会替换来源；`problems` 呈现的每一条诊断都依赖部署方自行挂载生产方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
