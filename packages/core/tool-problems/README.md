---
description: "Bounded model-facing inspection tool for current canonical Workspace diagnostics."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-problems

English | [中文](README.zh.md)

## Summary

`dsh-tool-problems` registers the parameterless `problems` tool. It derives the caller's Workspace from the live agent Session, resolves that path through `ctx.fs`, reads the canonical `ctx.problems` snapshot, and returns bounded deterministic text. No diagnostics enter model context until the model calls the tool.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount it inside a full agent preset with `fs`, `problems`, `systemPrompt`, and `tools`. `maxProblems` defaults to 100 and `maxResultChars` to 16,000 Unicode code points. Missing Session Workspace fails the call; path scope is never accepted from tool arguments.

<a id="model-experience"></a>
## Model Experience

### Workspace diagnostic guidance

#### What the model sees

One stable system-prompt section:

##### Diagnostic inspection guidance

```markdown
Use problems after code edits or task runs to inspect current Workspace diagnostics. It returns a bounded snapshot only when called; do not assume no diagnostics exist before their producers run.
```

#### Token effect

Fixed prompt tokens while this package is mounted; `minimal` omits them.

#### KV Cache effect

Prefix-stable while section text and order remain unchanged. Mounting or removing this package changes the request prefix.

### `problems` tool and results

#### What the model sees

The parameterless `problems` schema plus an on-demand result containing revision, total count, severity, file location, source, code, and message. Control characters are escaped, omitted entries are counted, and excess text is marked truncated.

#### Token effect

One fixed schema while mounted. Each call appends one bounded result capped by `maxProblems` and `maxResultChars`; no result enters context before a call.

#### KV Cache effect

Schema tokens remain prefix-stable while registration is unchanged. Logged calls and results append after the reusable prefix; deployment result bounds change call output, not the schema.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Inspection is on demand; the tool does not run producers or imply diagnostics are current before they publish.
- Output is text, not a mutation or editor protocol.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
