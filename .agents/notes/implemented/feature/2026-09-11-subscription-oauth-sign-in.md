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

## Consequences

A composition that lists `@fi/authorization-bundle` after `@deepseek-ai/dsh-base` mounts the seam, and `dsh-llm-pi-ai` then registers its sign-in flows with no further configuration. pi-ai remains the single writer of its own credential records — the flow commits through its own store adapter and the seam confirms the write, so refresh keeps working under the store's cross-process lock, and a stored grant authenticates its route beneath any `apiKeyEnv` override. No secret crosses the new namespace in either direction.

The offered provider list is asserted against the installed pi-ai catalog rather than a fixture, so a pi-ai upgrade that renames a provider or drops its OAuth fails the integration test instead of silently emptying the card. Adding a provider to the card is a one-line change to `OFFERED`, and a flow the Host has not registered simply does not appear.

Two upstream files gain one reference each — `tsconfig.host.json` and `tsconfig.client.json` — because their project lists are explicit. The Typert generator discovers the new packages by workspace scan, so the `authorization` namespace and its client types are generated with no edit to `packages/api/remotes`.
