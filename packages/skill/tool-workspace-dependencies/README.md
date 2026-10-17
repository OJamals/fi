---
description: "The load_workspace_dependencies tool: absolute paths into a bundled Python, Node.js, and pnpm payload, used in place or installed under the Harness home."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-workspace-dependencies

English | [中文](README.zh.md)

## Summary

Deployments that ship their own script runtimes (Desktop's primary runtime, or a container image layer) mount this tool so the agent can ask where the bundled Python, Node.js, and pnpm live instead of discovering a system interpreter. The tool returns absolute paths and recorded distribution versions; it changes neither `PATH` nor package-manager settings. The payload is either copied under the Harness home on first use (Desktop) or used where it lies (read-only carriers).

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

Mount the plugin beside the tool registry with the payload directory. Configuration validation requires a nonempty `source` and rejects empty `root` values before activation; both paths must be absolute. The bundled Office skills (`@deepseek-ai/dsh-skill-office`) reference this tool by name for their default interpreter.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-tool-workspace-dependencies'
  config:
    source: /path/to/primary-runtime
```

| Field | Default | Meaning |
|---|---|---|
| `source` | required | Absolute payload directory carrying `runtime.json` and either `dependencies/` or a macOS archive carrier. |
| `root` | unset | Absolute installation directory under the Harness home. Set: the payload is copied or extracted there on the first call and reused while `runtime.json` is unchanged. Unset: directory payloads are validated and used in place; archives require an installation root. |
| `installLockWaitMs` | `120000` | Maximum wait for another local process to finish installing the same runtime. |

### Payload layout

Payload copies preserve relative file aliases, including Python executable aliases, through staging and installation. Before copying, aliases must resolve to existing regular files inside the payload; absolute, escaping, dangling, and directory links are rejected. The source must remain immutable during validation and copying.

macOS archive carriers contain `runtime.json`, `payload.tar.xz`, and `archive.json` with exactly `version: 1`, `file: "payload.tar.xz"`, and a lowercase SHA-256 `sha256`. The archive contains `runtime.json` and `dependencies/`; installation verifies its digest, rejects escaping paths, duplicate entries, special files, hard links, and aliases that do not resolve to internal files before extraction, then compares the extracted manifest with the carrier metadata. Extraction uses the system `/usr/bin/tar` and requires no network access. Installed runtime paths and user-added packages remain unchanged when the normalized manifest matches.

Installation serializes callers across local processes. An interrupted swap restores `<root>.previous` when the destination is missing; preparation failures leave the old runtime intact. A failed final rename restores the previous tree, and a failed restoration retains it for the next attempt. A lock whose recorded process has exited can be recovered; shared directories across machines or PID namespaces are unsupported.

On macOS, installation copies prepared files with `/usr/bin/ditto --hfsCompression --nopreserveHFSCompression` before publication; failed compression uses the validated uncompressed copy. Existing healthy caches remain untouched by default. Maintenance callers may request `compressExistingCache: true` only after stopping every process that can read or modify that cache; the installer lock does not lock pip, pnpm, or user scripts. This one-time migration retains user-added files, permissions, and symlinks without following their targets. Compression failure reuses the healthy cache, and publication failure restores it. The private copy receives `.macos-compression-v1` only after copying succeeds; subsequent calls reuse it. Compression changes storage allocation, not file bytes, and requires no network access; savings depend on filesystem support and file contents. Other platforms retain ordinary copies.

Desktop calls `installPrimaryRuntime` with `repairInvalidEntries: true` to repair malformed cache metadata and missing or invalid declared entries before startup. Repair validates a fresh payload before moving the entire damaged cache, including user-added files, into `<root>.recovery-<random>/runtime`; the recovery directory remains after successful publication for manual recovery of those files. Publication failure restores the damaged cache. Other callers reject invalid cached metadata or entries unless they explicitly enable this option.

`runtime.json` records `desktopVersion`, `platform` (`win32`, `darwin`, or `linux`), `arch`, optional `payloadDigest`, top-level `python`, optional `node`/`pnpm` versions, and the complete `pythonPackages` distribution-version map. A pnpm entry requires Node.js. Python libraries, including numpy and pandas, appear only in `pythonPackages`. Entries live under `dependencies/`: `python/bin/python3` (`python/python.exe` on Windows) with `site-packages` beneath it, and, when declared, `node/bin/node` with `node/node_modules` and `pnpm/bin/pnpm.mjs`. A manifest whose platform or architecture differs from the running process is rejected.

The packaged `sdk` profile uses its bundled Python and Office skills by default; `DSH_PRIMARY_RUNTIME` overrides the resource location, and an empty value opts out. Source launches without a carrier default remain opt-in. See [runtime configuration](../../../python/sdk-runtime/README.md) for independent skill selection. Missing skill resources produce a startup warning; invalid or incomplete external runtime payloads fail the first tool call. Profile configuration changes require restarting the SDK process.

### Build a carrier payload

From a repository checkout with dependencies installed, `CI=true pnpm run prepare:primary-runtime --target linux-x64 --output /tmp/dsh-office` writes `primary-runtime/` and `office-skills/`. The shared [download lock](../../../scripts/primary-runtime/lock.json) also covers `linux-arm64`, `mac-arm64`, `mac-x64`, and `win-x64`. `--python-only` omits Node.js and pnpm; `--cache` selects the hash-verified archive cache. The entry executes interpreter and Office read/write checks only for a native target. Cross-target builds require those checks on the target host before deployment.

A container can copy both directories into an immutable image layer and set `DSH_PRIMARY_RUNTIME` to the absolute `primary-runtime/` path. The SDK queries that payload in place. Desktop uses the same builder and retains its Harness-home installation and signing checks.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`readPrimaryRuntime` and build smoke checks share `parsePrimaryRuntime`. It validates the flat manifest and rejects duplicate normalized distribution names. Legacy `components` metadata is normalized in memory, retaining its consistency checks; a missing legacy distribution map becomes empty. Mixed flat and legacy version fields are rejected. Reads do not rewrite metadata, and equivalent normalized manifests can reuse an installed payload. `workspaceDependencyPaths` derives the platform-specific entries. `installPrimaryRuntime` copies into a staging directory, requires declared interpreters and scripts to be files and package roots to be directories, and swaps it into place while retaining the previous tree on failure; `resolvePrimaryRuntime` verifies the same entries without copying. The tool memoizes the first successful preparation for the plugin's lifetime.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Manifest validation, path derivation, in-place and installed preparation, tool registration. |
| — | No runtime invariant companion is published: the payload manifest is validated on every preparation, and the tool registry owns registration lifecycle. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Office skills](../skill-office/README.md) — the workflows that call this tool for their interpreter.
- [Tool registry](../../core/tools/README.md) — registration and schemas.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The model sees the generated [`load_workspace_dependencies` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-workspace-dependencies).

#### Token effect

Fixed schema cost per request where the tool is visible; the description names the bundled Office libraries so the model can choose the interpreter without loading a skill first.

#### KV Cache effect

Prefix-stable while the tool definition and visibility are unchanged.

### Tool result

#### What the model sees

One JSON object with absolute `python` and `pythonPackages` paths, `pythonDistributions` from `runtime.json`, and `node`, `nodePackages`, and `pnpm` when the payload declares them. Repeated calls return the same object.

#### Token effect

A few hundred characters per call; paths dominate.

#### KV Cache effect

Append-only tool result in the turn history; no prompt section is added.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Linux targets require glibc; musl payloads are not locked.
- Windows payloads used in place must already be executable from their carrier; the in-place mode performs no permission repair.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Placement and carrier choices are recorded in the [shared-runtime Agent Note](../../../.agents/notes/implemented/architecture/2026-09-17-shared-office-runtime.md).

</details>
