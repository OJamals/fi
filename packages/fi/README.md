---
description: "FI subscription sign-in and native provider packages for configuring account-backed model access."
kind: "package-group"
---

# fi/ — Subscription providers

English | [中文](README.zh.md)

## Summary

Use these packages to sign in with a subscription account and configure its model route. The authorization bundle composes the sign-in interface and provider support as an opt-in layer. Credentials remain in the Harness credential store; the interface displays status without exposing tokens.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

<a id="packages"></a>
## Packages

Each package owns one part of subscription access. These private workspace packages use `@fi/<directory>` names and do not participate in the upstream npm release family; workspace constraints enforce both properties.

| Package | Role |
|---|---|
| [authorization-bundle](authorization-bundle/README.md) | Opt-in subscription composition |
| [api-authorization-controller](api-authorization-controller/README.md) | Sign-in and route-adoption operations |
| [client-ui-model-signin](client-ui-model-signin/README.md) | Models settings sign-in controls |
| [client-ui-web-search-preferences](client-ui-web-search-preferences/README.md) | Preferred-search settings and credential controls |
| [llm-antigravity](llm-antigravity/README.md) | Native Antigravity model requests |
| [provider-compat](provider-compat/README.md) | Shared provider metadata and OAuth transport compatibility |
| [tool-image-generation](tool-image-generation/README.md) | Subscription-backed image generation and reference-image editing |
| [web-search-preferences](web-search-preferences/README.md) | User-selected search routing |
| [web-search-subscription](web-search-subscription/README.md) | Explicitly selected native subscription search |

<a id="related-documentation"></a>
## Related documentation

- [LLM subsystem](../../docs/subsystems/llm-streaming.md) — model adapter and replay ownership.
- [Credentials subsystem](../../docs/subsystems/credentials.md) — stored credentials and authorization.
- [Architecture](../../docs/architecture.md) — plugin composition and upstream extension points.

<a id="dev-note"></a>
## Dev Note

None.
