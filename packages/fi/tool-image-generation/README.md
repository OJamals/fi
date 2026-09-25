---
description: "Opt-in image generation and editing through stored Codex, Grok, or Antigravity subscription OAuth."
kind: "package-reference"
---

# @fi/tool-image-generation

English | [中文](README.zh.md)

## Summary

Use this package to generate one raster image from text or edit ordered workspace images through an existing Codex, Grok, or Antigravity subscription login. The deployment explicitly enables each provider and image model. Calls never use API-key billing or fall back to another provider, and unsigned startup remains safe because authentication is resolved only when the tool runs.

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

Mount the plugin in an FI profile with at least one explicit target and a configured default provider.

### When to choose it

Choose this package when a deployment stores subscription OAuth and needs model-callable text-to-image or workspace-image editing. Choose a separate API-key image provider when subscription transport is unavailable or a vendor control outside this tool is required.

### Minimal configuration

```yaml
- name: '@fi/tool-image-generation'
  config:
    defaultProvider: codex
    targets:
      codex:
        imageModel: gpt-image-2
```

| Field | Default | Meaning |
|---|---|---|
| `defaultProvider` | required | Configured provider used when a tool call omits `provider` |
| `targets` | required | Non-empty map of `codex`, `grok`, or `antigravity` to an explicit `imageModel` |
| `timeoutMs` | `180000` | Whole-operation timeout; integer from 1 through 600000 milliseconds |
| `maxOutputBytes` | `33554432` | Maximum decoded generated-image bytes; integer from 1 through 67108864 |

The generated [configuration catalog](../../../docs/config-catalog.md#fitool-image-generation) is the exhaustive source for accepted fields and JSDoc.

`image_gen` accepts a required non-empty prompt, an optional provider restricted to configured targets, and optional ordered PNG, JPEG, or WebP workspace paths. Codex and Grok accept one to five references; Antigravity accepts one to three. The package rejects an excessive count before filesystem, credential, or network access. It sends no size or quality field, so the selected provider keeps its native defaults.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin creates one pi-ai credential adapter for Codex and Grok and uses the Antigravity package's grant resolver and native image transport. Each call resolves one selected target, reads accepted references through the execution-world filesystem, and stores normalized inputs through the attachment service before dispatch.

The response reader accepts exactly one base64 image, bounds JSON and decoded bytes before allocation, identifies PNG, JPEG, or WebP from bytes, rejects a declared-media mismatch, and delegates complete raster validation to the attachment service. A successful result contains safe JSON and one durable `ImageBlock`; it excludes raw image data. HTTP failures retain status without response bodies, ambiguous POST failures are not retried, and plugin disposal aborts and awaits active work.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config validation, credential adapters, and lifecycle wiring |
| [`src/tool.ts`](src/tool.ts) | Tool schema, filesystem projection, provider selection, and durable results |
| [`src/provider.ts`](src/provider.ts) | Subscription transports, native request bodies, and bounded response decoding |
| [`src/raster.ts`](src/raster.ts) | Shared byte-signature identification |
| [`tests/expected/image-result.json`](tests/expected/image-result.json) | Owner-local golden for the model-visible value |
| — | No runtime invariant companion is published; the consumed services own the mutable relationships. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.md) — stored Codex and Grok OAuth resolution.
- [`@fi/llm-antigravity`](../llm-antigravity/README.md) — Antigravity grant and native Gemini transport.
- [`dsh-attachment`](../../attachment/attachment/README.md) — durable image references and image limits.
- [`dsh-fs`](../../fs/fs/README.md) — execution-world filesystem access.
- [Generated tool catalog](../../../docs/tool-catalog.md#fitool-image-generation) — the exact `image_gen` schema the model receives.

-----

<a id="model-experience"></a>
## Model Experience

### Image generation tool

#### What the model sees

The generated [`image_gen` schema](../../../docs/tool-catalog.md#fitool-image-generation) exposes only configured providers. Successful results contain the selected provider and model, canonical input and output references, optional safe generation id, concise text, and one durable output image.

#### Token effect

The tool schema adds fixed tokens while the plugin is visible. Each call appends bounded JSON, concise result text, and one image block; input paths affect call tokens, and provider-generated raster bytes follow the selected adapter's image-token accounting.

#### KV Cache effect

The configured provider enum and default-provider wording remain prefix-stable for one plugin mount. Configuration changes replace those schema tokens, while each tool call appends new result content after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits avoid claiming provider controls or transports that this package does not expose.

- Claude has no supported raster-output transport. A Claude conversation can call this tool only with a configured Codex, Grok, or Antigravity target.
- References must be readable workspace images. Masks, opaque provider file ids, and remote result URLs are unsupported.
- Account and model availability can change. Missing or non-OAuth grants fail on execution.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
