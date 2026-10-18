---
description: "Shared FI provider, default model, search, and feedback configuration for base-backed application profiles."
kind: "package-bundle"
---

# @fi/runtime-bundle

English | [中文](README.zh.md)

## Summary

The private FI runtime layer mounts subscription adapters, provider compatibility, and preferred search after `@deepseek-ai/dsh-base`. Web, Desktop, headless, ACP, and full SDK profiles include it. GUI profiles additionally mount [authorization-bundle](../authorization-bundle/README.md), which owns the image tool composition.

The layer also mounts [native subscriptions](../llm-subscriptions/README.md) for Cursor, Kiro, Cline Free/Pass, and Gemini Code Assist. GitHub Copilot keeps pi-ai OAuth and uses the native subscription chat route.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

List this bundle after the upstream base and application bundle in a locally installed profile. Private FI packages remain unavailable through the public registry. Custom bundle lists opt in explicitly; exact legacy shipped tuples migrate to the current templates.

The layer clears the inherited DeepSeek model default and enables `agent-default-model.selectionPolicy: available`. A usable explicit selection takes precedence; otherwise linked subscription grants take precedence over configured API providers, with deterministic provider-id ordering. Grant keys are configured in `subscriptionCredentials`. With no usable route, the GUI reports no default and prompts for setup; automation entry points require a model before starting work. Automatic choices remain runtime-only. Explicit choices persist through the configuration editor.

DeepSeek's account service, account model route, and legacy API-key plugin are disabled. The third-party selector offers pi-ai's `deepseek` provider. Existing `deepseek-official` users can explicitly enable the `llm-deepseek` plugin in their profile patch; see the [upgrade guide](../../../docs/upgrade-guide/v1.0.0/deepseek-provider-opt-in/guide.md). Credentials and saved conversations are retained.

Search defaults to Auto: use the current model's linked native search when supported, otherwise keyless Bing RSS. Explicit provider overrides remain available. The [search preferences owner](../web-search-preferences/README.md) defines routing, keys, and errors.

Session feedback uploads are disabled through `session-telemetry-otel.mode: DISABLED`, so feedback cannot send Session logs to the upstream collector. The GUI layer also disables product analytics and Desktop product telemetry. A deployment deliberately enabling telemetry owns its endpoint and sharing policy.

The layer mounts native Antigravity, OpenCode Console, and [Ollama Cloud](../llm-ollama/README.md) adapters and [provider compatibility](../provider-compat/README.md). Each adapter owns its model-visible request behavior.

## Understand the implementation

`cordis.patch.yml` is the complete implementation; the manifest declares every inserted plugin dependency. The exported module has no runtime API. No invariant companion is published because the bundle owns no independently observable runtime state; the mounted services own their lifecycle.

## Further Exploration

- [Default model service](../../core/agent-default-model/README.md) — resolution and explicit persistence.
- [Authorization GUI layer](../authorization-bundle/README.md) — browser sign-in and settings.
- [Upgrade guide](../../../docs/upgrade-guide/v0.2.0-rc.2/fi-runtime-defaults/guide.md) — existing profiles and SDK callers.

## Model Experience

### Default selection and search routing

#### What the model sees

The layer selects the model used by fresh Agents. Search choices retain the existing `web_search` schema. Existing Session request headers remain unchanged.

#### Token effect

The layer adds no prompt text or tool schema; routed search results remain ordinary tool results.

#### KV Cache effect

Model selection affects subsequent fresh requests. Existing conversations preserve their selected model and logged prefix; search routing retains the mounted tool schema.

## Known Limitations and Deferred Work

- Configured credentials and a resolvable catalog establish selection readiness; provider authentication and quota errors can still occur during generation.
- `sdk-minimal` remains a separate explicit-route profile without this layer.

### Dev Note

The layer requires the upstream base rows. Browser-only settings and Remote controllers belong to authorization-bundle.
