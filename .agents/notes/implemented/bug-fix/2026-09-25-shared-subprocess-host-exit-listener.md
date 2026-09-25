# Agent Note: Shared subprocess host-exit listener

Status: implemented

English | [中文](2026-09-25-shared-subprocess-host-exit-listener.zh.md)

## Problem

Each `LocalSubprocessRuntime` instance installed its own synchronous Node `exit` listener (the mechanism described by the archived [synchronous host-exit cleanup note](../../archived/bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.md)). A host that concurrently loads many instances — for example, many subagent or workflow contexts — approaches Node's default `process` `EventEmitter` listener limit and emits `MaxListenersExceededWarning`, or worse, silently drops a warning-suppressed listener.

## Decision

The local subprocess module now installs at most one process-level `exit` listener, `terminateManagedProcessesOnHostExit`, dispatching to a module-level `Set<() => void>` of per-runtime finalizers. Each `LocalSubprocessRuntime` still registers its own finalizer closure (`() => { this.terminateForHostExit() }`) from its Cordis effect and the shared listener is installed only on the transition from zero to one registered finalizer; a runtime removes its own finalizer only after `disposeManagedProcesses()` resolves, exactly as it removed its private listener before this change, and the shared listener is removed only on the transition from one to zero. This preserves the existing, deliberate retention behavior: when disposal reports a failure, the failing runtime's finalizer — and therefore the shared listener while any other runtime is still registered, or the runtime's own contribution to the shared set otherwise — stays registered so a later real host exit can still force-terminate whatever remained in that runtime's live sets.

The shared dispatcher contains each per-runtime finalizer's failure independently, matching the existing per-runtime containment inside `terminateForHostExit()`; one runtime's failure never prevents another runtime's finalizer from running.

## Alternatives considered

- **Cap `process.setMaxListeners()` higher.** Rejected: it raises the ceiling but does not remove the per-instance registration, and an unbounded number of concurrent instances (many subagent contexts) can still exceed any fixed cap.
- **Route host-exit ownership through a singleton service outside `LocalSubprocessRuntime`.** Rejected: it would require a new capability seam for a single internal listener, when a module-level registry inside the existing package is sufficient and keeps the fix local.

## Consequences

Concurrent `LocalSubprocessRuntime` instances no longer contribute one `process` `exit` listener each; the process holds exactly one such listener whenever at least one instance is loaded. The archived synchronous host-exit cleanup note's per-instance-listener description is now historical; this note is the current authority for listener ownership.
