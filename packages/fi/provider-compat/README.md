---
description: "Canonical auth2api provider metadata and subscription-only Codex WebSocket, Claude, and Grok HTTP transports for FI maintainers."
kind: "package-reference"
---

# @fi/provider-compat

English | [中文](README.zh.md)

## Summary

`@fi/provider-compat` keeps FI's four provider metadata records, captured wire fingerprints, OAuth settings, and release provenance synchronized with auth2api. It applies Codex, Claude Code, and Grok CLI request headers only after pi-ai resolves a stored subscription OAuth grant. Explicit profile keys and ordinary stored or ambient API keys remain on their normal endpoints. Grok subscription inference uses the CLI Responses endpoint; unrelated requests pass through unchanged.

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

Mount the plugin after `@deepseek-ai/dsh-llm-pi-ai`. Codex uses WebSocket-first `auto` by default; explicit `sse`, `websocket`, and `websocket-cached` profile choices retain pi-ai's transport semantics. The optional `websocketMaxPayloadBytes` configuration limits each received WebSocket message to a positive integer number of bytes; its default is 104857600 (100 MiB).

```yaml
- - '@fi/provider-compat'
```

Direct subscription HTTP clients first call pi-ai `Models.getAuth(provider)`, require `source === 'OAuth'`, and freeze that result for the request. `authorizationHeaders(auth)` keeps string-valued supplied headers and adds `Authorization: Bearer <auth.apiKey>` only when authorization is absent. Clients then call `subscriptionEndpoint(provider)` and `subscriptionHeaders(provider, model, sessionId, timeoutMs, existingHeaders)`; callers must never log the authorization record. For Anthropic, compatibility headers retain pi-ai's request-specific beta features alongside the captured Claude Code beta set and map `mid-conversation-output-config-2026-07-01` to Claude Code's `per-turn-control-2026-07-01` wire name.

### Synchronize an existing canonical snapshot

The import command accepts an explicit source so FI does not depend on a sibling checkout path.

```sh
node scripts/fi-provider-settings-sync.mjs --updater ../auth2api/tools/update-provider-settings.mjs --settings ../auth2api/src/provider-settings.json
```

Add `--check` for a read-only freshness check. The command rejects credential fields, preserves all accepted metadata, copies the updater byte-for-byte into `scripts/vendor/auth2api/`, and records the source repository, commit, dirty-baseline status, and exact hashes. This is the only path that replaces the vendored updater.

### Check or apply public release updates

The update command imports auth2api's updater module instead of copying its release logic.

```sh
node scripts/fi-provider-settings-update.mjs --check
```

Remove `--check` to atomically update FI's snapshot with the provenance-pinned vendored updater. The daily [FI provider settings workflow](../../../.github/workflows/fi-provider-settings-update.yml) opens or updates a review when public metadata changes. A newer public release does not advance `fingerprintCapturedVersion`; a fresh redacted capture remains a separate review action.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The adapter resolves one authoritative OAuth result and freezes its access token for dispatch. HTTP wrappers verify the final bearer value before adding metadata or rewriting the Grok endpoint. Codex's request-scoped WebSocket factory verifies and snapshots final authenticated headers before cache lookup, preserving provider User-Agent, version, originator, account, beta, session, and request identifiers. Harness attribution uses a separate header.

Each plugin instance owns a stable connector. The patched pi-ai cache partitions connections and fallback state by endpoint, authenticated headers, proxy URL, and connector identity. Changed credentials or metadata cannot reuse a prior connection. Default `auto` and `websocket-cached` retain incremental context reuse; explicit `websocket` sends full context. Network handshake failures retain pi-ai's authenticated SSE fallback; invalid authentication or endpoint preparation fails before either transport can dispatch.

The maintained `ws` connector uses pi-ai's existing HTTP/HTTPS/ALL_PROXY and NO_PROXY resolution, including provider environment overrides, and a maintained HTTPS proxy agent. It disables redirects and compression, enforces the configured message bound, and preserves SDK connect timeout and request cancellation. Plugin disposal retires only its connector's cache and fallback entries, terminates pending and open sockets, and awaits closure. Already dispatched HTTP requests remain owned by their caller's request signal.

The [pinned patch provenance](pi-ai-patch.provenance.json) records the npm version, integrity, pristine dist-file hashes, patch hash, and retirement condition. The patch adds no Node imports to pi-ai and leaves its factory-absent constructor path unchanged. The generated metadata and vendored updater remain byte-stable auth2api projections; release updates never imply a new fingerprint capture.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [`@deepseek-ai/dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.md) — model catalog, authentication, and streaming ownership.
- [`@fi/llm-antigravity`](../llm-antigravity/README.md) — Antigravity's native adapter and OAuth flow.
- [Provider settings snapshot](src/provider-settings.json) — generated metadata and release provenance.
- [Updater provenance](../../../scripts/vendor/auth2api/provenance.json) — exact auth2api source and vendored-byte hashes.
- [Official Codex WebSocket protocol constant](https://github.com/openai/codex/blob/main/codex-rs/core/src/client.rs) — primary source for the canonically recorded WebSocket beta.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package changes transport routing and provider-required headers without adding model-visible input.

#### KV Cache effect

None, as request content and model parameters are unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- WebSocket compatibility requires the pinned pi-ai patch and the server-side `ws` connector. No latency or throughput improvement is guaranteed; performance depends on the network and provider.
- pi-ai does not expose its built-in OAuth scopes through a public runtime API, so automatic scope-drift diagnostics cover canonical metadata but cannot compare private SDK constants.
- Release automation updates public release fields and provenance. Capture-gated runtime headers remain at their recorded version until a separate fingerprint capture is reviewed and recorded canonically.

<a id="dev-note"></a>
### Dev Note

**Runtime invariant:** No companion is published because authorization guards apply to transient dispatches; the SDK owns connection/cache state, while the plugin disposes its connector and sockets through its context lifetime.
