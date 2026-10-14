---
description: "Ollama Cloud subscription sign-in, device credentials, and native model requests."
kind: "package-reference"
---

# @fi/llm-ollama

English | [中文](README.zh.md)

## Summary

Sign in to Ollama Cloud from Settings → Models using your existing account and subscription. FI creates its own Ed25519 device identity, displays Ollama's approval link, and stores the private key only after `/api/me` confirms the account. This is Ollama's native device authorization, not OAuth 2.0. No Ollama daemon, copied API key, callback port, or other application's credential file is required.

## Table of Contents

- [Authorization and configuration](#authorization-and-configuration)
- [Protocol sources](#protocol-sources)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Authorization and configuration

The runtime bundle registers the sign-in flow and provider directory entry. Successful authorization stores `fi-ollama/ollama-cloud`; the authorization controller creates `providers.ollama-cloud` in `fi-ollama` settings. Profiles accept `displayName` and selected `models`. Omission lists all advertised completion models; an empty list hides all picker models. Discovery remains independent of selection.

`deviceName` labels the public-key approval request. `authTimeoutMs`, `pollIntervalMs`, and `requestTimeoutMs` bound approval and polling; cancellation or failure preserves any previous credential. Removing sign-in deletes FI's local credential. Revoke the corresponding device in your Ollama account to invalidate it remotely. No private key reaches browser state or inference bodies.

Requests sign the method and timestamped request URI, using Ollama's SSH public-key encoding and Node's Ed25519 implementation. Only the fixed HTTPS cloud account, catalog, model-info, and chat-completions endpoints can be signed; redirects are rejected. Discovery reads `/api/tags`; preparation reads `/api/show` for context capacity and tool support. `defaultContextWindow` applies only when metadata omits capacity. `defaultMaxTokens` bounds generated output, and `streamIdleTimeoutMs` bounds stalled streams. Prepared calls retain one credential and configuration generation.

## Protocol sources

Inference HTTP 401 reports `CREDENTIAL_REVOKED` with sign-in recovery instead of an API-key diagnosis. Provider error bodies are not copied into this diagnostic.

The implementation follows Ollama's [device approval URL](https://github.com/ollama/ollama/blob/63b4f61ca926d382b9010e6e15aee93449eab2ac/app/auth/connect.go), [Ed25519 authorization header](https://github.com/ollama/ollama/blob/63b4f61ca926d382b9010e6e15aee93449eab2ac/auth/auth.go), [cloud proxy signature](https://github.com/ollama/ollama/blob/63b4f61ca926d382b9010e6e15aee93449eab2ac/server/cloud_proxy.go), and [account client](https://github.com/ollama/ollama/blob/63b4f61ca926d382b9010e6e15aee93449eab2ac/api/client.go). Maintained pi-ai conversion owns OpenAI-compatible messages and streaming responses.

<a id="model-experience"></a>
## Model Experience

### Cloud model request and response

#### What the model sees

The model receives FI's recorded system prompt, conversation, and tool definitions from `GenerateOptions`. Models without advertised tool support reject tool-bearing calls. The adapter projects text, reasoning returned by the provider, tool calls, usage, and finish reasons through existing session events. Signing headers contain no model-visible content.

#### Token effect

The connector adds no prompt or tool declarations. Ollama supplies usage counts. Context capacity comes from model metadata or the configured fallback; output limits come from the request or configured default.

#### KV Cache effect

Ordered conversation replay uses existing pi-ai replay metadata. Device signatures and timestamps are HTTP metadata and do not alter recorded model input.

## Known Limitations and Deferred Work

- Only text input is offered. Image input, native search, reasoning-effort overrides, and stop-sequence overrides are not exposed. Cloud availability and subscription limits remain Ollama-owned; successful sign-in or catalog discovery does not guarantee model access. Local credential removal does not remotely revoke the device. Live approval and inference require an Ollama account.

**Runtime invariant:** No companion is published. The credential store owns mutation; prepared calls capture their own immutable identity and model metadata without an independent registration mirror.

### Dev Note

None.
