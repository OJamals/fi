---
description: "Antigravity OAuth, refreshed grants, native Gemini transport, and the fi LLM adapter for maintainers configuring or extending paid Cloud Code inference."
kind: "package-reference"
---

# @fi/llm-antigravity

English | [中文](README.zh.md)

Antigravity OAuth adapter and Cloud Code transport for fi. Registers the Antigravity sign-in flow on fi's authorization seam and provides the transport that serves Gemini and Claude models through Google's paid Cloud Code endpoint.

## Table of Contents

- [Summary](#summary)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="summary"></a>
## Summary

`@fi/llm-antigravity` adds Antigravity OAuth sign-in to fi. Users holding a Google account with Antigravity access can sign in once, and the adapter discovers their Cloud Code project, stores the grant, and routes inference requests through the paid Cloud Code endpoint.

<a id="what-it-does"></a>
## What it does

- Registers the `fi-antigravity/antigravity` flow on `ctx.authorization`
- Runs the Google PKCE OAuth dance (browser → loopback callback → token exchange → project discovery)
- Stores the grant in fi's credential store under `fi-antigravity/antigravity`
- Owns the `fi-antigravity` settings namespace: one profile per route, dormant until a profile exists
- Mounts an `LlmAdapter` serving those routes through the Cloud Code transport (`streamGenerateContent` with the Antigravity envelope); its model-catalog provider name is the lowercase route id `antigravity`
- Declares the directory entry the Models page's add-provider catalog reads, and answers model discovery for its namespace (live projected catalog when a grant reaches it, static fallback otherwise)
- Rotates near-expiry access tokens through the credentials seam's serialized `modifyRecord`, so concurrent calls never lose a refresh

<a id="how-it-works"></a>
## How it works

The OAuth flow uses the Antigravity desktop app's public client id, a loopback redirect on `127.0.0.1:54545`, and five scopes including `cloud-platform` and `cclog`. After exchange it discovers the `cloudaicompanionProject` via `loadCodeAssist`, which becomes the billing project every inference request names.

The transport reads its capture-pinned endpoint, CLI fingerprint version, client, build, and authentication method from `@fi/provider-compat`. It adds the runtime OS and architecture to that fingerprint, wraps Gemini `contents`/`generationConfig` in the Cloud Code envelope (`{project, model, request, userAgent: "antigravity", requestId, requestType: "agent"}`), and POSTs to `v1internal:streamGenerateContent?alt=sse`.

Subscription consumers call `resolveAntigravityGrant(ctx, signal)` from the package root so token refresh remains serialized by the credential store. Native Gemini consumers import `callAntigravityGeminiNative` from `@fi/llm-antigravity/transport`; `action: "generateContent"` returns collected native Gemini JSON, while `streamGenerateContent` returns native SSE. The same transport exports `callAntigravityImageGenerations` and `callAntigravityImageEdits`, which project OpenAI Images request fields into the native Gemini request and return OpenAI Images JSON without a second SSE parser. The transport preserves candidate metadata such as `groundingMetadata`; a web-search provider owns grounding validation and result projection.

Every upstream fetch rejects redirects. Native request, inline-media, response-total, SSE-line, and SSE-frame ceilings are positive-integer call options; omitted native request, inline-media, and response-total ceilings use the captured 20 MiB protocol/security limit, while fi image projection reuses the deployment's validated attachment policy. Non-success and in-band provider errors expose status-only diagnostics, and cancelling either the operation or returned stream cancels the upstream reader.

**Runtime invariant:** No companion is published. The flow's per-attempt PKCE verifier and loopback server are created and torn down inside that attempt's own run; only the committed grant persists.

<a id="model-experience"></a>
## Model Experience

### Provider request through the Cloud Code transport

#### What the model sees

The selected Antigravity model receives one system instruction (`GenerateOptions.system`, otherwise the text of leading `system` history messages), the remaining history projected to Gemini `contents` (assistant tool calls as `functionCall` parts, tool results as `functionResponse`), tool declarations, and sampling fields, wrapped in the Cloud Code envelope naming the user's discovered billing project. Image-generation models request the native `IMAGE` response modality; the chat adapter keeps the normal system instruction and function declarations, which `gemini-3.1-flash-image` accepted in a live adapter-path request. Gemini `generateContent` signatures may belong to reasoning, visible text, image, or function-call parts; `ReplayEnvelope.response.nativeParts` retains compact part order and signature metadata. A generated image is fully admitted through the attachment service before its `ImageBlock` is published. The display attachment contains the normalized raster, while a signed native image part stores its already-validated original bytes as a private durable file reference so replay sends the exact bytes covered by the signature after normalization or a model switch. No image base64 is stored in the replay envelope. User and tool-result image references resolve through the durable attachment service's validated image policy into Gemini inline data under the fixed 20 MiB aggregate ceiling. Durable file references remain structured in the session log but the LLM runtime replaces every occurrence, including nested tool results, with deterministic handle text naming the file, byte size, digest, and read-only saved path before adapter dispatch. The model reads that path with the mounted file tools; arbitrary binary files are not native Antigravity input.

#### Token effect

Provider tokenization governs exact input. Thinking effort maps to the capture-derived budget tables (gemini-3.6 preset budgets, legacy thinking budgets, or `thinkingLevel` for gemini-3 tiered ids).

#### KV Cache effect

Conversion preserves logical request order. The upstream is stateless per request; the envelope's session id is transport metadata and does not change what the model reads. Cached-content tokens, when the upstream reports them, surface as `cacheReadTokens`.

### Provider response

#### What the model sees

Upstream Gemini SSE events become harness reasoning, text, image, tool-call, usage, and finish chunks in native part order; a stream that ends without a finish reason surfaces as an error, never a silently truncated answer. Generated image count and aggregate decoded bytes use the mounted attachment policy, and declared image media types are accepted only after the attachment service decodes and verifies the raster.

#### Token effect

Generated content affects later inputs only after the loop records it. Usage maps prompt/candidate/thought counts to disjoint input/output fields with cached input reported separately.

#### KV Cache effect

Recorded response content appends to the next request and does not invalidate its earlier reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The OAuth flow requires access to the displayed browser URL and its loopback callback on `127.0.0.1:54545`; it has no manual code-entry path.
- Native Gemini transport returns provider JSON and metadata; the consuming web-search package owns grounding requirements, citations, and user-facing projection.
- Antigravity compatibility metadata remains capture-pinned. `@fi/provider-compat` owns the endpoint and CLI fingerprint fields; updating that generated record requires new capture evidence.
- Stealth is minimal: the UA string and `ideType: "ANTIGRAVITY"` in discovery are the only identity claims, both capture-derived.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
