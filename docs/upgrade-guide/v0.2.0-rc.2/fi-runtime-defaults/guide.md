---
kind: upgrade-guide
description: "FI profiles and SDK clients resolve usable configured models instead of implicitly selecting DeepSeek, and GUI catalogs can report no default."
---

# FI runtime defaults

English | [中文](guide.zh.md)

## Change

FI's Web, Desktop, headless, ACP, and full SDK profiles include `@fi/runtime-bundle`. Fresh profiles prefer a linked subscription model, then a configured API provider. Usable explicit model selections remain selected. With no usable route, configure a model before sending a prompt; existing chats retain their saved selections and refuse prompts after that route or model is removed.

TypeScript `DeepSeekConfig` and Python `DeepSeekConfig` omit provider/model by default. JSON-RPC `initialize` accepts both fields together or neither; omission resolves the profile default. `ModelCatalog.default` can be `null`. `currentSelection()` can return `undefined`; entry points await `resolveSelection()`. Session data formats do not change.

FI disables upstream account UI, account model routes, product analytics, and session feedback uploads by default. Explicit custom telemetry configuration remains possible. Search uses Auto: the current model's linked subscription search when supported, otherwise keyless Bing RSS. Explicit search preferences remain supported.

## Migration

1. Restart FI. Exact previously shipped Web, headless, ACP, and SDK bundle tuples migrate automatically; other manifest fields and custom tuples remain intact.
2. In custom profile `package.json`, list `@fi/runtime-bundle` after the upstream base/mode bundles. GUI profiles additionally list `@fi/authorization-bundle` after it. Keep private FI bundles available in the local package installation.
3. SDK callers may omit both provider/model to use FI settings, or pass both for an explicit route. `sdk-minimal` has no default-model service: supply both fields. Handle `null` catalog defaults and `undefined` synchronous default reads in custom consumers.
4. Link a subscription or configure an API provider in Models settings. Confirm a new chat shows an available model. After removing its provider, choose another model before continuing an existing chat. Feedback uploads require deliberately configuring `session-telemetry-otel`; FI does not send them by default.
