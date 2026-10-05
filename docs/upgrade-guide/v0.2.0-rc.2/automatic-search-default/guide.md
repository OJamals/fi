---
kind: upgrade-guide
description: FI profiles without an explicit search preference now follow the chat's linked subscription model or use free Bing RSS search instead of DeepSeek search.
---

# FI automatic search default

English | [中文](guide.zh.md)

## Change

The `fi-web-search-preferences` provider default changes from `deepseek-official` to `auto`. Profiles that omit `provider` use native subscription search when the initiating chat's model route has a matching stored OAuth grant; otherwise they use keyless Bing RSS search. Automatic routing uses the exact subscription chat model. Existing explicit engine choices remain effective. Explicit subscription search supports optional family/model overrides and still requires a grant before dispatch.

## Migration

1. In Settings → Plugins → Preferred web search, select Automatic (follow chat model), or set `provider: auto` in the `fi-web-search-preferences` profile entry. No search API key is required.
2. To use subscription search automatically, sign in from Settings → Models and select that subscription model for the chat. For free search on every model, select Bing (free), or set `provider: bing-rss`. To retain DeepSeek search, select DeepSeek official explicitly.
3. Run a web search and confirm sources appear. Automatic uses the chat's linked subscription when present, otherwise Bing; dispatched provider failures remain visible.
