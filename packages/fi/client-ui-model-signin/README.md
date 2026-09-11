---
description: "The Models-page subscription sign-in card for users reaching Claude Pro/Max, ChatGPT Plus/Pro, and SuperGrok/X Premium inference, and maintainers extending which providers it offers."
kind: "package-reference"
---

# @fi/client-ui-model-signin

English | [中文](README.zh.md)

## Summary

`@fi/client-ui-model-signin` adds OAuth sign-in to the Models settings page for providers whose value is a subscription the user already holds — Claude Pro/Max, ChatGPT Plus/Pro, and SuperGrok/X Premium. It renders inside each pi-ai provider card through the Models section's own extension slot, so the section is not modified. A row appears only when the Host has actually registered an OAuth flow for that provider, which makes the offer self-correcting: a composition without the adapter, or a pi-ai release that drops a login, simply shows nothing. Choose the API-key field when the provider authenticates with a key instead.

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

Each pi-ai provider card with a registered OAuth flow gains a sign-in row: a state dot with an accessible label, and a button carrying the flow's own label ("Anthropic (Claude Pro/Max)", "OpenAI (ChatGPT Plus/Pro)", "Sign in with SuperGrok or X Premium"). Starting one replaces the button with the live conversation — the page to open, the device code to type, any question the flow asks — and ends in a terminal message the user dismisses. A successful sign-in also writes the provider's settings route when none exists, so the card reports what the attempt left behind. A provider already signed in still offers a re-sign-in, which is how an expired refresh token is replaced, and a **Remove sign-in** action, which revokes the stored grant (Host verb `revoke`, the Remote client's namespace service owning `remove`) and returns the row to sign-in-offered without touching the route.

### The footer: add a provider with no route yet

The row card needs a provider card to extend, and on a fresh install no pi-ai route exists at all. The Models section has a second slot, `settings.models.footer`, for exactly that gap: a one-line "Sign in with your subscription" area that lists Claude Pro/Max, ChatGPT Plus/Pro, and SuperGrok/X Premium with the same OAuth buttons, runs the same conversation, and then chains the Host's `adopt(key)` — upserting the settings route and reading back the models it now serves. The adoption banner reports the route outcome (created or already present) and lists every model id the selected provider makes available, in the installed catalog's order; the Models section's own `settings/document-updated` refresh brings the new row in beside the rows the page already managed.

A stored-grant provider (an earlier sign-in finished) reads as subscribed rather than adoptable, so the footer list re-grows only when a second provider is added, while its own seat's adopt banner stays the evidence of the last adoption.

### Offering another provider

`OFFERED` in `src/client/store.ts` is the list and the order. Adding an entry is one line; a provider the Host has not registered is skipped, so the list is advisory rather than authoritative. Only the `oauth` method is ever offered — the Models page already collects an API key as an ordinary field, and a second door to the same room would be a worse page.

<a id="understand-the-implementation"></a>
## Understand the implementation

Registration goes through `settings.models.provider-card`, the keyed slot the Models section declares for plugins distributed outside its own package. The section dispatches it with `entryKey` set to the row's settings namespace, which is `llm-pi-ai` for every route the pi-ai adapter family owns, so this plugin registers once under that key and receives every pi-ai card — shipped, added, and hand-declared alike.

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

The card reloads its rows on credential invalidations and after its own attempts, so an attempt run in a second tab updates this one only on the next such refresh.

<a id="dev-note"></a>
### Dev Note

The card's tests drive it over a scripted store rather than a live carrier, and the ordering rules live in `applyFrame` precisely so they can be asserted that way.

**Runtime invariant:** No companion is published. The Host is the single fact source; the card's state is rebuilt from `list` and from the frames of the attempt it started.
