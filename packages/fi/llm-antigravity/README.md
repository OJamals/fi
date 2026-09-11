# @fi/llm-antigravity

[English](README.zh.md) | 中文

Antigravity OAuth adapter and Cloud Code transport for fi. Registers the Antigravity sign-in flow on fi's authorization seam and provides the transport that serves Gemini and Claude models through Google's paid Cloud Code endpoint.

## Table of Contents

- [Summary](#summary)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Summary

`@fi/llm-antigravity` adds Antigravity OAuth sign-in to fi. Users holding a Google account with Antigravity access can sign in once, and the adapter discovers their Cloud Code project, stores the grant, and routes inference requests through the paid Cloud Code endpoint.

## What it does

- Registers the `fi-antigravity/antigravity` flow on `ctx.authorization`
- Runs the Google PKCE OAuth dance (browser → loopback callback → token exchange → project discovery)
- Stores the grant in fi's credential store under `fi-antigravity/antigravity`
- Owns the `fi-antigravity` settings namespace: one profile per route, dormant until a profile exists
- Mounts an `LlmAdapter` serving those routes through the Cloud Code transport (`streamGenerateContent` with the Antigravity envelope)
- Declares the directory entry the Models page's add-provider catalog reads, and answers model discovery for its namespace (live projected catalog when a grant reaches it, static fallback otherwise)
- Rotates near-expiry access tokens through the credentials seam's serialized `modifyRecord`, so concurrent calls never lose a refresh

## How it works

The OAuth flow uses the Antigravity desktop app's public client id, a loopback redirect on `127.0.0.1:54545`, and five scopes including `cloud-platform` and `cclog`. After exchange it discovers the `cloudaicompanionProject` via `loadCodeAssist`, which becomes the billing project every inference request names.

The transport wraps Gemini `contents`/`generationConfig` in the Cloud Code envelope (`{project, model, request, userAgent: "antigravity", requestId, requestType: "agent"}`) and POSTs to `v1internal:streamGenerateContent?alt=sse`.

**Runtime invariant:** No companion is published. The flow's per-attempt PKCE verifier and loopback server are created and torn down inside that attempt's own run; only the committed grant persists.

## Model Experience

### Provider request through the Cloud Code transport

#### What the model sees

The selected Antigravity model receives one system instruction (`GenerateOptions.system`, otherwise the text of leading `system` history messages), the remaining history projected to Gemini `contents` (assistant tool calls as `functionCall` parts, tool results as `functionResponse`), tool declarations, and sampling fields, wrapped in the Cloud Code envelope naming the user's discovered billing project. Reasoning history is not replayed as text; the upstream threads thought state through signatures. Image and file blocks are not resolved by this adapter, so its models declare text-only input and surfaces refuse attachments instead of dropping them.

#### Token effect

Provider tokenization governs exact input. Thinking effort maps to the capture-derived budget tables (gemini-3.6 preset budgets, legacy thinking budgets, or `thinkingLevel` for gemini-3 tiered ids).

#### KV Cache effect

Conversion preserves logical request order. The upstream is stateless per request; the envelope's session id is transport metadata and does not change what the model reads. Cached-content tokens, when the upstream reports them, surface as `cacheReadTokens`.

### Provider response

#### What the model sees

Upstream Gemini SSE events become harness reasoning, text, tool-call, usage, and finish chunks; a stream that ends without a finish reason surfaces as an error, never a silently truncated answer.

#### Token effect

Generated content affects later inputs only after the loop records it. Usage maps prompt/candidate/thought counts to disjoint input/output fields with cached input reported separately.

#### KV Cache effect

Recorded response content appends to the next request and does not invalidate its earlier reusable prefix.

## Known Limitations and Deferred Work

- The OAuth flow requires a browser (loopback callback). Headless environments need `--manual` mode or a pre-authorized token file.
- The Models page's provider editor cannot create the route: its `layoutOf` knows only the upstream namespaces, so the `fi-antigravity` section renders as "fields live in settings.yaml" with Apply disabled. The sign-in section's adopt chain (or a hand-written `fi-antigravity.providers.antigravity: {}` in settings.yaml) is the path.
- Text-only for now: resolving `ImageBlock`/`FileBlock` bytes from the attachment service is deferred, and the adapter declares `inputModalities: ['text']` so surfaces refuse attachments rather than drop them.
- Stealth is minimal: the UA string and `ideType: "ANTIGRAVITY"` in discovery are the only identity claims, both capture-derived.
