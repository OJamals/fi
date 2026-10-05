---
description: "The fi bundle layer that adds provider subscription sign-ins to a dsh --profile surface, for users composing or customizing a profile."
kind: "package-bundle"
---

# @fi/authorization-bundle

English | [中文](README.zh.md)

## Summary

`@fi/authorization-bundle` adds subscription sign-in and search settings UI to the shared [FI runtime layer](../runtime-bundle/README.md). FI Web and Desktop include it after base, web-app, and runtime-bundle. Custom GUI profiles use the same order. The layer obtains no credential or model route by itself; users configure grants and keys in settings.

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

### Install into a profile

FI Desktop ships this private layer in its local package set and fixed built-in profile; it does not install the layer from npm. A source or custom GUI profile gains these features by listing this layer after base, web-app, and runtime-bundle:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@fi/runtime-bundle", "@fi/authorization-bundle"]
    }
  }
}
```

The standard layer path also applies:

```text
dsh plugin --profile <name> add @fi/authorization-bundle
dsh plugin --profile <name> remove @fi/authorization-bundle
```

The add command reconciles the profile and activates the layer; it resolves the package name through the profile's package manager, which reaches the npm registry — an unregistered `@fi/*` name fails there with a fetch error and leaves the profile untouched. In a source checkout, name the layer in `dsh.profile.bundles` as above and keep it as a workspace dependency of the profile instead.

### What you get

FI uses provider-neutral onboarding and disables the DeepSeek-account UI, account Remote, product analytics, and Desktop product telemetry. Onboarding becomes ready only when the resolved default belongs to an available model group. The runtime layer owns model and search resolution, optional DeepSeek access, adapters, and disabled session feedback uploads.

The base mounts authorization; this layer mounts its Remote controller, Models subscription footer, and Preferred web search card. The footer supports Claude, Codex, Grok, Antigravity, and OpenCode Console; successful sign-in adopts the model route, while an existing grant can retry setup without another login. Search settings offer Auto, Bing RSS, explicit API providers, and subscription-native search, storing direct-provider keys through Credentials.

The composer Model pane places the subscription routes under a labeled Subscriptions section below regular providers. Antigravity's catalog provider name is `antigravity`, matching the lowercase route labels; provider and model ids do not change.

This GUI bundle configures `image_gen` for Codex, Grok, and Antigravity; Codex is the explicit image default. Failed requests do not switch providers. The [image-generation package](../tool-image-generation/README.md) owns reference-image editing, limits, and result behavior.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch document is `cordis.patch.yml`: an `insert` block adds FI-prefixed browser and Remote rows. The FI sign-in client plugin registers subscription route ids with the generic model selector's `ctx.modelSubscriptions` service; Cordis injection controls service ordering, and client-modules includes declared client packages in the browser boot manifest. Removing this GUI layer keeps runtime providers and preferences intact.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-authorization`](../../credentials/authorization/README.md) — the base-mounted seam this layer uses.
- [`@fi/api-authorization-controller`](../api-authorization-controller/README.md) — the Remote namespace that drives the seam from a browser.
- [`@fi/client-ui-model-signin`](../client-ui-model-signin/README.md) — the Models-page subscription sign-in section this layer ships.
- [`@fi/llm-antigravity`](../llm-antigravity/README.md) — the Antigravity OAuth adapter and transport this layer ships.
- [`@fi/provider-compat`](../provider-compat/README.md) — provider metadata, request headers, and release updates.
- [`@fi/tool-image-generation`](../tool-image-generation/README.md) — subscription-backed image generation and editing.
- [`@fi/web-search-preferences`](../web-search-preferences/README.md) — live preferred-provider routing.
- [`@fi/client-ui-web-search-preferences`](../client-ui-web-search-preferences/README.md) — preferred-search settings and direct-provider credential controls.
- [`@fi/web-search-subscription`](../web-search-subscription/README.md) — citation-gated native subscription search reused by the preferred router.
- [Agent Note: Subscription OAuth sign-in in Models settings](../../../.agents/notes/implemented/feature/2026-09-11-subscription-oauth-sign-in.md)

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through explicit model and search choices and the mounted image tool. The owning packages define request schemas and results.

#### KV Cache effect

Adding or removing this GUI layer changes the image tool schema. Search-provider preference does not change the `web_search` schema or prompt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- FI Web and Desktop mount this GUI bundle automatically. Custom GUI profiles must list it after runtime-bundle, and registry installation remains unavailable while the package is private.
- Removing a sign-in keeps the provider's settings route standing; the sign-in card documents why the two are separate actions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The manifest declares every package named by the patch, so installed profile composition resolves the same plugins as a source checkout.

**Runtime invariant:** No companion is published. The layer holds no runtime state: its substance is a patch document, and the seam it mounts owns the attempt lifecycle.

</details>
