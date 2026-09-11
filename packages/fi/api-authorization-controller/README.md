---
description: "The authorization Remote namespace for maintainers building a configuration surface that signs a human in to a provider."
kind: "package-reference"
---

# @fi/api-authorization-controller

English | [中文](README.zh.md)

## Summary

`@fi/api-authorization-controller` owns the `authorization` Remote namespace: a browser configuration page lists what can be signed into, runs one attempt, answers the questions it asks, and cancels it. An attempt is a conversation, so `begin` is a stream carrying the flow's notices, prompts, and settlement on the carrier the page opened. No secret crosses the namespace in either direction. It requires the authorization seam; without it every method refuses with a diagnostic naming the missing composition row.

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

Mount it in a composition that already mounts `@deepseek-ai/dsh-authorization` — [`@fi/authorization-bundle`](../authorization-bundle/README.md) does both. A browser plugin then declares `remote.authorization` in its own `inject` and drives the four methods.

### List what can be signed into

```ts
const response = await ctx.remote.authorization.list()
// [{ key: 'llm-pi-ai/anthropic', label: 'Anthropic',
//    methods: [{ id: 'oauth', label: 'Anthropic (Claude Pro/Max)' }],
//    inFlight: false, stored: true }]
```

`stored` joins the credential seam, so a page renders "signed in" without a second round trip. `inFlight` is true while any surface holds the key — the seam refuses a second concurrent attempt rather than joining it, because the two would be prompting different humans through the same flow.

### Run one attempt

```ts
for await (const frame of ctx.remote.authorization.begin({ key, method: 'oauth' }, signal)) {
  if (frame.kind === 'notice') show(frame.message, frame.url, frame.code)
  if (frame.kind === 'prompt') await ctx.remote.authorization.answer(key, frame.id, await ask(frame.prompt))
  if (frame.kind === 'withdraw') retire(frame.id)
  if (frame.kind === 'settled') finish(frame.status, frame.message)
}
```

The stream always ends with exactly one `settled` frame, failures included, so a surface renders a terminal state from the frame rather than inferring it from a closed carrier — a dropped connection and a refused login never look alike.

### Answer, decline, and cancel

`answer` with the empty string means the human declined; the attempt settles `cancelled`, which is the seam's own distinction between a refusal and a breakage. `cancel` withdraws the attempt from a second call, because a Cancel button has no handle on the first call's carrier. A `withdraw` frame retires one question the flow itself gave up on (the losing side of a race) and leaves the attempt running.

### The route a sign-in leaves behind

A successful attempt for a `llm-pi-ai/<id>` key also ensures the provider exists in settings: when `providers.<id>` is absent from the `llm-pi-ai` namespace, the controller writes the same empty profile the Models page's own add-provider flow writes, so the sign-in ends with a working route and not only a stored grant. The settled frame reports the outcome as `route` — `created`, `already` when a route existed (its configuration is never touched), or `skipped` when no settings service could commit one, in which case the grant is still stored and the Models page remains the explicit path. One constant maps scope to namespace — `llm-pi-ai` routes into pi-ai's catalog namespace, `fi-antigravity` into the Antigravity adapter's own — a scope with no entry signs in without touching settings, and the next adapter family extends the map as its own row.

### Remove: the sign-in reset

`revoke(key)` deletes one stored credential record — the reset that makes an expired or broken grant sign-in-able again. The settings route is deliberately untouched: it is user configuration, and the Models page already owns deleting it. `revoke` refuses while an attempt for the key is running, since deleting the record beneath a live flow would settle it into a lie. (The verb is not `remove`: the client-side namespace service owns an instance method by that name, and the Remote client refuses colliding method names.)

### Adopt: route after sign-in

`listAdoptable()` answers the credential scopes a sign-in can adopt into a settings route, so a surface can offer "add this provider" for every installed subscription login; today it is the pi-ai catalog's OAuth flows. `adopt(key)` performs the rest of one finished sign-in: it reads the stored grant (refusing `authorization/no-grant` when the record is absent), writes the scope's settings route if one is absent, and enumerates the models the route then serves. The route upsert is the same `settings.mutate(expectedRevision)` the Models page's own add flow uses, so a concurrent user edit wins, never gets clobbered. The model list comes from the mounted `llm` service's `discoverModels` with `{ provider: <id> }` — for a catalog provider this answers from pi-ai's own registry, without a network call. If no settings or llm service is mounted the grant stays stored and the Models page remains the explicit path; the call reports `authorization/adopt-blocked` rather than pretend the route worked.

<a id="understand-the-implementation"></a>
## Understand the implementation

The controller carries the wire obligations the seam does not. A wire key is `<scope>/<id>`, each half the lowercase hyphenated identifier the credential grammar requires; it is parsed and re-branded here so a browser string never reaches the seam unchecked. Views are projected field by field, so a provider answer carrying extra enumerable properties does not serialize them onward.

`Attempt` is the buffer between the seam's push model and the stream's pull model: a flow calls `notify` whenever it likes, while the carrier reads on demand. It also holds the questions waiting on a browser answer, keyed by a per-attempt id. A prompt withdrawn by its own signal rejects with `authorization/withdrawn` rather than a decline, because the seam reads a decline as the human saying no and a later genuine failure would be misread.

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-authorization`](../../credentials/authorization/README.md) — the seam this namespace exposes.
- [`@fi/client-ui-model-signin`](../client-ui-model-signin/README.md) — the Models-page surface that consumes it.
- [Agent Note: Subscription OAuth sign-in in Models settings](../../../.agents/notes/implemented/feature/2026-09-11-subscription-oauth-sign-in.md)

<a id="model-experience"></a>
## Model Experience

None, as the package serves configuration-surface calls and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

An attempt is bound to the carrier that opened it, so a page reloaded mid-sign-in loses the conversation and must start again; the grant is unaffected if the flow already committed it. A second surface watching a key it did not start learns only that the key is `inFlight`, and sees the settlement on its next `list` — the seam's `authorization/settled` event is not forwarded, because the application's forwarded-event allowlist is an upstream file this package deliberately leaves alone.

<a id="dev-note"></a>
### Dev Note

The integration test asserts against the installed pi-ai catalog rather than a fixture, so a pi-ai upgrade that renames a provider or drops its OAuth fails here instead of silently emptying the sign-in card.

**Runtime invariant:** No companion is published. The seam owns one attempt per key, and this controller's per-attempt buffer is created and ended inside that attempt's own stream.
