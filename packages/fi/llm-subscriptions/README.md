---
description: "Native Cursor, Kiro, Cline Free/Pass, and Gemini Code Assist authorization and inference."
kind: "package-reference"
---

# @fi/llm-subscriptions

English | [中文](README.zh.md)

## Summary

This private plugin connects FI to Cursor, Kiro, Cline Free/Pass, and Google Code Assist using their native account protocols. Settings → Models offers the authorization flows; successful sign-in creates the matching provider route. GitHub Copilot retains pi-ai device login and token refresh; this plugin supplies its live chat catalog and inference.

## Table of Contents

- [Authorization and configuration](#authorization-and-configuration)
- [Protocol sources](#protocol-sources)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Authorization and configuration

Copilot credentials remain at `llm-pi-ai/github-copilot`. Other credentials belong to `fi-subscriptions/cursor`, `fi-subscriptions/kiro`, `fi-subscriptions/cline`, and `fi-subscriptions/gemini-cli`. Cursor uses browser approval with PKCE polling and refreshes its access token through Cursor's OAuth grant five minutes before expiry; a grant without a refresh token, or one Cursor revokes, requires sign-in again. Kiro uses AWS device approval and serialized OIDC refresh. Cline accepts an account API key from its Free/Pass account page and validates it against the model catalog. Google uses PKCE, a state-checked loopback callback, refresh tokens, and Code Assist project entitlement checks. Cancellation preserves existing credentials. FI does not import another application's credentials or run a proxy process.

`providers` accepts only the five canonical ids, including `copilot`. The native `copilot` route is separate from pi-ai's `github-copilot` catalog entry; both use the existing GitHub OAuth record. Each profile accepts `displayName` and selected `models`; omission exposes all advertised models and an empty array hides picker models. Discovery ignores picker selection. `kiroRegion` selects AWS endpoints. `geminiProjectId` supplies a Cloud project when the account requires one; `geminiClientId`, `geminiClientSecret`, and `geminiCallbackPort` configure the installed-app OAuth flow. Configure both Google client values explicitly; missing values reject authorization before opening the callback listener and reject token refresh before network access.

`requestTimeoutMs`, `streamIdleTimeoutMs`, `authTimeoutMs`, `pollIntervalMs`, and `refreshMarginMs` govern operation deadlines and refresh. `defaultContextWindow` and `defaultMaxTokens` supply conservative model capacities where catalogs omit them. Prepared calls capture one account and configuration generation. Redirects are rejected on authenticated endpoints. Removing sign-in deletes FI's local credential; provider-side revocation remains separate.

A failed response's `Retry-After` reaches the retry policy as the provider delay, so a reset beyond the policy's maximum delay is not retried. Kiro `MONTHLY_REQUEST_COUNT` (429 or 402) and Copilot quota failures (402 or a quota error code) become a 429 whose delay is the real reset: the exhausted quota window, then the account's reset date, then the next UTC month. Copilot hides models whose policy is `disabled`; `model_picker_enabled` is ignored because Free accounts report it false for every model.

Kiro discovery follows every `nextToken` page within one `requestTimeoutMs` deadline, preserving the account and profile and deduplicating model ids. Invalid pages or repeated tokens fail discovery instead of returning a partial catalog.

The model picker fetches each provider catalog once per refresh. Per-model metadata uses configured capacities without more credential or catalog requests. Preparing a generation still validates the selected model against the current account catalog.

## Protocol sources

Native protocols were adapted from the local auth2api repository at `a269c56`. Cursor and Kiro wire work follows decolua/9router, and Cursor browser authorization follows kaitranntt/CLIProxyAPIPlus. Cursor token refresh follows the PaceBar provider notes and eisbaw/cursor_api_demo, as cited by auth2api; Kiro client identity follows the Kiro update feed and kaitranntt/CLIProxyAPIPlus; Copilot client identity follows the microsoft/vscode 1.144.0 release. Cursor uses HTTP/2 Connect protobuf; Kiro uses CRC-checked AWS event streams; Cline uses OpenAI-compatible chat with truthful FI client headers; Code Assist reuses FI's Gemini message and SSE codec with its own Google endpoint and project envelope. [NOTICE](NOTICE.md) retains component attribution and distribution restrictions.

The presented client builds are protocol constants: Cursor 3.27.22, Kiro 1.4.62, and VS Code 1.144.0 with Copilot Chat 0.72.0. Copilot, Kiro, and Cursor derive their session and machine identifiers from the signed-in account.

Cline sends the caller's `maxTokens`, or `defaultMaxTokens` when omitted, without reducing it against the fallback context estimate. Its advertised catalog omits context capacity; the upstream provider validates the actual context and output limits.

## Model Experience

### Subscription requests

#### What the model sees

Models receive the recorded `GenerateOptions.system` prompt, conversation, and declared function tools. Kiro Claude and `auto` models accept a reasoning effort, which Kiro receives as a thinking budget (1,024 tokens for minimal to 32,000 for xhigh and max); their reasoning returns as reasoning blocks. Native Cursor protocol handshakes advertise those tools; native shell requests are declined rather than executed outside FI. Tool results replay through the normal session transcript. No authorization token enters model input.

#### Token effect

Cursor serializes recorded history when starting a native run, then sends tool results as native MCP results on the same stream. Cursor and Kiro enforce output limits with a local BPE budget covering text, reasoning, and complete tool calls, because neither protocol has an output-limit field; this is not the provider's billing tokenizer. The offline `o200k_base` tokenizer is bundled as a private lazy-loaded chunk with its MIT license; uncapped calls and other providers do not load it. Other transports forward output limits. Provider usage is retained when available: Cursor's turn totals with cache and reasoning detail, and Kiro's token usage and credits.

#### KV Cache effect

Conversation order follows pi-ai replay conversion. Cline inference sends the durable session id as its documented `X-Task-ID` tracking header; direct calls without a session omit it. Cursor retains a native stream only while tool results are pending, bounded by `streamIdleTimeoutMs`. The parallel calls of one step return together and are answered together, in any order. Continuations require the same account, model, tools, and preceding transcript; each pending call is consumed once. One HTTP/2 session per account carries that account's runs; it is never shared between accounts and closes with the plugin. Expired or mismatched continuations fail rather than repeat tools. Plugin disposal closes retained streams. No server checkpoint survives restart. Account headers and protocol handshakes do not add session messages.

## Known Limitations and Deferred Work

Missing Google OAuth client configuration blocks only Google authorization and token refresh. Other subscription providers remain available.

- Only text input and function tools are exposed; images and documents are not forwarded. Stop overrides are unsupported, and reasoning effort is accepted only by Kiro Claude and `auto` models; Cursor also rejects sampling controls its protocol cannot represent, and Kiro accepts `temperature` and `top_p` without effect. Catalog presence does not guarantee quota or entitlement. Copilot lists chat-completions models only. Pending Cursor results cannot resume after restart or expiry. Cline models restricted to Cline product surfaces remain unavailable to external clients. Google may reject consumer accounts with `UNSUPPORTED_CLIENT`; a Cloud project alone does not supply a Code Assist license, and quota can return `SUBSCRIPTION_REQUIRED`. Free-tier onboarding omits configured project metadata.

**Runtime invariant:** No companion is published. Credentials serialize their own mutations, and prepared requests retain their captured account without an independently maintained identity mirror.

### Dev Note

None.
