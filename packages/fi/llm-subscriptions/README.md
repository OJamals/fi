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

Copilot credentials remain at `llm-pi-ai/github-copilot`. Other credentials belong to `fi-subscriptions/cursor`, `fi-subscriptions/kiro`, `fi-subscriptions/cline`, and `fi-subscriptions/gemini-cli`. Cursor uses browser approval with PKCE polling; expired Cursor grants require sign-in again. Kiro uses AWS device approval and serialized OIDC refresh. Cline accepts an account API key from its Free/Pass account page and validates it against the model catalog. Google uses PKCE, a state-checked loopback callback, refresh tokens, and Code Assist project entitlement checks. Cancellation preserves existing credentials. FI does not import another application's credentials or run a proxy process.

`providers` accepts only the five canonical ids, including `copilot`. The native `copilot` route is separate from pi-ai's `github-copilot` catalog entry; both use the existing GitHub OAuth record. Each profile accepts `displayName` and selected `models`; omission exposes all advertised models and an empty array hides picker models. Discovery ignores picker selection. `kiroRegion` selects AWS endpoints. `geminiProjectId` supplies a Cloud project when the account requires one; `geminiClientId`, `geminiClientSecret`, and `geminiCallbackPort` configure the installed-app OAuth flow. Configure both Google client values explicitly; missing values reject authorization before opening the callback listener and reject token refresh before network access.

`requestTimeoutMs`, `streamIdleTimeoutMs`, `authTimeoutMs`, `pollIntervalMs`, and `refreshMarginMs` govern operation deadlines and refresh. `defaultContextWindow` and `defaultMaxTokens` supply conservative model capacities where catalogs omit them. Prepared calls capture one account and configuration generation. Redirects are rejected on authenticated endpoints. Removing sign-in deletes FI's local credential; provider-side revocation remains separate.

Kiro discovery follows every `nextToken` page within one `requestTimeoutMs` deadline, preserving the account and profile and deduplicating model ids. Invalid pages or repeated tokens fail discovery instead of returning a partial catalog.

## Protocol sources

Native codecs follow auth2api revision `05e9e0a68a6e952044fd2c03186722577c6de37a`. Cursor uses HTTP/2 Connect protobuf; Kiro uses CRC-checked AWS event streams; Cline uses OpenAI-compatible chat with truthful FI client headers; Code Assist reuses FI's Gemini message and SSE codec with its own Google endpoint and project envelope. [NOTICE](NOTICE.md) retains component attribution and distribution restrictions.

## Model Experience

### Subscription requests

#### What the model sees

Models receive the recorded `GenerateOptions.system` prompt, conversation, and declared function tools. Native Cursor protocol handshakes advertise those tools; native shell requests are declined rather than executed outside FI. Tool results replay through the normal session transcript. No authorization token enters model input.

#### Token effect

Cursor serializes recorded history when starting a native run, then sends tool results as native MCP results on the same stream. It enforces output limits with a local BPE budget covering text, reasoning, and complete tool calls; this is not the provider's billing tokenizer. The offline `o200k_base` tokenizer is bundled as a private lazy-loaded chunk with its MIT license; uncapped calls and other providers do not load it. Other transports forward output limits. Provider usage is retained when available.

#### KV Cache effect

Conversation order follows pi-ai replay conversion. Cline inference sends the durable session id as its documented `X-Task-ID` tracking header; direct calls without a session omit it. Cursor retains a native stream only while a tool result is pending, bounded by `streamIdleTimeoutMs`. Continuations require the same account, model, tools, and preceding transcript; each pending call is consumed once. Expired or mismatched continuations fail rather than repeat tools. Plugin disposal closes retained streams. No server checkpoint survives restart. Account headers and protocol handshakes do not add session messages.

## Known Limitations and Deferred Work

Missing Google OAuth client configuration blocks only Google authorization and token refresh. Other subscription providers remain available.

- Only text input and function tools are exposed. Reasoning-effort and stop overrides are unsupported; Cursor also rejects sampling controls its protocol cannot represent. Catalog presence does not guarantee quota or entitlement. Copilot lists chat-completions models only. Cursor exposes native tool calls serially; pending results cannot resume after restart or expiry. Cline models restricted to Cline product surfaces remain unavailable to external clients. Google may reject consumer accounts with `UNSUPPORTED_CLIENT`; a Cloud project alone does not supply a Code Assist license, and quota can return `SUBSCRIPTION_REQUIRED`. Free-tier onboarding omits configured project metadata. Cursor refresh is not exposed by the supported browser flow.

**Runtime invariant:** No companion is published. Credentials serialize their own mutations, and prepared requests retain their captured account without an independently maintained identity mirror.

### Dev Note

None.
