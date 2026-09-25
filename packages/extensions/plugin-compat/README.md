---
description: "Read-only local Claude Code and Codex plugin scanning, a persistent global import registry, and per-item consent gating skill, MCP, and hook activation."
kind: "package-reference"
---

# @deepseek-ai/dsh-plugin-compat

English | [中文](README.zh.md)

## Summary

This package scans a local Claude Code or Codex plugin directory without executing any of its content, and keeps a durable global registry of the plugins a person has explicitly imported. Every import and every skill, MCP server, or hook enablement is a deliberate command; nothing activates on discovery. Skills start enabled, while MCP servers and hooks — which spawn local commands or reach a network server — start disabled until enabled by name. Enabled, still-valid contributions mount through the existing `dsh-skill`, `dsh-mcp-client`, `dsh-hooks-claude-code`, and `dsh-hooks-codex` capabilities when a new session composes.

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

### When to choose it

Mount this service to let a person import their own local Claude Code or Codex plugin directories into fi, reusing that plugin's skills, MCP server declarations, and command hooks without hand-authoring an equivalent `dsh-skill-filesystem` root, `dsh-mcp-client` row, or hook config. Skip it when a deployment already owns its skill, MCP, and hook composition directly through the native packages — this package only adds an import path from another tool's local plugin layout.

### Enable the plugin and the commands

Both rows ship `disabled: true` in `dsh-base`; enable them together with a patch:

```yaml
- id: plugin-compat
  name: '@deepseek-ai/dsh-plugin-compat'
  disabled: false
- id: plugin-compat-command
  name: '@deepseek-ai/dsh-plugin-compat/command'
  disabled: false
```

`Config` accepts `home` (defaults to the fi home directory) and the scan bounds `maxFiles`, `maxFileBytes`, `maxTotalBytes`, and `maxEntries`, each a deployment-tunable safety limit on one scan.

### Import and enable a plugin

Once enabled, a person drives every mutation through the registered commands — there is no automatic action on discovery:

- `/plugin-import <local plugin directory>` — scans the directory (a `.claude-plugin/plugin.json` or `.codex-plugin/plugin.json` manifest, or Claude's manifest-free `skills/`, `hooks/hooks.json`, `.mcp.json` layout) and records it at global scope. Skills are enabled; MCP servers and hooks are not.
- `/plugin-list` — lists imported plugins, their components, and any diagnostics.
- `/plugin-enable <plugin id> [skill|mcp|hook:<item id>]` / `/plugin-disable ...` — enables or disables a whole plugin or one component.
- `/plugin-remove <plugin id>` — drops the association.

A change takes effect the next time a session composes; `mountManagedPlugins` runs from `agent/created`, so an already-published agent keeps its existing composition. `PluginCompatService` also exposes `list`/`importLocal`/`remove`/`setEnabled`/`resetOverride` directly, including workspace-scoped selection layered over the global baseline, for a future settings surface to drive without a command line.

### Observable success and failures

`/plugin-import` succeeds only when the scan is valid (a required manifest is present and parses, every path stays inside the plugin root, and every discovered MCP server and hook is one of the supported shapes); otherwise it reports the rejection reason and imports nothing. Activation re-scans the plugin root and refuses to mount a plugin whose fingerprint no longer matches what was imported, so an edited or deleted plugin fails closed with an explicit "reimport it" error rather than mounting stale or partial content.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

`src/manifest.ts` is a read-only scanner: it never spawns a process, evaluates a script, or opens an MCP connection. Every file it reads passes a lexical and `realpath` containment check against the plugin root (so a symlink cannot walk it outside the root), and is opened `O_NOFOLLOW`-then-compared-by-inode before counting toward the configured file-count, per-file, aggregate-byte, and directory-entry limits. It parses skill frontmatter, validates MCP `stdio`/HTTP entries against an explicit allowed-field list, and validates the supported command-hook subset, recording every unsupported event, hook type, or field as a diagnostic rather than silently dropping it. The scan result carries a SHA-256 fingerprint over every discovered file's exact bytes.

`PluginCompatService` (`src/index.ts`) owns one versioned JSON document (global plugins, plus workspace-local plugins and overrides) at `<dshHome>/plugin-compat.json`, written through `dsh-atomic-write`'s file lock and atomic rename. Every mutation serializes through one internal queue and carries an optimistic-concurrency revision. `resolveForWorkspace()` (invoked from `agent/created`) re-scans each enabled plugin and requires its fingerprint to still match the imported one before returning it for mounting.

`src/runtime.ts` mounts each resolved, enabled, scanner-supported contribution as a child plugin scoped to the composing agent's own `agent.ctx` (so it unwinds with that agent): a skill contribution calls `ctx.skills.register()` directly; an MCP server mounts `dsh-mcp-client` with a translated `StdioConfig`/`StreamableHttpConfig`; hook contributions materialize a private, `0o600` temporary `hooks.json` (cleaned up on disposal) and mount `dsh-hooks-claude-code` or `dsh-hooks-codex` pointed at it — the same native bridges an unmodified deployment already uses.

`src/command.ts` is the only shipped consent surface: five `dsh-commands` registrations that call the service at global scope. No Settings UI is shipped in this change (see [Known Limitations](#known-limitations-and-deferred-work)).

### Source map

| File | Role |
|---|---|
| [`src/manifest.ts`](src/manifest.ts) | Bounded, read-only scanner: discovery, containment checks, validation, diagnostics, fingerprint |
| [`src/index.ts`](src/index.ts) | `PluginCompatService`: the persisted document, mutation queue, and `agent/created` activation |
| [`src/runtime.ts`](src/runtime.ts) | Mounts resolved skills, MCP servers, and hooks onto one agent's scoped context |
| [`src/command.ts`](src/command.ts) | `/plugin-import`, `/plugin-list`, `/plugin-enable`, `/plugin-disable`, `/plugin-remove` |
| [`src/types.ts`](src/types.ts) | Public records: `ManagedPlugin`, `ManagedPluginItem`, scope and target types |
| — | No runtime invariant companion is published: the persisted document's `zod` schema and per-activation fingerprint re-check already own every diverging observation this package could report, so a separate companion would only wrap an existing check. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Extensions group](../README.md) — package ownership and subsystem links.
- [Skill provider seam](../../skill/skill/README.md) and [filesystem skill provider](../../skill/skill-filesystem/README.md) — the registry a skill contribution registers on.
- [MCP client bridge](../../mcp/mcp-client/README.md) — the seam a translated MCP server config mounts.
- [Claude Code hook bridge](../../hooks/hooks-claude-code/README.md) and [Codex hook bridge](../../hooks/hooks-codex/README.md) — the bridges a materialized `hooks.json` mounts.
- [Agent Note: Local Claude and Codex plugin compatibility scanning](../../../.agents/notes/implemented/feature/2026-09-25-local-plugin-compatibility-scan.md) — scanner decisions and rejected alternatives.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-skill`, `dsh-mcp-client`, `dsh-hooks-claude-code`, and `dsh-hooks-codex`, which own all model-visible rendering of an enabled contribution.

#### KV Cache effect

No effect until a plugin is imported and a component enabled. Once mounted, an enabled skill, MCP tool, or hook follows the KV-cache behavior already documented by the package that renders it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what this package does not do. They are current package constraints, not a task backlog.

- **No Settings UI.** `/plugin-import`, `/plugin-list`, `/plugin-enable`, `/plugin-disable`, and `/plugin-remove` are the only shipped consent surface. `PluginCompatService`'s public methods, including workspace-scoped selection, are ready for a future browser settings card to drive directly.
- **Local roots only.** Marketplace download and installation stay outside this package; import a plugin that is already present on disk.
- **The fingerprint covers discovered files, not their behavior.** It hashes every manifest, skill, resource, MCP, and hook configuration file the scan discovers, but a hook command's own script, and any dependency it loads at run time, are outside the fingerprint and outside this package's execution-integrity guarantee.
- **Unsupported components stay visible, never active.** A skill field, hook event, hook type, or manifest key the scanner does not recognize is recorded as a diagnostic and cannot be enabled; there is no override.
- **Session-start hook timing follows the native bridge.** An imported `SessionStart` hook can miss the very first request, matching the [Claude](../../hooks/hooks-claude-code/README.md) and [Codex](../../hooks/hooks-codex/README.md) hook bridge contracts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This package owns compatibility scanning, the persisted import registry, and per-agent activation. It does not own scope persistence UI or agent composition beyond mounting on `agent/created` — a Settings surface presenting the resulting snapshots is future work.

</details>
