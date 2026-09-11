---
description: "The Models-page subscription sign-in card for users reaching Claude Pro/Max, ChatGPT Plus/Pro, and SuperGrok/X Premium inference, and maintainers extending which providers it offers."
kind: "package-reference"
---

# @fi/client-ui-model-signin

English | [中文](README.zh.md)

## Summary

`@fi/client-ui-model-signin` adds one subscription sign-in section to the Models settings page for providers whose value is a subscription the user already holds — Claude Pro/Max, ChatGPT Plus/Pro, SuperGrok/X Premium, and Antigravity. It renders through the Models section's own footer extension slot, so the section is not modified. A row appears only when the Host has actually registered an OAuth flow for that provider, which makes the offer self-correcting: a composition without the adapter, or a pi-ai release that drops a login, simply shows nothing. Choose the API-key field when the provider authenticates with a key instead.

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

One "Sign in with your subscription" section below the Models page's provider rows lists every subscription provider the Host registered — Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro), xAI (SuperGrok/X Premium), and Antigravity — each with a state dot and an accessible state label. An unsigned provider offers **Add**; clicking it runs the whole chain: the flow's live conversation (the page to open, the device code to type, any question the flow asks), then the Host's `adopt(key)`, which upserts the provider's settings route and reads back the models it now serves. The adoption banner reports the route outcome (created or already present) and lists every model id, in the installed catalog's order; the Models section's own `settings/document-updated` refresh brings the new route row in beside the rows the page already managed.

A signed-in provider shows its state in the same row and offers two actions: **Sign in again**, which is how an expired refresh token is replaced (the adopt chain answers `already` for the standing route), and **Remove sign-in**, which revokes the stored grant (Host verb `revoke`, the Remote client's namespace service owning `remove`) and turns the row back into an Add offer without touching the route. The section refreshes on `credentials/record-updated` as well as `credentials/reference-updated`, so a grant deleted anywhere — this section, another tab, a CLI — re-offers the sign-in instead of leaving a dead row. Two failure-semantics rules keep the surface honest: starting any attempt clears the previous provider's adoption banner (it would otherwise read as the new attempt's outcome), and a failed adopt replaces the banner with an inline error naming the Host's diagnostic rather than leaving the earlier list behind.

This section is the only sign-in surface: the provider rows in the Models list stay plain route rows, with no credential UI interleaved.

### Offering another provider

`OFFERED` in `src/client/store.ts` is the list and the order. Adding an entry is one line; a provider the Host has not registered is skipped, so the list is advisory rather than authoritative. Only the `oauth` method is ever offered — the Models page already collects an API key as an ordinary field, and a second door to the same room would be a worse page.

<a id="understand-the-implementation"></a>
## Understand the implementation

Registration goes through `settings.models.footer`, the slot the Models section declares for plugins distributed outside its own package. The section's row set is the package's `OFFERED` whitelist joined to the Host's registered flows, so Antigravity renders in the same section despite living outside pi-ai's catalog, and the adoptable join comes from `listAdoptable`, whose scope→route map both adapter families share.

The store holds one attempt at a time and folds each stream frame into it. `applyFrame` is a pure function over that state, which is what makes the conversation's ordering rules testable without a carrier: a `withdraw` retires only the question currently on screen, and a settlement always clears any question still showing. No secret is held in this state — a typed answer goes straight back out over `answer` and the draft is dropped.

<a id="further-exploration"></a>
## Further Exploration

- [`@fi/api-authorization-controller`](../api-authorization-controller/README.md) — the Remote namespace this card drives.
- [`@deepseek-ai/dsh-client-ui-settings-models`](../../client/ui-settings-models/README.md) — the page it extends, and the slot contract it registers into.
- [Agent Note: Subscription OAuth sign-in in Models settings](../../../.agents/notes/implemented/feature/2026-09-11-subscription-oauth-sign-in.md)

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Revoking a sign-in deletes the grant but leaves the settings route standing; deleting the route is the Models page's own action, and the two are kept apart deliberately so an expired-token reset never rewrites provider configuration.

The section reloads its rows on credential invalidations (`reference-updated` for keys, `record-updated` for grants) and after its own attempts; an OAuth completion in a second tab announces itself through the same record event.

<a id="dev-note"></a>
### Dev Note

The card's tests drive it over a scripted store rather than a live carrier, and the ordering rules live in `applyFrame` precisely so they can be asserted that way.

**Runtime invariant:** No companion is published. The Host is the single fact source; the card's state is rebuilt from `list` and from the frames of the attempt it started.
