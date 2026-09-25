# Agent Note: 共享的子进程宿主退出 listener

Status: implemented

[English](2026-09-25-shared-subprocess-host-exit-listener.md) | 中文

## 问题

每个 `LocalSubprocessRuntime` 实例都会安装自己的同步 Node `exit` listener（该机制由已归档的[同步宿主退出清理笔记](../../archived/bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.md)描述）。当宿主并发加载多个实例时——例如多个 subagent 或 workflow context——会接近 Node 默认 `process` `EventEmitter` 的 listener 数量上限，触发 `MaxListenersExceededWarning`，甚至更糟，静默丢弃被警告抑制的 listener。

## 决策

本地 subprocess 模块现在最多安装一个进程级 `exit` listener，即 `terminateManagedProcessesOnHostExit`，它向一个模块级的 `Set<() => void>` 中保存的各 runtime 最终清理器分派。每个 `LocalSubprocessRuntime` 仍在其 Cordis effect中注册自身的最终清理器闭包（`() => { this.terminateForHostExit() }`），共享 listener 仅在已注册最终清理器数量由零变为一时安装；runtime 仅在 `disposeManagedProcesses()` 结算后才移除自身最终清理器，与此变更之前移除自身私有 listener 的时机完全一致，共享 listener 仅在数量由一变为零时移除。这保留了既有的、刻意设计的保留行为：当 dispose 报告失败时，失败的 runtime 的最终清理器——以及只要仍有其他 runtime 保持注册，共享 listener 本身，或者在其他情况下该 runtime 对共享集合的贡献——将保持注册，以便之后真正的宿主退出仍能强制终止该 runtime 存活集合中残留的内容。

共享 dispatcher 分别包含每个 runtime 最终清理器的失败，这与 `terminateForHostExit()` 内部既有的逐 runtime 失败包含一致；一个 runtime 的失败绝不会阻止另一个 runtime 的最终清理器运行。

## 备选方案

- **提高 `process.setMaxListeners()` 的上限。** 否决：只是抬高上限，并未移除逐实例注册，而并发实例数量不受限（例如众多 subagent context）时仍可能超过任意固定上限。
- **将宿主退出所有权路由到 `LocalSubprocessRuntime` 之外的单例服务。** 否决：这会为一个内部 listener 新增一个 capability seam，而在既有包内使用模块级注册表已经足够，并能让修复保持局部化。

## 后果

并发的 `LocalSubprocessRuntime` 实例不再各自贡献一个 `process` `exit` listener；只要至少加载了一个实例，进程上就正好保留一个这样的 listener。已归档的同步宿主退出清理笔记中关于逐实例 listener 的描述现在仅具历史意义；本笔记是 listener 归属关系的当前权威记录。
