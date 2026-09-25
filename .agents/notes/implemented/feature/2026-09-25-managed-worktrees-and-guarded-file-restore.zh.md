# Agent Note: 应用管理的 worktree 与受限文件恢复

Status: implemented

[English](2026-09-25-managed-worktrees-and-guarded-file-restore.md) | 中文

## Problem

直接在工作区自身目录中运行的编码会话，会在用户审阅之前就改动用户的 checkout：既没有隔离，也没有办法在不依赖用户自己的 `git` 熟练度的前提下撤销某一轮对某个文件所做的编辑。一条更早、已分叉的 GUI 分支（`codex/model-universal`，此后已被现行架构取代）把两种能力一起构建：应用管理的本地 Git worktree，以及在其中围绕每次工具调用捕获的、精确到字节的"文件检查点"，后者带有一套与该分支自身"逐轮改动文件"特性互相独立的、内容寻址的 blob 存储（`file-checkpoints.ts`、`checkpoint-storage.ts`），全部直接写在该分支自己的 `workspace-controller` 包内。那条分支的架构此后已在 `main` 上被取代：`main` 已经有了 `dsh-workspace-changes`，它已经在每一轮的开始与结束时对 git 工作树做快照（外加围绕文件工具编辑的整文件捕获），供改动文件卡片使用；也已经有了 `dsh-workspace`/`dsh-api-workspace-controller`，它们已经拥有工作区的登记、导航，以及 `workspace/session-activity` 活跃度检查接缝。若逐字移植旧分支的文件检查点部分，将会在已有的一套机制之外再装上第二套完整的 worktree 内容快照机制，通过一条独立的代码路径捕获重叠的内容。

## Decision

**应用管理的 worktree** 是 `dsh-api-workspace-controller` 上的新能力，通过可选的 `managedWorktrees` 配置块开启。[`ManagedWorktrees`](../../../../packages/api/workspace-controller/src/managed-worktrees.ts) 会在某个已登记工作区的目录——必须是带有已提交 HEAD 的本地仓库根目录——上创建一个本地 Git worktree，使用一个全新分支，仅从该 HEAD 出发；源目录中未提交、已暂存和未跟踪的文件永远不会被复制。新的 checkout 会通过与其他工作区完全相同的 `WorkspaceRegistry.create` 注册为普通工作区，因此 Session cwd、工具执行、搜索与 Git 检查保留其既有的单一权威，现有的工作区侧栏、排序与归档界面无需任何单独的浏览器即可呈现该 checkout。一个 checkout 的应用归属由其自身的路径形态（配置的 `managedWorktreeDirectory` 下的 `<uuid>/files`）加上紧邻（而非位于内部）它的一份清单解析得到——因此 `git worktree remove` 删除该 checkout 永远不会删掉这份记录——并且绝不来自调用方提供的身份，因此客户端无法通过构造请求来伪造受管状态。`removeManaged` 会在该工作区任一 Session 通过 `dsh-workspace` 已经声明的 `workspace/session-activity` waterfall（`archiveSession` 所用的同一接缝，如今被复用而非再写一套只覆盖 agent 与 job 的、更窄的检查）报告仍有工作在跑时拒绝，也会在该 checkout 存在未提交、未跟踪或被忽略的内容，或存在尚未可从源的当前 HEAD 到达的提交时拒绝——checkout 独有的内容永远不会被丢弃。用于创建、移除与查看 worktree 状态的 git 执行会禁用仓库 hooks、文件系统监视器，以及（对 `status`/`worktree` 命令）每个 clean/smudge/process 内容过滤器，因此一次快照或变更永远不会运行仓库自行配置的任意可执行内容。

**文件恢复** 扩展 `dsh-workspace-changes`，而不是新增第二套捕获机制。`WorkspaceChanges.restore(sessionId, seq, index, side, signal)` 把某个所列文件已经捕获的轮次开始（`'before'`）或轮次结束（`'after'`）内容写回其实际路径——该侧为缺失时则删除该路径——复用该包为改动文件卡片已经保留的那些快照树与整文件捕获，完全不做二次捕获。这次写入是受限的：它先读取实际文件，与*相对的另一侧*比较，除非实际内容完全匹配，否则以 `diverged` 拒绝，因此本摘要从未观察到的改动（更晚的一轮、手动保存、外部进程）永远不会被静默丢弃。二进制或超大的一侧按 `diff` 已经报告的同样方式拒绝。Web 路由 `POST /api/changes.restore` 以及现有改动文件卡片上的一个按钮暴露了这一能力；没有新增包，没有新增持久事件，也没有新增一次捕获过程。恢复并不限定于应用管理的 worktree：它写回的数据正是现有卡片在每个带仓库的会话中已经展示给用户的内容，把它限定在受管 worktree 内只会是一种没有对应安全依据的、纯产品层面的限制。

## Alternatives considered

**逐字移植旧分支那套精确到字节、按工具调用区间划分的检查点系统。** 它会围绕每一次顶层工具调用捕获完整的已跟踪加未跟踪文件集合（遵循 `.gitignore`），以 SHA-256 寻址的 blob 存储，独立于 `dsh-workspace-changes` 自身在轮次边界对同一内容所做的 git 树快照。在一个受管 worktree 会话内同时运行两者，意味着每次工具调用都要走两条互相独立、都对整个 worktree 内容做完整捕获的通道，并作为两套互不相关的系统维护下去。已否决：它会重复本仓库已经在发布和维护的快照基础设施，换来的只是本任务范围并不要求的粒度（按工具调用而非按轮次）。

**为应用管理的 worktree 单独建一套持久注册表包，模仿 `dsh-workspace` 的注册表/控制器拆分。** 已否决，因为把一个 checkout 注册为普通工作区已经让它获得其他工作区拥有的一切注册表行为（排序、归档、删除）；再建一套注册表会为同一个目录复制出这份状态，还需要协调两个真相来源。归属信息因此紧邻 checkout 存放为普通文件，与（已被取代的）旧分支当初的决定完全一致，因为那条已发布的先例依然成立：checkout 自身的路径是一个 `git worktree remove` 无法悄悄弄丢的事实。

**像旧分支那样，把移除时的活跃度检查硬编码为只查 Agent 与 job 注册表。** 已否决，因为 `dsh-workspace` 已经把"这个会话是否仍有工作在跑"这个确切问题抽象到了 `workspace/session-activity` waterfall 背后，其已发布的提供方还覆盖了硬编码的 agent-加-job 检查会漏掉的子代理和日程。复用现有接缝既省代码，覆盖面也严格更全。

**把 `restore` 限定于受管 worktree 的 Session，与旧分支的产品边界保持一致。** 已否决，因为旧分支的谨慎针对的是把用户*未提交*的源文件复制进新 checkout 这件事，而不是展示或撤销改动文件卡片本就已在每个会话中展示的内容。在普通工作区中，并不存在分歧检查尚未覆盖的额外风险。

## Consequences

一个受管 worktree 在除生命周期（创建与经过安全检查的移除）之外的每个方面都是一个普通工作区。移除一个会一并删除其登记与其 checkout 文件，但保留其分支与每条 Session 日志，因此历史永不丢失，而 cwd 曾是该已移除 checkout 的 Session 无法在那里继续。应用管理的 worktree 需要本地的 `fs` 与 `subprocess` 执行环境；远程或沙箱化的执行环境即使配置了该特性也会使其不可用。恢复不会与同一路径上进行中的轮次串行化——写入前的分歧检查让无声的覆盖不太可能发生，但并不能杜绝与并发工具编辑的竞争——它也不会追加会话事件或创建新的轮次记录，因此在后续轮次自己的快照运行之前，其卡片不会知道发生过恢复。本次改动未针对新增的 UI 界面记录 Web 浏览器快照或无密钥录制会话证据（当时没有可用的 API key，也没有可用的交互式浏览器会话）；`packages/api/workspace-controller/tests` 与 `packages/deliverables/workspace-changes/tests` 下的聚焦单元测试覆盖是本次改动所携带的验证，快照验证仍是遗留项。
