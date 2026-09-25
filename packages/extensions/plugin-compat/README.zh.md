---
description: "对本地 Claude Code 与 Codex 插件进行只读扫描，维护一个持久化的全局导入注册表，并对 skill（技能）、MCP、hook（钩子）的启用逐项设置同意门槛。"
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-compat

[English](README.md) | 中文

## 概述

该包扫描本地 Claude Code 或 Codex 插件目录而不执行其中任何内容，并维护一个持久化的全局注册表，记录用户显式导入过的插件。每一次导入、每一次对 skill、MCP 服务器或 hook 的启用都是一次明确的命令；发现阶段不会触发任何激活。skill 默认启用，而会启动本地命令或连接网络服务器的 MCP 服务器与 hook 默认禁用，需按名称显式启用。已启用且仍然有效的贡献会在新会话组合时，通过既有的 `dsh-skill`、`dsh-mcp-client`、`dsh-hooks-claude-code` 与 `dsh-hooks-codex` 能力挂载。

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

### 何时选择

挂载该服务,让用户可以把自己本地的 Claude Code 或 Codex 插件目录导入 fi,复用该插件的 skill、MCP 服务器声明与命令 hook,而不必手写等价的 `dsh-skill-filesystem` 根目录、`dsh-mcp-client` 配置行或 hook 配置。当部署方已经直接通过原生包管理自己的 skill、MCP 与 hook 组合时,可以跳过——本包只是新增了一条从另一工具的本地插件布局导入的路径。

### 启用插件与命令

这两行在 `dsh-base` 中都以 `disabled: true` 随附;需要一起用补丁启用:

```yaml
- id: plugin-compat
  name: '@deepseek-ai/dsh-plugin-compat'
  disabled: false
- id: plugin-compat-command
  name: '@deepseek-ai/dsh-plugin-compat/command'
  disabled: false
```

`Config` 接受 `home`(默认为 fi 主目录)以及扫描边界 `maxFiles`、`maxFileBytes`、`maxTotalBytes`、`maxEntries`,均为可按部署调整的单次扫描安全上限。

### 导入并启用一个插件

启用后,用户通过已注册的命令驱动每一次变更——发现阶段不会有任何自动动作:

- `/plugin-import <本地插件目录>`——扫描该目录(`.claude-plugin/plugin.json` 或 `.codex-plugin/plugin.json` 清单,或 Claude 的无清单 `skills/`、`hooks/hooks.json`、`.mcp.json` 布局),并以全局作用域记录它。skill 会被启用;MCP 服务器与 hook 不会。
- `/plugin-list`——列出已导入的插件、其组件以及任何诊断信息。
- `/plugin-enable <plugin id> [skill|mcp|hook:<item id>]` / `/plugin-disable ...`——启用或禁用整个插件或其中一个组件。
- `/plugin-remove <plugin id>`——移除该关联。

变更会在下一次会话组合时生效;`mountManagedPlugins` 从 `agent/created` 运行,因此已发布的 agent 会保留其既有组合。`PluginCompatService` 还直接暴露了 `list`/`importLocal`/`remove`/`setEnabled`/`resetOverride`,包括叠加在全局基线之上的工作区级选择,供未来的设置界面在不使用命令行的情况下直接驱动。

### 可观察的成功与失败

只有扫描有效时(所需清单存在且可解析、每个路径都保持在插件根目录内、每个发现的 MCP 服务器与 hook 都是受支持的形态之一),`/plugin-import` 才会成功;否则它会报告拒绝原因并不导入任何内容。激活时会重新扫描插件根目录,并拒绝挂载指纹与导入时不一致的插件,因此被编辑或删除的插件会明确失败,报出「请重新导入」的错误,而不会挂载过期或部分内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计理念

`src/manifest.ts` 是一个只读扫描器:它从不启动进程、执行脚本或打开 MCP 连接。它读取的每个文件都要通过针对插件根目录的词法与 `realpath` 包含检查(因此符号链接无法把它带出根目录之外),并以 `O_NOFOLLOW` 打开后按 inode 比对,才会计入配置的文件数、单文件字节数、总字节数与目录项数上限。它解析 skill frontmatter,依据一份明确的允许字段列表校验 MCP 的 `stdio`/HTTP 条目,并校验受支持的命令型 hook 子集,把每一个不受支持的事件、hook 类型或字段都记录为诊断信息,而不是悄悄丢弃。扫描结果携带一份基于每个发现文件确切字节内容的 SHA-256 指纹。

`PluginCompatService`(`src/index.ts`)在 `<dshHome>/plugin-compat.json` 处维护一份带版本号的 JSON 文档(全局插件,以及工作区级插件与覆盖项),通过 `dsh-atomic-write` 的文件锁与原子重命名写入。每次变更都通过一个内部队列序列化,并携带一个乐观并发修订号。`resolveForWorkspace()`(由 `agent/created` 调用)会重新扫描每个已启用的插件,并要求其指纹仍与导入时一致,才会把它返回用于挂载。

`src/runtime.ts` 把每个已解析、已启用、扫描器支持的贡献,作为子插件挂载到组合该会话的 agent 自身的 `agent.ctx` 上(因此会随该 agent 一起卸载):skill 贡献直接调用 `ctx.skills.register()`;MCP 服务器以转换后的 `StdioConfig`/`StreamableHttpConfig` 挂载 `dsh-mcp-client`;hook 贡献会生成一份私有的、权限为 `0o600` 的临时 `hooks.json`(随释放而清理),并挂载指向它的 `dsh-hooks-claude-code` 或 `dsh-hooks-codex`——与未经修改的部署已经使用的原生 bridge 相同。

`src/command.ts` 是本次变更中唯一提供的同意界面:五个调用该服务(全局作用域)的 `dsh-commands` 注册。本次变更未随附设置界面(参见[已知限制](#known-limitations-and-deferred-work))。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/manifest.ts`](src/manifest.ts) | 有边界的只读扫描器:发现、包含检查、校验、诊断、指纹 |
| [`src/index.ts`](src/index.ts) | `PluginCompatService`:持久化文档、变更队列与 `agent/created` 激活 |
| [`src/runtime.ts`](src/runtime.ts) | 把已解析的 skill、MCP 服务器与 hook 挂载到某个 agent 的作用域上下文 |
| [`src/command.ts`](src/command.ts) | `/plugin-import`、`/plugin-list`、`/plugin-enable`、`/plugin-disable`、`/plugin-remove` |
| [`src/types.ts`](src/types.ts) | 公共记录类型:`ManagedPlugin`、`ManagedPluginItem`、作用域与目标类型 |
| — | 不发布运行时不变式伴生入口:持久化文档的 `zod` schema 与每次激活时的指纹重校验,已经覆盖了本包能报告的每一个可能出现分歧的观测点,单独的伴生入口只会重复包装已有检查。 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Extensions 分组](../README.zh.md)——包的归属与子系统链接。
- [skill 提供方接缝](../../skill/skill/README.zh.md)与[文件系统 skill 提供方](../../skill/skill-filesystem/README.zh.md)——某个 skill 贡献会注册到的注册表。
- [MCP 客户端 bridge](../../mcp/mcp-client/README.zh.md)——转换后的 MCP 服务器配置会挂载到的接缝。
- [Claude Code hook bridge](../../hooks/hooks-claude-code/README.zh.md)与[Codex hook bridge](../../hooks/hooks-codex/README.zh.md)——生成的 `hooks.json` 会挂载到的 bridge。
- [Agent Note:本地 Claude 与 Codex 插件兼容性扫描](../../../.agents/notes/implemented/feature/2026-09-25-local-plugin-compatibility-scan.zh.md)——扫描器决策与被否决的替代方案。

-----

<a id="model-experience"></a>
## 模型体验

通过 `dsh-skill`、`dsh-mcp-client`、`dsh-hooks-claude-code` 与 `dsh-hooks-codex` 间接影响模型;已启用贡献的所有模型可见渲染均由这些包负责。

#### KV Cache 影响

在导入插件并启用某个组件之前没有任何影响。挂载之后,已启用的 skill、MCP 工具或 hook 会遵循渲染它的那个包已记录的 KV Cache 行为。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制说明本包不做什么。它们是当前包约束,不是任务积压。

- **没有设置界面。**`/plugin-import`、`/plugin-list`、`/plugin-enable`、`/plugin-disable`、`/plugin-remove` 是本次变更中唯一提供的同意界面。`PluginCompatService` 的公共方法,包括工作区级选择,已经就位,供未来的浏览器设置卡片直接驱动。
- **仅支持本地根目录。** market 市场下载与安装留在本包之外;请导入已经存在于磁盘上的插件。
- **指纹覆盖已发现的文件,而非其行为。** 它对扫描发现的每一份清单、skill、资源、MCP 与 hook 配置文件取哈希,但 hook 命令自身的脚本,以及它在运行时加载的任何依赖,都在指纹范围之外,也在本包的执行完整性保证之外。
- **不受支持的组件保持可见,但永不激活。** 扫描器无法识别的 skill 字段、hook 事件、hook 类型或清单键会被记录为诊断信息且无法启用;没有覆盖开关。
- **SessionStart hook 的时机遵循原生 bridge。** 导入的 `SessionStart` hook 可能错过第一次请求,与[Claude](../../hooks/hooks-claude-code/README.zh.md)和[Codex](../../hooks/hooks-codex/README.zh.md)hook bridge 的约定一致。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本包负责兼容性扫描、持久化导入注册表以及按 agent 的激活。它不负责作用域持久化界面,也不负责 `agent/created` 挂载之外的 agent 组合——呈现最终快照的设置界面是未来的工作。

</details>
