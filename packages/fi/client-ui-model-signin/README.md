---
description: "The Models-page subscription sign-in section for users reaching Claude Pro/Max, ChatGPT Plus/Pro, and SuperGrok/X Premium inference, and maintainers extending which providers it offers."
kind: "package-reference"
---

# @fi/client-ui-model-signin

English | [中文](README.zh.md)

## Summary

`@fi/client-ui-model-signin` adds one subscription sign-in section to the Models settings page for providers whose value is a subscription the user already holds — Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok/X Premium, and Antigravity. It renders through the Models section's footer extension slot. A compact selector lists only providers for which the Host has registered an OAuth flow, so a composition without an adapter simply omits it. Choose the API-key field when the provider authenticates with a key instead.

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

Mount it in a browser composition that also mounts the Models page and [`@fi/api-authorization-controller`](../api-authorization-controller/README.md); [`@fi/authorization-bundle`](../authorization-bundle/README.md) composes all of it.

### What the user sees

One "Sign in with your subscription" section below the Models page's API-key provider rows presents a compact, accessible provider selector for Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), xAI (SuperGrok/X Premium), and Antigravity. Configured keyless routes for offered OAuth flows appear below those sign-in controls, with their edit and delete actions; a profile with `apiKeyEnv` stays in the main Models list. The selector has a bounded width beside an unsigned provider's state and action; signed-in management actions take a full row beneath it. On narrow screens the controls stack without horizontal scrolling. The selected provider shows its state dot, accessible state label, and only its available actions. An unsigned provider offers **Add provider**; clicking it runs the live sign-in conversation and then the Host's `adopt(key)`, which upserts the provider's settings entry and reads back its models. A stored grant offers **Set up provider**, so a provider that has already authorized can complete or retry setup without another OAuth round trip. The adoption result reports the entry outcome and keeps its model list behind a disclosure.

A signed-in provider shows **Sign in again**, which replaces an expired refresh token, and **Remove sign-in**, which revokes the stored grant without touching its settings entry. The selector only changes the visible provider; it never starts authentication or changes inference selection. An unfinished local authorization or adoption disables the selector. A live sign-in conversation names its provider, while a completed adoption selects its provider and shows that result. The section refreshes on `credentials/record-updated` and `credentials/reference-updated`, so a grant deleted anywhere re-offers sign-in. It renders loading and failed list states with retry, checks every unary Remote reply, and preserves a rejected action's diagnostic. Starting an operation clears an earlier adoption banner, while an operation identity prevents a dismissed or superseded sign-in from publishing a late adoption result.

This section is the only sign-in surface: provider rows in either location stay plain route rows, with no credential UI interleaved. Antigravity's native **Add provider** editor only adopts an already-stored grant; without one, it directs the person back to this section rather than opening another sign-in conversation.

### Offering another provider

`SUBSCRIPTION_PROVIDER_IDS` in `src/client/store.ts` owns the route ids and order; `OFFERED` derives their credential keys. A provider the Host has not registered is skipped. The joined offered rows register through `ctx.modelSettingsSubscriptions`, so the Models page groups only available OAuth routes and restores their rows to the main list if a flow disappears. When the generic model selector is mounted, this plugin registers the static ids with its `ctx.modelSubscriptions` service, placing available subscription model groups in a labeled bottom section without changing selection or authentication. Only the `oauth` method is offered; the Models page collects API keys separately.

<a id="understand-the-implementation"></a>
## Understand the implementation

Registration goes through `settings.models.footer` and the keyed `settings.models.provider-editor` slot. The latter replaces only Antigravity's generic editor and shares the footer's store, so it can adopt a stored grant without duplicating a sign-in flow. The section's row set is the package's `OFFERED` whitelist joined to the Host's registered flows, so Antigravity renders in the same section despite living outside pi-ai's catalog, and the adoptable join comes from `listAdoptable`, whose scope→route map both adapter families share. The footer keeps selection locally, derives the active provider from an unfinished attempt, and falls back to the first remaining provider after an external refresh removes the selection.

The store holds one attempt at a time and folds each stream frame into it. `applyFrame` is pure over that state: a `withdraw` retires only the question currently on screen, and a settlement clears any question still showing. Each sign-in, adoption, and removal has an operation identity, so a late Remote response cannot alter a newer snapshot. No secret is held in this state — a typed answer goes straight back out over `answer` and the draft is dropped.

<a id="further-exploration"></a>
## Further Exploration

- [`@fi/api-authorization-controller`](../api-authorization-controller/README.md) — the Remote namespace this card drives.
- [`@deepseek-ai/dsh-client-ui-settings-models`](../../client/ui-settings-models/README.md) — the page it extends, and the slot contract it registers into.
- [`@deepseek-ai/dsh-client-ui-model-selection`](../../client/ui-model-selection/README.md) — the display-only subscription grouping it contributes to.
- [Agent Note: Subscription OAuth sign-in in Models settings](../../../.agents/notes/implemented/feature/2026-09-11-subscription-oauth-sign-in.md)
- [Agent Note: Subscription providers in the composer model picker](../../../.agents/notes/implemented/feature/2026-09-15-subscription-model-picker-section.md)

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Revoking a sign-in deletes the grant but leaves the settings entry standing; deleting that entry is the Models page's own action, so an expired-token reset does not rewrite provider configuration.

- The section reloads its rows on credential invalidations (`reference-updated` for keys and `record-updated` for grants) and after its own operations; an OAuth completion in a second tab announces itself through the same record event.

<a id="dev-note"></a>
### Dev Note

The tests use scripted Remote replies, including a manually released adoption response, to cover response failures and superseded asynchronous work.

**Runtime invariant:** No companion is published. The Host is the single fact source; the card's state is rebuilt from `list` and from the frames of the attempt it started.
