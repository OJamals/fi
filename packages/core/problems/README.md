---
description: "Revisioned Workspace diagnostics registry for bounded producers and complete-snapshot consumers."
kind: "package-reference"
---

# @deepseek-ai/dsh-problems

English | [中文](README.zh.md)

## Summary

`dsh-problems` is the canonical Host registry for coding diagnostics. Producers atomically replace one complete source contribution under a canonical Workspace path; consumers inspect or subscribe to detached, deterministically ordered snapshots. Revisions advance only when visible content changes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin once on the Host, then call `ctx.problems.replace(workspaceRoot, source, problems)` with a producer's complete current contribution. An empty replacement clears that source. `inspect()` returns the complete current snapshot; `subscribe()` delivers later complete replacements and returns an effect-scoped disposer.

Every caller must supply the filesystem provider's canonical Workspace process path. Inputs accept `error`, `warning`, `info`, or `hint`, Workspace-relative paths, one-based positions, and optional exclusive end positions. Invalid input or configured limit overflow fails before state changes; an empty or rejected first replacement does not retain Workspace state.

Default limits are 32 sources per Workspace, 500 problems per source, 2,000 total problems, 16,384 UTF-8 message bytes, 256 source/code bytes, and 4,096 path bytes.

No producer is mounted by default. This package ships as an available capability seam: a future diagnostic producer (a lint runner, a task-failure parser, an LSP diagnostics forward) replaces its own source, and `dsh-tool-problems` reads whatever sources are currently registered.

<a id="understand-the-implementation"></a>
## Understand the implementation

The process-local service keeps one source map per canonical Workspace with accepted visible state. Replacement validates and copies the entire contribution into a local candidate, compares normalized visible content, commits once, then notifies isolated listeners. Ordering is severity, path, start position, source, code, then message.

<a id="further-exploration"></a>
## Further Exploration

- [Problems tool](../tool-problems/README.md) — bounded model inspection.
- [LSP capability seam](../../lsp/lsp/README.md) — a read-only navigation seam a future diagnostics forward could sit beside.

<a id="model-experience"></a>
## Model Experience

None, as this registry registers no prompt, tool schema, or model-visible event.

#### KV Cache effect

No model tokens or cache entries originate here.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- State is process-local and derived; producers must republish after restart.
- Producers replace complete source contributions; incremental diagnostic deltas are unsupported.
- No shipped package currently replaces a source; every diagnostic surfaced through `problems` depends on a deployment mounting its own producer.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
