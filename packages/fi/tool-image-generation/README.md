---
description: "Opt-in image generation and editing through stored Codex, Grok, or Antigravity subscription OAuth."
kind: "package-reference"
---

# @fi/tool-image-generation

English | [中文](README.zh.md)

## Summary

Use this package to generate one to four raster images from text or edit ordered workspace images through an existing Codex, Grok, or Antigravity subscription login. The deployment explicitly enables each provider and image model. Calls never use API-key billing or fall back to another provider, and unsigned startup remains safe because authentication is resolved only when the tool runs.

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
| `maxOutputBytes` | `33554432` | Maximum decoded bytes of all images one call generates, together; integer from 1 through 67108864 |

The generated [configuration catalog](../../../docs/config-catalog.md#fitool-image-generation) is the exhaustive source for accepted fields and JSDoc.

`image_gen` accepts a required non-empty prompt, an optional provider restricted to configured targets, optional ordered PNG, JPEG, or WebP workspace paths, and optional `size`, `quality`, and `count`. Codex and Grok accept one to five references; Antigravity accepts one to three. `size` is one of `1024x1024`, `1536x1024`, `1024x1536`, `1792x1024`, or `1024x1792`; `quality` accepts only `high`; `count` is 1 through 4 and defaults to 1. Codex accepts only `1024x1024`, `1536x1024`, and `1024x1536` and rejects `1792x1024` and `1024x1792` with `IMAGE_INVALID_ARGUMENT`; it sends `size`, `quality: "high"`, and `n` unchanged. Grok generation maps those sizes, in that order, to `aspect_ratio` `1:1`, `3:2`, `2:3`, `16:9`, and `9:16`, and maps `high` to `resolution: "2k"`; Grok editing rejects `size` and `quality` with `IMAGE_INVALID_ARGUMENT`. Antigravity maps `size` to the same `aspectRatio` values and `high` to `imageSize: "2K"`, and makes one upstream call per requested image. The package rejects an excessive reference count, unsupported Codex sizes, and unsupported Grok edit options before filesystem, credential, or network access. Codex and Grok receive no size or quality field when the call omits it and keep their native defaults; Antigravity sends `aspectRatio: "1:1"` when `size` is omitted.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin creates one pi-ai credential adapter for Codex and Grok and uses the Antigravity package's grant resolver and native image transport. Each call resolves one selected target, reads accepted references through the execution-world filesystem, and stores normalized inputs through the attachment service before dispatch.

The response reader accepts exactly `count` base64 images, bounds JSON and the decoded bytes of all images together before allocation, identifies PNG, JPEG, or WebP from bytes, rejects a declared-media mismatch, and delegates complete raster validation to the attachment service. A successful result contains safe JSON with an `images` array, each entry carrying its own optional `generationId`, and one durable `ImageBlock` per image; it excludes raw image data. HTTP failures retain status without response bodies, ambiguous POST failures are not retried, and plugin disposal aborts and awaits active work.

The configuration schema supplies operation limits before tool construction, and the tool argument schema permits only configured providers. After bounded body reading completes, malformed UTF-8 or JSON reports `IMAGE_INVALID_RESPONSE`; caller cancellation is checked before decoding and after a valid decoded value.

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

The generated [`image_gen` schema](../../../docs/tool-catalog.md#fitool-image-generation) exposes only configured providers. Successful results contain the selected provider and model, canonical input references, an `images` array of output references that each carry an optional safe `generationId`, one concise text block, and one durable image block per generated image.

#### Token effect

The tool schema adds fixed tokens while the plugin is visible. Each call appends bounded JSON, one concise result text block, and one image block per generated image; input paths affect call tokens, and provider-generated raster bytes follow the selected adapter's image-token accounting.

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
