---
description: "The deployment default model selection for users and maintainers choosing, configuring, or debugging which model freshly created agents start on."
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-default-model

English | [中文](README.zh.md)

## Summary

Give newly created agents a shared default provider and model when their sessions do not specify one. Provider, model, and reasoning effort are live Config fields. Saved selections update the active profile patch and apply to subsequent reads; per-session selection remains owned by the entry point.

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

Mount this package wherever agents are created without an explicit model route. The service answers one question — which model should a fresh agent use? — so entry points that create agents consult it instead of re-implementing a default.

### Configure the default

Configure provider and model together, or omit both for an unconfigured default. Consumers read the live references even when no configuration editor is mounted. `selectionPolicy: configured` preserves the configured pair. `selectionPolicy: available` requires LLM, Credentials, and Settings services and resolves a usable explicit choice, then linked subscription grants, then configured API providers. `subscriptionCredentials` maps routes to grant keys; `credentiallessProviders` explicitly permits automatic selection without credentials.

A legacy complete profile override that names only provider/model inherits its profile's resolution policy through ConfigEditor. Explicit `selectionPolicy` fields override that policy; subsequent selection saves retain it.

```yaml
- name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: deepseek
    model: deepseek-chat
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | omitted | Registered provider route; configure with `model` |
| `model` | omitted | Provider-owned model id; configure with `provider` |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-default-model) lists every accepted field. `reasoningEffort` is optional; saving a selection without it removes that field from the profile’s complete config override.

### Read and change the default

Await `resolveSelection()` before creating a fresh agent. It returns a usable selection or `undefined` when setup is required. `currentSelection()` returns a detached configured or last resolved selection, or `undefined`. `saveSelection()` stores an explicit complete selection for later agents; passing `undefined` clears it while retaining policy configuration. Automatic resolution never writes the profile.

```text
const selection = await ctx.agentDefaultModel.resolveSelection()
await ctx.agentDefaultModel.saveSelection({ provider, model, reasoningEffort: 'high' })
```

Without a configuration editor, `saveSelection()` is a no-op. Available resolution skips failed catalogs and unresolved models; configured resolution retains the explicit pair. Consumers diagnose unavailable selections for existing sessions. Configured credentials do not guarantee successful generation.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains how the service realizes the behavior above; the observable contract is covered in [Use this package](#use-this-package).

### Design concept

The service retains its validated Config references and samples them in `currentSelection()`. `saveSelection()` captures the submitted values and serializes profile writes in submission order, including overlapping callers. Each caller observes its own write failure; a rejected write does not prevent later saves. Session-specific selection takes precedence in the consumer.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Live default selection and profile-backed writes |
| — | No invariant companion is published because the resolved value is derived from configuration and live provider metadata, not an independent observation. |

### Behavior notes

`currentSelection()` returns a detached selection. A captured selection stays stable while later operations read updated Config references.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

The package-level contract is enough for most consumers; read these when you need the surrounding domain.

- [Core subsystem](../../../docs/subsystems/core.md) — the `Agent` handle and `AgentOptions` route selection.
- [agent-loop package](../agent-loop/README.md) — how agents resolve provider and model at request time.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-agent-default-model) — every accepted config field and its source declaration.
- [Core group map](../README.md) — how the core packages compose.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `ModelSelection` the service supplies to an entry point; request assembly and the provider adapters own the model-visible request.

#### KV Cache effect

Changing the default affects only agents that subsequently resolve from it. An existing session whose request log already names a selection keeps that selection, so this service does not invalidate its established prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the service's scope. They are current package constraints, not a task backlog.

- **One process-wide default** — the service owns a single default; per-session model selection remains the entry point's responsibility.
- **Persistence requires a profile configuration editor** — without it, saving a default does not retain the selection.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
