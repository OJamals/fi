---
description: "Host 与 Client 工作区控制：修改工作区导航、跟随其完整投影，并可选地把工作区的编码会话隔离到应用管理的本地 Git worktree 中。"
kind: "package-reference"
---
# Workspace Controller

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-api-workspace-controller` 拥有 Host 的 `ctx.workspaceController` 服务和生成的 Client `ctx.remote.workspace` namespace。它的 Remote 方法负责创建、重命名、移除和重排 Workspace，在 Workspace 内重排 Session，归档与取消归档 Session，以及跟随完整的 Workspace 投影。当 Client 必须修改或跟随 Workspace 导航时，请通过 API 网关使用它。本包同时拥有 `ctx.directoryPickerController` 与生成的 `ctx.remote.directoryPicker` namespace，因为它承载的选目录 seam 是抽象的，自身从不作为 Loader entry。

## 目录

- [使用本包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Host 控制器会串行执行正确性取决于当前注册表状态的变更，并为预期失败抛出带有稳定错误码的 `RemoteError`。它的 `follow()` 流会同步订阅持久 Workspace 变更，先发出一份完整 baseline，再按顺序发出 `upsert`、`remove`、`order`、`archived` 和 `pinned` 增量。归档与置顶集合都是会话 id 数组，置顶数组把最近置顶的 id 放在前面。重连会以替换 baseline 开始新一代，因此消费方不依赖收到断线期间的每个增量。不带 `stopActivity` 的 `archiveSession` 会以 `workspace/session-active` 拒绝仍有工作在跑的会话，其 details 按族（`turn`、`subagent`、`job`、`schedule`）列出这些工作及各项的 id 与名称；带 `stopActivity: true` 时注册表的提供方先停止这些工作，归档集合持久化后即返回响应，停止在后台收敛。

Client 入口提供 `ClientWorkspaceModel` 和 `createWorkspaceStateStream()`。该模型拥有 Workspace 行、registry 顺序、归档与置顶会话身份、一元变更回显，以及流与一元调用的竞态处理。较新的 Host 行按 `updatedAt` 获胜；已提交的流顺序优先于较旧的一元响应；已经移除的 Workspace id 不会被延迟数据复活。置顶快照仅在会话身份或顺序变化时更新。该包公开与框架无关的快照和订阅，把导航策略与 React 钩子留给 UI owner。`WorkspaceController.archiveSession(sessionId, { stopActivity })` 抛出携带 Host `rpcError` 的 `WorkspaceArchiveError`，界面因此能区分"仍有工作在跑"的拒绝与会话缺失或载体故障，并提议停止这些工作。

<a id="first-use-workspace"></a>
### 首次使用工作区

`workspace.initializeDefault()` 返回持久化的默认工作区；Client service 通过 `workspaces.initializeDefault(signal?)` 提供该操作。它不接受请求参数：固定目录名 `default-workspace` 由 Host 拥有，注册表也以同一路径片段作为初始标题，因此任何语言下同一安装环境都只有一个磁盘路径和一个存储标题。Host 将目录放在其账户的 `<Documents>/deepseek-harness` 下，远程 Web Host 也遵循此规则。操作系统的文件名限制同样适用。Linux 系统查询要求存在 `xdg-user-dir` 且启用了 Documents 目录；不具备该条件的 Host 必须配置 `documentsDirectory` 或使用文件夹选择器。

[Workspace 注册表](../../workspace/workspace/README.zh.md#first-use-workspace)负责资格判断、目录创建和持久化初始化。已有默认工作区直接返回，不再查询 Documents，也不会被重命名或迁移。不满足首次使用条件时返回 `undefined`，启动流程可将目录选择留给用户。查询和创建失败遵循标准 Remote 错误处理。初始化不创建 Session，也不发送消息。

`./default-workspace` 为浏览器消费方导出 `DEFAULT_WORKSPACE_DIRECTORY` 与 `workspaceDisplayTitle(title, localizedDefault)`：仍保留自动标题的工作区按读者语言显示默认名称，其他标题一律原样显示。被用户重命名为 `default-workspace` 的工作区，或从选择器采用的同名文件夹，也会按默认工作区显示；除显示之外没有其他行为依赖该判断。

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `documentsDirectory` | 系统 Documents 目录 | 完全限定的 Host 目录覆盖值 |
| `documentsLookupTimeoutMs` | `10000` | 操作系统目录查询的正数最大时长，单位为毫秒 |

Documents 查询占用注册表变更队列，因此其他 Workspace 变更（包括登记已选目录）最多可能等待 `documentsLookupTimeoutMs`。取消可以停止查询；解析成功后，取消不会回滚创建或登记。

<a id="managed-worktrees"></a>
### 应用管理的 worktree

配置 `managedWorktrees` 后，Client 可以把一次编码会话隔离到它自己的本地 Git checkout 中，而不是直接在工作区自己的目录里运行：

```yaml
- name: '@deepseek-ai/dsh-api-workspace-controller'
  config:
    managedWorktrees:
      managedWorktreeDirectory: !!js dshHomePath('worktrees')
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `managedWorktreeDirectory` | ——（必填） | 位于每个源仓库之外、保存 checkout 及其归属记录的绝对目录 |
| `gitTimeoutMs` | `30000` | 单条 git 命令允许运行的毫秒数，超时则中止 |
| `gitGraceMs` | `2000` | 被终止的 git 进程退出前的宽限毫秒数，超时则杀死 |
| `maxOutputBytes` | `8388608` | 每次读取保留的 git 输出字节数，以及一份归属清单的字节数 |

未配置 `managedWorktrees` 时，`createIsolated`、`inspectManaged` 与 `removeManaged` 均以 `workspace/managed-unavailable` 拒绝；此外该特性不增加任何组合要求，其他 Workspace 与 Session 行为均不变。

`createIsolated({ workspaceId })` 会在该工作区的目录——必须是带有已提交 HEAD 的本地仓库根目录——上创建一个新分支的全新本地 Git worktree，仅从源的已提交 HEAD 出发：源目录里未提交、已暂存、被忽略和未跟踪的文件永远不会被复制。新的 checkout 会通过与其他工作区完全相同的 `WorkspaceRegistry.create` 注册为普通工作区，因此 Session cwd、工具执行、搜索与 Git 检查保留其既有的单一权威；运行在受管 checkout 中的 Session 不会被特殊对待。`inspectManaged({ workspaceId })` 对该特性创建的工作区报告 `{ kind: 'managed', source, branch }`，对其余每个工作区——包括该特性未配置时的每一个——报告 `{ kind: 'ordinary' }`。`removeManaged({ workspaceId })` 会一并删除该 checkout 及其工作区登记：只要该工作区的任一 Session 通过 [`dsh-workspace`](../../workspace/workspace/README.zh.md) 声明的 `workspace/session-activity` waterfall——`archiveSession` 所用的同一接缝——报告仍有工作在跑，就以 `workspace/worktree-active` 拒绝；只要该 checkout 存在未提交、未跟踪或被忽略的内容，或存在尚未可从源的当前 HEAD 到达的提交，就以 `workspace/worktree-dirty` 拒绝。被移除 checkout 的分支、其源仓库与每条 Session 日志均保持不变；cwd 曾是该已移除 checkout 的 Session 无法在那里继续。

一个 checkout 的应用归属由其自身的路径形态与紧邻（而非位于内部）它的一份清单解析得到，而绝不来自调用方提供的身份：客户端无法通过构造请求把某个工作区冒充为受管，也无法伪造其记录的 source 或 branch。[`ManagedWorktrees`](src/managed-worktrees.ts) 拥有这一解析逻辑，以及创建与移除所经过的、受限的 git 执行——hooks、文件系统监视器，以及（对 `status` 与 `worktree` 命令）每个内容过滤器均被禁用。

-----

<a id="model-experience"></a>
## 模型体验

无，因为 Workspace 组织属于浏览器和 Host 的控制状态，并且不注册提示词、工具或会话事件。

#### KV Cache 影响

无直接影响；Workspace 变更不会改变模型请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- `follow()` 在重连后替换完整投影，不提供持久 cursor 或增量追赶协议。
- 进程内删除标记只会在 Client 模型生命周期内阻止延迟数据复活已移除的 Workspace。
- 应用管理的 worktree 需要本地的 `fs` 与 `subprocess` 执行环境；远程或沙箱化的执行环境即使配置了 `managedWorktrees` 也会让 `createIsolated` 与 `removeManaged` 不可用。
- 活跃度检查与移除并非同一个原子步骤：在 waterfall 给出答复与 `git worktree remove` 之间开始的一轮不会被追溯拒绝，实际受该步骤延迟所限。
- `removeManaged` 一旦通过安全检查就会无条件删除该 checkout；没有软删除或回收站，`git worktree remove` 返回后被移除 checkout 的文件即已消失。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。Workspace 注册表负责持久化，每次流生成都是完整投影。
