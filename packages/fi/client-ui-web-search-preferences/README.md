---
description: "Browser controls for choosing FI web-search routing and managing direct-provider credentials."
kind: "package-reference"
---

# @fi/client-ui-web-search-preferences

English | [中文](README.zh.md)

## Summary

This browser plugin adds **Preferred web search** to Settings → Plugins. It extends the Host-owned `web-search-deepseek` settings section and manages API keys through the credentials API without exposing stored values.

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

Load this package beside [`@fi/web-search-preferences`](../web-search-preferences/README.md). The FI authorization bundle includes both.

Users select DeepSeek official, Exa, Perplexity, Parallel, Tavily, Serper, Brave Search, or subscription search. Direct-provider keys are added, replaced, or removed through password controls. A provider with no configured key cannot be activated. Credential writes finish before a provider change is committed, so a refused write leaves the active route unchanged. A credential-only save remains available when Settings is read-only and Credentials reports the active reference as writable.

Subscription search has no key field. Users sign in from Models first, then choose Codex, Grok, Antigravity, or Claude and enter an exact model id. This card never starts OAuth or changes the conversation model route.

<a id="understand-the-implementation"></a>
## Understand the implementation

An FI-local controller binds the `web-search-deepseek` settings namespace, stages edits, resolves the selected provider's configured credential reference, and injects a snapshot hook into the presentation component. Credential status contains only `configured` and `writable`; key values are never read back. Stale credential responses are discarded after a provider or reference change. Host refusals and credential read, write, or removal failures remain visible in the card.

No runtime invariant companion is published: this package owns browser presentation only, while the settings and credentials services validate their own durable state.

<a id="further-exploration"></a>
## Further Exploration

- [Preferred-search Host router](../web-search-preferences/README.md)
- [Credentials subsystem](../../../docs/subsystems/credentials.md)
- [Web subsystem](../../../docs/subsystems/web.md)

<a id="model-experience"></a>
## Model Experience

### Preferred-search settings card

#### What the model sees

Nothing from this browser package. The card changes Host settings; model-visible behavior remains owned by the unchanged `web_search` tool.

#### Token effect

None. Browser labels and credential metadata never enter a model request.

#### KV Cache effect

No cache impact; this package never assembles model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Advanced provider endpoints, models, result limits, and timeouts remain Host configuration fields without dedicated controls.
- Real vendor availability is checked only when the selected provider runs.

<a id="dev-note"></a>
### Dev Note

None.
