---
description: "FI-owned live web-search preference routing across API-key and subscription-native providers."
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

The FI authorization bundle supplies this overlay. The sibling [browser settings package](../client-ui-web-search-preferences/README.md) contributes **Preferred web search** to Settings → Plugins. Users can select DeepSeek official, Exa, Perplexity, Parallel, Tavily, Serper, Brave Search, or subscription search. Direct-provider keys are written through Credentials; literals never enter the settings document or Session log.

Every direct provider in this package uses an API key. The package does not expose Exa, Perplexity, or Parallel MCP OAuth. Subscription search reuses a Codex, Grok, Antigravity, or Claude grant obtained from the Models page. Selecting subscription search does not start OAuth, adopt an inference route, or change the chat model. The user must select the subscription family and exact search model id.

| Field | Default | Meaning |
|---|---|---|
| `provider` | `deepseek-official` | Provider used by the next search |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | DeepSeek credential reference; retains the upstream field name |
| `exaApiKeyEnv` | `EXA_API_KEY` | Exa credential reference |
| `perplexityApiKeyEnv` | `PERPLEXITY_API_KEY` | Perplexity credential reference |
| `parallelApiKeyEnv` | `PARALLEL_API_KEY` | Parallel credential reference |
| `tavilyApiKeyEnv` | `TAVILY_API_KEY` | Tavily credential reference |
| `serperApiKeyEnv` | `SERPER_API_KEY` | Serper credential reference |
| `braveApiKeyEnv` | `BRAVE_SEARCH_API_KEY` | Brave Search credential reference |
| `subscriptionProvider` | none | `codex`, `grok`, `antigravity`, or `claude` |
| `subscriptionModel` | none | Exact native subscription model id |

The generated [configuration catalog](../../../docs/config-catalog.md#fiweb-search-preferences) lists every endpoint, model, result, timeout, and response-limit field.

<a id="understand-the-implementation"></a>
## Understand the implementation

The Host registers one provider for the plugin lifetime. Every `search()` copies the resolved settings before credential or authorization resolution, then delegates to an upstream DeepSeek, Exa, or Perplexity provider, an FI-local Parallel, Tavily, Serper, or Brave adapter, or the subscription provider. Every configurable endpoint base must use HTTPS before FI resolves or sends a credential. The FI-local adapters implement the same provider-neutral request/result types, validate external response fields before projection, cancel failed response bodies, and report only provider plus HTTP status for failed responses. Disposal aborts active operations, and concurrent disposal calls await the same drain. Missing selected credentials and incomplete subscription configuration fail explicitly; no provider is tried as a fallback.

DeepSeek auxiliary request logging remains `web/deepseek-search-llm-request`. The model-facing tool schema, result formatting, source caps, fetch provider, agent loop, Session format, and SDK projections remain upstream-owned and unchanged.

The FI router owns the existing `web-search-deepseek` settings namespace while the separately registered base row is disabled. Its schema retains the upstream `apiKey`, `apiKeyEnv`, `baseURL`, `model`, `apiVersion`, `maxTokens`, and `maxUses` field names and defaults; FI additionally requires `baseURL` to use HTTPS. Removing the FI layer restores the upstream row against the same stored DeepSeek settings.

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

No new prompt or schema tokens. Search results retain the selected upstream provider's existing bounded content.

#### KV Cache effect

None. The model-facing tool definition is unchanged.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The card manages provider choice, direct-provider keys, and subscription family/model. Advanced endpoint and limit fields remain configurable in `cordis.yml` or the stored settings document but do not yet have hand-written controls.
- Subscription availability is checked during the search because OAuth refresh is asynchronous.
- Routine tests mock vendor transports. Real direct-provider and subscription calls require the corresponding user credential or grant.

<a id="dev-note"></a>
### Dev Note

None.
