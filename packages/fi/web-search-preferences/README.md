---
description: "FI-owned automatic web-search routing across free, API-key, and subscription-native providers."
kind: "package-reference"
---

# @fi/web-search-preferences

English | [中文](README.zh.md)

## Summary

This package gives FI users one preferred-search setting while preserving DeepSeek Harness's `WebSearchProvider`, `WebRuntime`, and `web_search` interfaces. The stable `fi-preferred-search` registry entry snapshots the current settings for each new call, creates the selected provider, and returns its normalized result without fallback. An in-flight call keeps its original provider and options.

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

Select the stable router from the existing web runtime and mount this package:

```yaml
- id: web
  config:
    searchProvider: fi-preferred-search
    fetchProvider: http
- id: fi-web-search-preferences
  name: '@fi/web-search-preferences'
```

The FI authorization bundle supplies this overlay. The sibling [browser settings package](../client-ui-web-search-preferences/README.md) contributes **Preferred web search** to Settings → Plugins. Users can select automatic routing, free Bing RSS search, DeepSeek official, Exa, Perplexity, Parallel, Tavily, Serper, Brave Search, or subscription search. API-provider keys are written through Credentials; literals never enter the settings document or Session log.

The default `auto` follows the initiating chat's model on every search. A Codex, Grok, Antigravity, or Claude route with a matching stored OAuth grant uses that subscription's native search and the exact chat model. Other models, API-key records, and calls without an initiating chat use Bing's keyless RSS search. Bing requires no sign-in, API key, or subscription. An explicitly selected engine overrides this routing; a dispatched search failure never switches providers. Selection does not start OAuth or change the chat model.

Explicit subscription search supports optional family and model overrides. Without overrides, it prefers the current chat's linked subscription, then the first linked family with a model in Codex, Grok, Antigravity, Claude order. Model selection uses the matching chat model, then the live provider catalog, then the bundled subscription catalog. Missing grants fail before dispatch. The other engines use API keys; Exa, Perplexity, and Parallel MCP OAuth are not exposed.

| Field | Default | Meaning |
|---|---|---|
| `provider` | `auto` | Follow the chat's linked subscription model, otherwise use free Bing |
| `bingBaseURL` | `https://www.bing.com` | Keyless RSS endpoint base |
| `bingMaxResponseBytes` | `1048576` | Maximum RSS response bytes before parsing |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | DeepSeek credential reference; retains the upstream field name |
| `exaApiKeyEnv` | `EXA_API_KEY` | Exa credential reference |
| `perplexityApiKeyEnv` | `PERPLEXITY_API_KEY` | Perplexity credential reference |
| `parallelApiKeyEnv` | `PARALLEL_API_KEY` | Parallel credential reference |
| `tavilyApiKeyEnv` | `TAVILY_API_KEY` | Tavily credential reference |
| `serperApiKeyEnv` | `SERPER_API_KEY` | Serper credential reference |
| `braveApiKeyEnv` | `BRAVE_SEARCH_API_KEY` | Brave Search credential reference |
| `subscriptionProvider` | automatic | Optional `codex`, `grok`, `antigravity`, or `claude` override |
| `subscriptionModel` | automatic | Optional exact native subscription model id override |

The generated [configuration catalog](../../../docs/config-catalog.md#fiweb-search-preferences) lists every endpoint, model, result, timeout, and response-limit field.

<a id="understand-the-implementation"></a>
## Understand the implementation

The Host registers one provider for the plugin lifetime. Every `search()` copies the settings before resolving the provider and credentials, then delegates to the selected adapter. Every configurable endpoint base must use HTTPS. The Bing adapter bounds streamed response bytes, rejects malformed XML and non-HTTP result URLs, and returns titles, URLs, and snippets without treating RSS timestamps as publication dates. Disposal aborts active operations, and concurrent disposal calls await the same drain. Missing explicitly selected credentials and subscription grants fail before dispatch.

DeepSeek auxiliary request logging remains `web/deepseek-search-llm-request`. The model-facing tool schema, result formatting, source caps, fetch provider, agent loop, Session format, and SDK projections remain upstream-owned and unchanged.

The FI router owns the `fi-web-search-preferences` settings namespace while the separately registered base search row is disabled. Its schema retains the upstream `apiKey`, `apiKeyEnv`, `baseURL`, `model`, `apiVersion`, `maxTokens`, and `maxUses` field names and defaults; FI additionally requires `baseURL` to use HTTPS. Removing the FI layer restores the upstream row and its own settings namespace.

No runtime invariant companion is published: one router object owns each settings snapshot, delegate, abort signal, and disposal path, so no independently observed relationship can diverge.

<a id="further-exploration"></a>
## Further Exploration

- [Web subsystem](../../../docs/subsystems/web.md)
- [Upstream DeepSeek provider](../../web/web-search-deepseek/README.md)
- [Upstream Exa provider](../../web/web-search-exa/README.md)
- [Upstream Perplexity provider](../../web/web-search-perplexity/README.md)
- [FI subscription-native provider](../web-search-subscription/README.md)

<a id="model-experience"></a>
## Model Experience

### Preferred-search routing

#### What the model sees

Only the unchanged upstream `web_search` tool and its normalized result. Provider selection is absent from the tool schema and prompt.

#### Token effect

No new prompt or schema tokens. Bing returns normalized sources from a bounded RSS feed; other providers retain their existing bounded content.

#### KV Cache effect

None. The model-facing tool definition is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The card manages provider choice, direct-provider keys, and subscription family/model. Advanced endpoint and limit fields remain configurable in `cordis.yml` or the stored settings document but do not yet have hand-written controls.
- Subscription availability is checked during the search because OAuth refresh is asynchronous.
- Bing RSS supplies a limited result feed rather than a guaranteed search API service; endpoint availability and rate limits remain upstream-controlled.
- Routine tests mock vendor transports. Real direct-provider and subscription calls require the corresponding user credential or grant.

<a id="dev-note"></a>
### Dev Note

None.
