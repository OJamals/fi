---
description: "The fi bundle layer that adds provider subscription sign-ins to a dsh --profile surface, for users composing or customizing a profile."
kind: "package-bundle"
---

# @fi/authorization-bundle

English | [中文](README.zh.md)

## Summary

`@fi/authorization-bundle` adds subscription sign-in, model access, image generation, and preferred web search to a base-backed `dsh --profile` composition. FI Desktop includes it after the upstream base and Web bundles. Source and custom profiles opt in by listing the layer after `@deepseek-ai/dsh-base`. The layer obtains no credential or model route by itself; users configure grants and keys in settings.

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

FI Desktop ships this private layer in its local package set and fixed built-in profile; it does not install the layer from npm. A source or custom profile that already names `@deepseek-ai/dsh-base` gains the features by listing this layer after it:

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@fi/authorization-bundle"]
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

The layer mounts authorization, its Remote controller, the Models subscription footer, the native Antigravity adapter, provider HTTP compatibility, and FI preferred web search. The footer supports Claude, Codex, Grok, and Antigravity; successful sign-in adopts the model route, while an existing grant can retry setup without another login. Provider compatibility supplies captured request headers and the Grok subscription endpoint without changing ordinary API-key requests. The Preferred web search card selects DeepSeek, Exa, Perplexity, Parallel, Tavily, Serper, Brave Search, or subscription-native search and stores direct-provider keys through Credentials.

The composer Model pane places the four subscription routes under a labeled Subscriptions section below regular providers. Antigravity's catalog provider name is `antigravity`, matching the lowercase route labels; provider and model ids do not change.

The layer also configures one `image_gen` tool with Codex, Grok, and Antigravity targets. Codex is the explicit default; a tool call can select another configured provider, and a failed request never switches providers. The `fi-image-generation` row in `cordis.patch.yml` owns model choices and the default provider. The [image-generation package](../tool-image-generation/README.md) owns reference-image editing, limits, and result behavior. Claude has no native raster-generation target but can call this tool using another signed-in provider.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch document is `cordis.patch.yml`: an `insert` block adds FI-prefixed rows. It replaces the base `web` row's complete configuration with the stable FI router plus the existing `http` fetch provider, and disables the superseded base DeepSeek provider while the FI router owns its existing settings namespace. The FI sign-in client plugin registers its four route ids with the generic model selector's `ctx.modelSubscriptions` service; Cordis injection controls service ordering, and the client-modules plugin includes the declared client package in the browser boot manifest. Upstream bundle documents remain unchanged; removing this layer restores their composition and reads the same stored DeepSeek settings.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-authorization`](../../credentials/authorization/README.md) — the seam this layer mounts.
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

Indirectly, through the mounted [image-generation tool](../tool-image-generation/README.md#model-experience) and unchanged upstream `web_search` tool. Their owning packages retain the schemas and results.

#### KV Cache effect

Adding or removing the layer changes the mounted image tool schema. Search-provider preference does not change the `web_search` schema or prompt.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- FI Desktop mounts this bundle automatically. Other profiles must list it explicitly, and registry installation remains unavailable while the package is private.
- Removing a sign-in keeps the provider's settings route standing; the sign-in card documents why the two are separate actions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The manifest declares every package named by the patch, so installed profile composition resolves the same plugins as a source checkout.

**Runtime invariant:** No companion is published. The layer holds no runtime state: its substance is a patch document, and the seam it mounts owns the attempt lifecycle.

</details>
