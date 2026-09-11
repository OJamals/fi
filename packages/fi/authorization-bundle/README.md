---
description: "The fi bundle layer that adds provider subscription sign-ins to a dsh --profile surface, for users composing or customizing a profile."
kind: "package-bundle"
---

# @fi/authorization-bundle

English | [中文](README.zh.md)

## Summary

`@fi/authorization-bundle` adds subscription sign-in to any base-backed `dsh --profile` surface: it mounts the authorization seam, its Remote namespace, and a sign-in card inside the Models settings page, so users holding a Claude Pro/Max, ChatGPT Plus/Pro, or SuperGrok/X Premium subscription reach the inference they already pay for. No profile ships with it — a profile that wants the sign-ins lists it after `@deepseek-ai/dsh-base`. The layer is inert until a sign-in runs: it registers no model route and obtains no credential by itself. It is not a library to import.

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

A profile that already names `@deepseek-ai/dsh-base` gains the sign-ins by listing this layer after it:

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

Three rows enter the composition. `@deepseek-ai/dsh-authorization` mounts `ctx.authorization`, the seam plugin sign-in flows register with. `@fi/api-authorization-controller` owns the `authorization` Remote namespace, so a browser surface can list flows, run an attempt, answer its questions, and cancel it; after a successful sign-in it offers `adopt(key)` to upsert the absent settings route and enumerate the models the route then serves. `@fi/client-ui-model-signin` adds the sign-in row to every Models provider card whose provider has a registered OAuth flow — Claude Pro/Max, ChatGPT Plus/Pro, and SuperGrok/X Premium today, per the pi-ai catalog — with the flow's notices, device codes, and prompts rendered live, and its **footer card** offers those providers even when no route for them exists yet, so a click runs the whole chain (sign-in, then adopt). A grant a flow commits authenticates that provider's route under the ordinary settings the Models page already manages.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch document is `cordis.patch.yml`: one row for the seam, plus an `insert` block for the Remote owner and the browser card. Row ids are prefixed `fi-`, following the repository's convention for fi-owned rows. Ordering needs no manual sequencing: `AuthorizationService` declares `static inject = ['credentials']`, so Cordis holds it until the base layer's `credentials` row resolves. The browser row is a `dsh.client` package, so the client-modules node half scans it into `window.__DSH_BOOT__` like any upstream browser plugin.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-authorization`](../../credentials/authorization/README.md) — the seam this layer mounts.
- [`@fi/api-authorization-controller`](../api-authorization-controller/README.md) — the Remote namespace that drives the seam from a browser.
- [`@fi/client-ui-model-signin`](../client-ui-model-signin/README.md) — the Models-page card this layer ships.
- [Agent Note: Subscription OAuth sign-in in Models settings](../../../.agents/notes/implemented/feature/2026-09-11-subscription-oauth-sign-in.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a composition patch document that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A profile must list this bundle explicitly; there is no automatic mounting. That is deliberate while the delta stays additive, but a composition that adds a sign-in-capable plugin and forgets this layer gets no sign-in and no diagnostic — the flows simply never register.
- Removing a sign-in keeps the provider's settings route standing; the sign-in card documents why the two are separate actions.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The tests assert the patch stays one well-formed row plus the `insert` block, that the manifest publishes it, and that the parked-until-credentials behavior holds, because a typo in any of these mounts nothing silently.

**Runtime invariant:** No companion is published. The layer holds no runtime state: its substance is a patch document, and the seam it mounts owns the attempt lifecycle.

</details>
