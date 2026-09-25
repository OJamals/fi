---
description: "Opt-in native web search through stored Codex, Grok, Antigravity, or Claude subscription OAuth, with provider citations and bounded responses."
kind: "package-reference"
---

# @fi/web-search-subscription

English | [中文](README.zh.md)

## Summary

Use this package to search the web through an existing Codex, Grok, Antigravity, or Claude subscription login. Every mount selects one provider family and one model explicitly. A result succeeds only when the provider reports a completed native search and supplies native citation URLs; generated text without that evidence fails. OAuth is refreshed through its owning credential adapter and frozen for one request.

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

Mount the web and credential services, select `subscription-native`, and mount this package with an explicit provider and model. The package is not part of a base bundle and never chooses an account, provider, or model automatically.

### When to choose it

Choose this package when the deployment already stores subscription OAuth through `dsh-llm-pi-ai` or `@fi/llm-antigravity` and must use that provider's native search result format. Choose an API-key search provider when the deployment does not have a supported subscription grant or needs a vendor control that this package cannot represent.

### Minimal configuration

This example uses a stored Codex OAuth grant. Replace both required values to mount a different supported family.

```yaml
- name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: subscription-native
- name: '@fi/web-search-subscription'
  config:
    provider: codex
    model: gpt-5.6-sol
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | required | `codex`, `grok`, `antigravity`, or `claude`; no implicit selection |
| `model` | required | Exact model id sent to the selected native endpoint |
| `timeoutMs` | `30000` | Whole-operation timeout; integer from 1 through 120000 milliseconds |
| `maxResponseBytes` | `2097152` | Maximum retained response bytes; integer from 1 through 16777216 |
| `maxUses` | `5` | Native search-use ceiling; integer from 1 through 10 |
| `maxOutputTokens` | `512` | Generated-answer token request; integer from 1 through 8192 |

The generated [configuration catalog](../../../docs/config-catalog.md#fiweb-search-subscription) is the exhaustive source for accepted fields and JSDoc.

### Results and failures

Codex and Grok citations come from Responses URL annotations, Claude citations come from `web_search_result_location`, and Antigravity citations come from Gemini grounding chunks and supports. The provider caps returned sources to `request.maxResults` and sets `truncated` when it drops sources. It rejects incomplete provider terminals, missing search evidence, missing citation URLs, excess response bytes, and non-OAuth auth sources with machine-routable `WebError` codes. HTTP failures retain the provider status on `SubscriptionSearchError.status` without exposing the response body.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin creates one pi-ai model registry over the Harness credential store and asks `models.getAuth(provider)` once per request. Only `source: OAuth` with a non-empty access token may continue. The request then freezes that result and applies `@fi/provider-compat` endpoint and header metadata. Antigravity instead calls its package-owned serialized grant resolver and native Gemini transport.

`createSubscriptionSearchProvider(ctx, config)` exposes the same construction without registering a second `subscription-native` id. The FI preferred-search router uses that factory for one snapshotted operation; ordinary direct mounts continue through `apply()`.

The Codex, Grok, and Claude credential-bearing fetches reject redirects. Antigravity delegates dispatch and upstream collection to its package-owned transport, which provides redirect rejection, cancellation, response-size limits, and error redaction. This package's response readers enforce the configured byte limit before parsing SSE or JSON. Provider parsers accept only completed native terminals and project citation-bearing provider fields into `WebSearchSource`; they do not invent URLs. Plugin disposal aborts and awaits active requests, while `ctx.web.registerSearchProvider()` owns reversible registration.

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin configuration, credential adapters, and lifecycle wiring |
| [`src/provider.ts`](src/provider.ts) | Frozen-auth request dispatch and provider-specific native request bodies |
| [`src/response.ts`](src/response.ts) | Bounded SSE/JSON parsing, completion checks, and citation normalization |
| [`src/types.ts`](src/types.ts) | Provider selection and status-preserving search error |
| [`tests/expected/native-search.json`](tests/expected/native-search.json) | Owner-local golden for the normalized model-visible tool value |
| — | No runtime invariant companion is published; the web and credential services own the mutable relationships this package consumes. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web subsystem](../../../docs/subsystems/web.md) — search request, result, and error semantics.
- [`dsh-web`](../../web/web/README.md) — provider registration and explicit selection.
- [`dsh-tool-web`](../../web/tool-web/README.md) — model-facing `web_search` formatting and source limits.
- [`dsh-llm-pi-ai`](../../llm/llm-pi-ai/README.md) — stored provider OAuth and serialized refresh.
- [`@fi/llm-antigravity`](../llm-antigravity/README.md) — Antigravity grant and native Gemini transport.
- [`@fi/provider-compat`](../provider-compat/README.md) — captured subscription endpoints and request headers.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which receives provider-generated answer text only with completed native search evidence and native citation URLs. The tool formats the bounded sources as external, untrusted content and asks the model to cite the relevant URLs. Provider failures remain structured tool errors instead of uncited answer text.

#### KV Cache effect

No direct invalidation; `dsh-tool-web` owns the model-facing schema and prompt prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits prevent the package from claiming controls its subscription endpoints do not expose.

- Claude receives `maxUses` as native `max_uses`; Codex, Grok, and Antigravity expose no proven equivalent request field, so their responses are rejected after parsing when native action counts exceed the configured ceiling.
- Codex rejects `max_output_tokens`, so `maxOutputTokens` is not sent on Codex requests. Grok, Claude, and Antigravity receive their native token field.
- `request.maxResults` bounds normalized output but is not sent upstream because no common proven native result-count field exists across these four transports.
- `available()` is a local lifecycle check. A missing or non-OAuth grant fails on the first search because refresh and auth-source selection are asynchronous.
- All four provider families have bounded live native-search development coverage through this plugin. Model and account availability can vary; routine tests do not spend subscription quota.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
