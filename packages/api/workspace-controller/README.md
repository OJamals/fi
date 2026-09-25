---
description: "Host and Client workspace control: mutate workspace navigation, follow its complete projection, and optionally isolate a Workspace's coding session in an application-managed local Git worktree."
kind: "package-reference"
---
# Workspace Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-workspace-controller` owns the Host `ctx.workspaceController` service and the generated Client `ctx.remote.workspace` namespace. Its Remote methods create, rename, remove, and reorder Workspaces, reorder Sessions within a Workspace, archive and unarchive Sessions from Workspace navigation, and follow the complete Workspace projection. Use it through API Gateway when a Client must change or follow Workspace navigation. The package also owns `ctx.directoryPickerController` and the generated `ctx.remote.directoryPicker` namespace, because the directory-picking seam it carries is abstract and never a Loader entry of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Host controller serializes mutations whose correctness depends on current registry state and throws `RemoteError` with a stable error code for expected failures. Its `follow()` stream synchronously attaches to durable Workspace changes, emits one complete baseline first, then emits ordered `upsert`, `remove`, `order`, `archived`, and `pinned` increments. Archive and pin sets are Session id arrays, with the most recently pinned id first in the pin array. A reconnect starts another generation with a replacement baseline, so consumers do not depend on receiving every increment while disconnected. `archiveSession` without `stopActivity` refuses a Session with running work as `workspace/session-active`, whose details list that work by family (`turn`, `subagent`, `job`, `schedule`) with item ids and labels; with `stopActivity: true` the registry's providers stop the work first and the response arrives once the archive set is durable, while the stops settle in the background.

The Client entry provides `ClientWorkspaceModel` and `createWorkspaceStateStream()`. The model owns Workspace rows, registry order, archived and pinned Session identities, unary mutation echoes, and stream/unary race resolution. A newer Host row wins by `updatedAt`; a committed stream order outranks an older unary response; a removed Workspace id cannot be resurrected by delayed data. Pin snapshots change only when their identities or order change. The package exposes framework-neutral snapshots and subscriptions, leaving navigation policy and React hooks to the UI owner. `WorkspaceController.archiveSession(sessionId, { stopActivity })` throws `WorkspaceArchiveError` with the Host's `rpcError`, so a surface can tell the running-work refusal from a missing Session or a carrier fault and offer to stop the work.

<a id="first-use-workspace"></a>
### First-use Workspace

`workspace.initializeDefault()` returns the durable default Workspace; the Client service exposes it as `workspaces.initializeDefault(signal?)`. It takes no request: the Host owns the fixed `default-workspace` directory name, and the registry derives the initial title from that same segment, so one installation keeps one on-disk path and one stored title in every language. The Host places the directory under its account's `<Documents>/deepseek-harness`, including on remote Web hosts. OS filename restrictions apply. Linux system lookup requires `xdg-user-dir` with an enabled Documents directory; hosts without it must configure `documentsDirectory` or use the folder picker.

The [Workspace registry](../../workspace/workspace/README.md#first-use-workspace) owns eligibility, directory creation, and durable initialization. An existing default Workspace is returned without another Documents lookup and is never renamed or relocated. Ineligible first use returns `undefined`, so startup can leave directory selection to the user. Lookup and creation failures use standard Remote error handling. Initialization creates no Session and sends no message.

`DEFAULT_WORKSPACE_DIRECTORY` and `workspaceDisplayTitle(title, localizedDefault)` are published from `./default-workspace` for browser consumers: a Workspace still carrying the automatic title reads as the reader's localized default name, and every other title reads verbatim. A Workspace the user renamed to exactly `default-workspace` — or a folder of that name adopted from the picker — is labeled as the default; nothing else depends on the distinction.

| Configuration | Default | Purpose |
| --- | --- | --- |
| `documentsDirectory` | System Documents directory | Fully qualified Host directory override |
| `documentsLookupTimeoutMs` | `10000` | Positive maximum duration of OS directory lookup, in milliseconds |

Documents lookup holds the registry mutation queue, so other Workspace mutations, including registration of a picked directory, can wait up to `documentsLookupTimeoutMs`. Cancellation can stop the lookup; after resolution succeeds, it does not roll back creation or registration.

<a id="managed-worktrees"></a>
### Managed worktrees

Configuring `managedWorktrees` lets a Client isolate a coding session in its own local Git checkout instead of running directly in a Workspace's own directory:

```yaml
- name: '@deepseek-ai/dsh-api-workspace-controller'
  config:
    managedWorktrees:
      managedWorktreeDirectory: !!js dshHomePath('worktrees')
```

| Field | Default | Meaning |
|---|---|---|
| `managedWorktreeDirectory` | — (required) | Absolute directory outside every source repository that retains checkouts and their ownership records |
| `gitTimeoutMs` | `30000` | Milliseconds one git command may run before it is aborted |
| `gitGraceMs` | `2000` | Milliseconds a terminated git process gets to exit before it is killed |
| `maxOutputBytes` | `8388608` | Bytes of git output, and of one ownership manifest, retained per read |

Without `managedWorktrees`, `createIsolated`, `inspectManaged`, and `removeManaged` all reject with `workspace/managed-unavailable`; the feature adds no composition requirement otherwise, and every other Workspace and Session behavior is unchanged.

`createIsolated({ workspaceId })` creates a fresh local Git worktree of that Workspace's directory — which must be a local repository root with a committed HEAD — on a new branch, from the source's committed HEAD alone: uncommitted, staged, ignored, and untracked source files are never copied. The new checkout is registered as an ordinary Workspace through the same `WorkspaceRegistry.create` every other Workspace uses, so Session cwd, tool execution, search, and Git inspection keep their existing, single authority; nothing about a Session running in a managed checkout is special-cased. `inspectManaged({ workspaceId })` reports `{ kind: 'managed', source, branch }` for a Workspace this feature created, or `{ kind: 'ordinary' }` for every other Workspace, including every one when the feature is not configured. `removeManaged({ workspaceId })` deletes the checkout and its Workspace registration together: it refuses with `workspace/worktree-active` while any of the Workspace's Sessions reports running work through the `workspace/session-activity` waterfall [`dsh-workspace`](../../workspace/workspace/README.md) declares — the same seam `archiveSession` uses — and refuses with `workspace/worktree-dirty` while the checkout has uncommitted, untracked, or ignored content, or commits not yet reachable from its source's current HEAD. A removed checkout's branch, its source repository, and every Session log stay untouched; a Session whose cwd was the removed checkout cannot continue there.

Application ownership of a checkout is resolved from the checkout's own path shape and a manifest colocated beside it (never inside it, so `git worktree remove` deleting the checkout can never delete the record), never from a caller-supplied identity: a client cannot claim a Workspace as managed, or forge its recorded source or branch, by constructing a request. [`ManagedWorktrees`](src/managed-worktrees.ts) owns this resolution and the bounded git execution — hooks, the filesystem watcher, and (for `status` and `worktree` commands) every content filter disabled — that creation and removal run through.

-----

<a id="model-experience"></a>
## Model Experience

None, as Workspace organization is browser and Host control state and registers no prompt, tool, or session event.

#### KV Cache effect

No direct effect; Workspace mutations do not alter model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `follow()` replaces the whole projection after reconnect and has no durable cursor or incremental catch-up protocol.
- Process-local deletion markers prevent delayed data from reviving a removed Workspace only for the lifetime of the Client model.
- Managed worktrees require a local `fs` and `subprocess` execution world; a remote or sandboxed execution world leaves `createIsolated` and `removeManaged` unavailable even when `managedWorktrees` is configured.
- The activity check and the removal are not one atomic step: a turn that starts between the waterfall's answer and `git worktree remove` is not retroactively refused, bounded by that step's latency in practice.
- `removeManaged` deletes the checkout unconditionally once its safety checks pass; there is no soft-delete or trash, and a removed checkout's files are gone once `git worktree remove` returns.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Workspace Registry owns persistence; every stream generation is a full projection.
