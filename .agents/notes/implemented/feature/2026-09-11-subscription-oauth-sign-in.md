# Agent Note: Subscription OAuth sign-in in Models settings

Status: implemented

English | [中文](2026-09-11-subscription-oauth-sign-in.zh.md)

## Problem

Subscription accounts require interactive authorization and stored grants, while the generic Models editor configures API-key routes. Sign-in, route setup, and recovery need one interface without moving provider authentication into the agent loop or changing durable Session data.

## Decision

Subscription sign-in uses the existing authorization, credential, settings, and LLM services. The [FI authorization bundle](../../../../packages/fi/authorization-bundle/README.md) composes FI-owned plugins after the upstream base bundle. The base bundle, agent loop, released Session formats, and SDK projections retain their upstream behavior.

The [authorization controller](../../../../packages/fi/api-authorization-controller/README.md) owns its Remote namespace separately from credential storage. Each `begin` stream carries the initiating caller's notices, questions, and one settlement. Unary methods return the Remote result envelope; clients inspect `ok` before reading values. The wire method is `revoke`, because `remove` is reserved by the Remote namespace service.

The [sign-in interface](../../../../packages/fi/client-ui-model-signin/README.md) occupies one Models footer. Claude, Codex, Grok, and Antigravity share the same interaction state. The Models page places configured routes for offered OAuth flows without `apiKeyEnv` below the sign-in controls; API-key profiles remain in the main list. Both locations retain one route editor and deletion flow. Product copy belongs to typed locale dictionaries, and controls use the application theme tokens and responsive layout.

FI packages remain a private workspace group rather than becoming upstream npm release members merely because they live under `packages/`. Their explicit namespace and privacy checks prevent accidental publication while retaining ordinary package, artifact, and upstream release validation.

## Consequences

pi-ai owns its OAuth records and serialized refresh. The [Antigravity adapter](../../../../packages/fi/llm-antigravity/README.md) owns the `fi-antigravity` settings namespace, its scoped grant, and project discovery. Its persisted-record parser accepts documented historical project-key spellings; refresh rechecks the record inside credential storage's serialized modification.

Authorization commits the grant independently of route adoption. Adoption writes an absent route with an expected settings revision and preserves concurrent edits. Model-discovery failure reports a redacted, retryable error without deleting the grant or route. A signed-in account can retry setup without repeating OAuth. Revocation deletes the grant but retains user-owned model configuration.

The interface distinguishes a running operation from a settled attempt. Operation identities prevent delayed answers, cancellation errors, and adoption results from affecting a later attempt. Load generations prevent stale or post-disposal reads from publishing. Refreshes invalidate obsolete adoption banners, and failures remain visible with a recovery action.

## Composition and lifecycle

The client mounts its own Remote contribution, then injects the mounted namespace in a scoped fiber. Slot registrations wait for their declaring owner and return disposers. The offered OAuth route list is published through the Models page's subscription registry and disposed with the client fiber; absent flows cannot move configured rows. Credential-record changes reach the browser through the existing Remote event allowlist; API-key reference changes are a different event and cannot represent OAuth revocation.

The installed pi-ai catalog supplies the Claude, Codex, and Grok login flows. The Antigravity plugin registers its own flow on the same authorization service. Missing services or unknown routes fail explicitly rather than creating credentials or substituting another provider.

## Alternatives considered

A local compatibility proxy would add a listening port and another process despite the existing native adapter service. The implementation therefore uses native adapters. Expanding the credential controller would mix obtaining grants with storing them; the separate authorization controller preserves those responsibilities.

Sign-in conversations use a caller-owned stream rather than broadcast authorization events, because questions and replies belong to one initiating caller. The Models footer lists supported subscription flows instead of duplicating the generic API-key editor.

OAuth status never uses a fabricated API-key marker. Such a marker can become a Bearer token if a route later names that reference. Routes without `apiKeyEnv` rely on their adapter's credential owner and do not imply a missing API key.

Codex uses a request-scoped WebSocket factory because the installed SDK overwrites caller-supplied handshake identity after its ordinary header transform. A pinned dependency patch exposes final handshake preparation without replacing global networking or changing callers that omit the extension. FI retains WebSocket-first automatic selection, explicit transport settings, and HTTP fallback; connection reuse separates credentials, endpoint, metadata, proxy, and connector ownership. The plugin disposes only its own connections. The patch can be retired when the maintained SDK supplies equivalent request-scoped behavior.

## Required verification

Provider compatibility belongs to FI's [transport metadata plugin](../../../../packages/fi/provider-compat/README.md), through an optional pi-ai adapter extension, rather than the shared LLM or agent-loop interfaces. Authentication remains owned by the installed credential implementation; a subscription transport cannot substitute an ambient API key or redirect a request to an arbitrary destination. Antigravity stores native signature metadata in the existing adapter-private replay envelope. Files retain the upstream request-assembly projection to read-only handles, while image bytes use the attachment service.

The [native search provider](../../../../packages/fi/web-search-subscription/README.md) is separately selected through the existing web service. It requires native search completion and citation evidence because model-generated answer text alone does not establish that a search occurred. The existing web tool owns logging and presentation; default provider selection is unchanged.

auth2api owns release-discovery logic and protocol captures. FI synchronizes exact updater bytes and records their provenance rather than maintaining a second implementation. Public release discovery cannot prove a changed protocol fingerprint, so capture-gated settings advance only with reviewed artifact or request evidence. Scheduled updates propose metadata changes for review instead of installing unverified runtime fingerprints.

Focused Host tests cover installed login-flow registration, route concurrency, retryable discovery errors, and credential ownership. Client tests cover unary errors, operation replacement, disposal, recovery, and localized controls. Provider transport tests cover replay and attachment handling through existing LLM interfaces. Composition checks cover plugin registration and disposal; rendered browser checks establish responsive layout and interaction behavior independently of component assertions.
