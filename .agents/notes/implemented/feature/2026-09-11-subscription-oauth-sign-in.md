# Agent Note: Subscription OAuth sign-in in Models settings

Status: implemented

English | [中文](2026-09-11-subscription-oauth-sign-in.zh.md)

## Problem

The Models page could only collect an API key. A user holding a Claude Pro/Max or ChatGPT Plus/Pro subscription had no way to reach the inference it already pays for, because those providers authenticate through an OAuth grant rather than a typed key. The pieces to do it were already in the tree and inert: the installed pi-ai catalog ships an OAuth login for `anthropic` ("Anthropic (Claude Pro/Max)") and `openai-codex` ("OpenAI (ChatGPT Plus/Pro)"), and `dsh-llm-pi-ai`'s `registerPiAiFlows` already registers one authorization flow per such provider. Nothing consumed them: no bundle mounts `@deepseek-ai/dsh-authorization`, so `ctx.authorization` is absent and every `registerFlow` call finds no seam; no Remote namespace exposes the seam to a browser; and the Models page has no sign-in affordance.

## Decision

Three fi-owned packages, each landing on a seam that already existed, with no upstream package modified.

`@fi/authorization-bundle` is a patch layer whose entire substance is one row mounting `@deepseek-ai/dsh-authorization`. It exists as its own bundle rather than a row in `packages/bundle/base/cordis.patch.yml` so the base patch stays byte-identical to upstream. Ordering needs no manual sequencing: `AuthorizationService` declares `static inject = ['credentials']`, so Cordis parks it until the base layer's `credentials` row resolves. The row is inert — it registers no flow and obtains no credential — which is what makes adding it safe for every profile.

`@fi/api-authorization-controller` owns the `authorization` Remote namespace with `list`, `begin`, `answer`, and `cancel`. `begin` is a `@Remote({ mode: 'stream' })` method: an authorization attempt is a conversation, and the flow's notices, its questions, and its settlement all ride the one carrier the caller opened. Streaming rather than forwarding a Host event preserves the seam's own property that prompts reach exactly the surface that asked — its `AuthorizationInteraction` is supplied per request for that reason — and keeps `API_REMOTE_FORWARDED_EVENTS`, an upstream allowlist, untouched. The stream always ends with exactly one `settled` frame, failures included, so a surface never has to infer a terminal state from a closed carrier. An empty answer is read as the human declining, which is the distinction the seam draws between a refusal (`cancelled`) and a breakage.

`@fi/client-ui-model-signin` registers into `settings.models.provider-card`, the extension slot the Models section already declares for "a plugin distributed outside this repository adds UI to the Models settings section without editing it". The section dispatches it keyed by the row's `settingsNs`, which is `llm-pi-ai` for every pi-ai route, so the card sees those rows and renders only for the ones an OAuth flow is registered for. It offers only the `oauth` method: the Models page already collects an API key as an ordinary field, and a second door to the same room would be a worse page.

## Alternatives considered

**A local HTTP proxy translating to an OpenAI-compatible endpoint.** This is what the public Antigravity and Codex proxies do, but only because their clients can address a model solely through a base URL. This repository has an adapter seam instead, so a proxy would add an unauthenticated open port carrying the user's subscription quota and a second process to supervise, for no capability the adapter path lacks.

**Forwarding `authorization/settled` through `API_REMOTE_FORWARDED_EVENTS`.** The event exists and would report settlement, but it cannot carry the prompt half of the conversation, and the allowlist is an upstream array — editing it is the kind of delta this change is shaped to avoid. The stream carries both halves and needs no allowlist entry.

**Extending `CredentialsController` with the authorization methods.** It is an upstream package, and the two seams are distinct: credentials stores a secret, authorization obtains one. A separate controller keeps the fi delta additive and the namespaces honest.

**Surfacing every registered flow.** The pi-ai catalog registers about forty, nearly all api-key-only. Listing them all would bury the two subscription logins behind rows the Models page already handles better as key fields.

A successful attempt also leaves the provider's settings route behind: when the scope carries a route rule (`llm-pi-ai/<id>` → the `llm-pi-ai` namespace), the controller writes the same empty profile the Models page's own add-provider flow writes, through `settings.mutate` with `expectedRevision` so a concurrent route write wins rather than being clobbered. The settled frame classifies the outcome (`created`, `already`, `skipped`), and a skipped route never demotes the sign-in — the grant is committed first, and the route write is a convenience layered on top of that fact. `remove(key)` is the matching reset: it deletes the record, refuses while an attempt is running, and deliberately preserves the route, because the route is user configuration the Models page already owns deleting. Another adapter family joins by adding one row to the scope-to-namespace map.

Two rules this work pinned down, worth keeping close when adding Remote methods:

- **Method names are wire-reserved against the namespace service.** The client-side `RemoteNamespaceService` (packages/api/gateway/src/client/index.ts) owns an instance method `remove` (unmounts methods). The Remote client refuses any namespace method whose name collides with the namespace service's own API (`assertMethodAvailable`), for ANY namespace. This is a wire-reserved-name rule, not a build-staleness issue — rebuilding never resolves it. The original verb was `remove`; it is `revoke` on the wire (`authorization.revoke(key)`). The client store keeps its public name `remove(key)` as the UI action, but the wire call is `remote.authorization.revoke(key)`.
- **Browser plugins must `$mount` their own Remote contribution.** The app-level api-remotes client catalog mounts only its curated namespace list; nothing installs `remote.authorization` for a browser plugin. Follow the `client-ui-agent-team` pattern — `ctx.remote.$mount(fiAuthorizationRemote)` in `apply()` first, return the disposer, then register the slot. `inject` lists only `['slots', 'locale', 'remote']`.
- **Mounting a namespace does not grant access to it.** Cordis refuses `ctx.remote.authorization` property reads from any fiber that never declared it (`cannot get property "remote.authorization" without inject` — surfaced as a pageerror at client boot, leaving the plugin unmounted and its UI absent). The full pattern is the two-step: `$mount` the contribution in `apply()`, then `ctx.inject(['slots', 'locale', 'remote.authorization'], (scoped) => ...)` and do ALL real work inside that scoped fiber (the agent-team `mountAgentTeamUi` shape). A static `inject` entry for the namespace cannot work — the fiber would park before `apply()` ever mounts the namespace.
- **Registering into a child slot must wait for its declaration.** A children-table slot exists only while the declaring entry (the Models section) is mounted; a sibling plugin that calls `ctx.slots.register` first throws `slot ... is not declared`. Wrap registration in `ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register(...))` — the documented contract in packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:70. It re-runs on owner remount.

## Phase 5 2026-09-11: Antigravity — the second adapter family

The first non-pi-ai adapter proves the seam design holds. `@fi/llm-antigravity` registers the
Antigravity OAuth flow (`fi-antigravity/antigravity`) on the same `ctx.authorization` seam pi-ai
uses, and its transport serves Gemini/Claude models through the paid Cloud Code endpoint. The
Host controller's `ROUTE_NAMESPACE_BY_SCOPE` gains one row (`fi-antigravity` → `llm-pi-ai`), so
an Antigravity grant upserts `providers.antigravity` into the same settings namespace the Models
page manages — the route appears beside pi-ai routes without the page knowing the difference.

The OAuth flow is Google PKCE with the Antigravity desktop app's public client id, loopback
redirect `127.0.0.1:54545/callback` (not `localhost:3000` — browser service workers hijack that
origin), and five scopes including `cloud-platform` and `cclog`. After exchange it discovers the
`cloudaicompanionProject` via `loadCodeAssist`, which becomes the billing project every inference
request names. The transport wraps Gemini `contents`/`generationConfig` in the Cloud Code envelope
(`{project, model, request, userAgent: "antigravity", requestId, requestType: "agent"}`) and POSTs
to `v1internal:streamGenerateContent?alt=sse`.

The Models-page card is `@fi/client-ui-model-signin-antigravity`, a parallel package to the pi-ai
card, registering into the same two slots. The strip offers "Sign in with Antigravity (Gemini Code
Assist)" when the flow is registered and no grant is stored; the row card appears inside any
provider card whose id is `antigravity`.

Stealth is deliberately minimal: the UA string and `ideType: "ANTIGRAVITY"` in discovery are the
only identity claims, both capture-derived. No billing-header fingerprint (Anthropic), no
originator header (Codex), no plan=generic (Grok) — Antigravity's OAuth is standard Google
installed-app flow, and the transport's envelope is the sanctioned shape.

## The key badge 2026-09-11 — investigated and deliberately NOT built

An early pass at the OAuth badge problem parked a marker value (`oauth-grant:<key>`) at the Models
page's derived `<ROUTE>_API_KEY` reference so a signed-in provider's row would stop reading as
missing a key. It was reverted before commit once the upstream dot logic was read to the bottom:
the visible row dot requires a **named** `apiKeyEnv` (`credential?.configured === true` on the
named ref only), and a route with no `apiKeyEnv` shows **no key dot at all** — never a misleading
"missing" one (`credentialMissing` additionally requires `apiKeyEnv !== undefined`). The marker
therefore fed only the slot-seat `keyConfigured` prop, which the sign-in card does not even read,
while creating a genuine hazard: a user or editor that later writes `apiKeyEnv:
<DERIVED_REF>` on the route would resolve the marker as the Bearer token, replacing the grant
with garbage at request time.

The correct endpoint is the one upstream already implements: OAuth rows show no API-key state,
and the sign-in card inside the row carries the truth ("Signed in" / "Not signed in" /
"Remove sign-in"). OAuth genuinely does not use typical API keys or base URLs, and the page is
now silent about them rather than wrong.


## Phase 4 2026-09-11: SuperGrok/X Premium joins with one line

xAI's device-code OAuth ("Sign in with SuperGrok or X Premium") ships in the same installed pi-ai
catalog (`auth/oauth/xai.js`), and `registerPiAiFlows` already registers `llm-pi-ai/xai` like the
other two. The warranted change was therefore exactly the extension point the card documented
from day one: one row in `OFFERED` in the client store. Route semantics needed no change — the
Host's scope-to-namespace rule covers `llm-pi-ai/xai` the same way, and `adopt('llm-pi-ai/xai')`
upserts `providers.xai` and enumerates Grok models through the same `llm.discoverModels` path.
The integration test now asserts all three catalog flows against the installed pi-ai build, so a
pi-ai release that renames or drops the xAI login fails the suite instead of silently trimming
the strip.

## The footer: add a provider with no route yet

The row card needs a provider card to extend, and on a fresh install no pi-ai route exists at all. The Models section reserves a second slot, `settings.models.footer`, for exactly that gap, so a second registration lands the same store and conversation below the provider rows: a one-line "Sign in with your subscription" area that lists Claude Pro/Max and ChatGPT Plus/Pro with the same OAuth buttons, runs the same conversation through the same `AttemptView`, and then chains the Host's `adopt(key)` — upserting the settings route and enumerating the models the route now serves. The store's `signInAndAdopt(key)` folds `begin('oauth')` and the adopt into one intent, gated on the attempt's own `authorized` settlement; `revoke` on the same row re-opens the button. A stored-grant provider reads as subscribed, not adoptable, so the list re-offers only genuinely new providers and the banner keeps the last adoption's evidence. The Models section's own `settings/document-updated` refresh brings the new row in without extra wiring, which is why a successful adoption needs no further UI: the route the user asked for lands in the same section the provider-card rows render.

The host calls that came with the footer — `listAdoptable()` and `adopt(key)` — are the seam's read side of the two halves (which credential scopes carry a settings route, and what an already-signed-in one needs next). `adopt` reads the stored grant rather than re-running OAuth, so the surface needs no second interaction; a flow that only commits a credential and never `revoke`s it adopts idempotently, which is why the same route writes repeat cleanly when the Models section's own `document-updated` refresh re-renders the row.

## Consequences

A composition that lists `@fi/authorization-bundle` after `@deepseek-ai/dsh-base` mounts the seam, and `dsh-llm-pi-ai` then registers its sign-in flows with no further configuration. pi-ai remains the single writer of its own credential records — the flow commits through its own store adapter and the seam confirms the write, so refresh keeps working under the store's cross-process lock, and a stored grant authenticates its route beneath any `apiKeyEnv` override. No secret crosses the new namespace in either direction.

The offered provider list is asserted against the installed pi-ai catalog rather than a fixture, so a pi-ai upgrade that renames a provider or drops its OAuth fails the integration test instead of silently emptying the card. Adding a provider to the card is a one-line change to `OFFERED`, and a flow the Host has not registered simply does not appear.

Two upstream files gain one reference each — `tsconfig.host.json` and `tsconfig.client.json` — because their project lists are explicit. The Typert generator discovers the new packages by workspace scan, so the `authorization` namespace and its client types are generated with no edit to `packages/api/remotes`.
