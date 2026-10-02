---
description: "OpenCode Console device authorization, organization-scoped grants, authenticated text-model discovery, and transport."
kind: "package-reference"
---

# @fi/llm-opencode

English | [中文](README.zh.md)

## Summary

OpenCode Console subscription login appears in Settings → Models. The authorization bundle mounts this plugin; a bare mount registers the login and provider directory entry, while configured `providers.opencode-console` activates inference. Credentials remain in FI's canonical store under `fi-opencode/opencode-console`; the authorization controller creates the corresponding settings route after sign-in.

## Table of Contents

- [Authorization and configuration](#authorization-and-configuration)
- [Protocol sources](#protocol-sources)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Authorization and configuration

Device authorization displays a browser URL and code without opening a callback port. Polling obeys pending/slow-down responses, a maximum one-hour device lifetime, request deadlines, and cancellation. The browser-selected token organization takes precedence over the sorted organization fallback for older unscoped tokens. Refresh runs under the credential store's record lock, preserves identity, and persists rotated tokens and any changed organization before discovery. Revoked grants and missing SSO require reconnecting.

`server`, `clientId`, and `userAgent` configure the Console endpoint and public client identity. Defaults match the reviewed OpenCode 2.0.20 release: `https://opencode.ai/console`, `opencode-cli`, and `opencode/latest/2.0.20/cli`. `requestTimeoutMs`, `streamIdleTimeoutMs`, `refreshMarginMs`, `defaultContextWindow`, and `defaultMaxTokens` configure deadlines and missing advertised capacity. Endpoints accept only HTTPS OpenCode domains; all requests reject redirects. These identity defaults require review when the upstream client changes; release metadata alone does not confirm transport compatibility.

## Protocol sources

The [OpenCode Console plugin](https://github.com/anomalyco/opencode/tree/v2.0.20) defines device and organization-scoped token semantics. The [model request implementation](https://github.com/anomalyco/opencode/tree/v2.0.20) defines client/session headers. Auth2api's adapter supplies the local reference for v2 catalog projection and protocol selection.

Authenticated `/api/v2/config` supplies enabled models supporting text input and output, endpoint URLs, protocol, wire identifiers, and capacity. Models omitting modality metadata use text defaults. Supported packages use Anthropic Messages, OpenAI Responses, or OpenAI chat completions. A provider-qualified selection id remains distinct from the wire model id in durable replay. Prepared calls freeze the catalog entry, account, organization, and options together. Discovery errors do not fall back to public models or another account.

Inference `403 FreeTierError` reports `POLICY_REJECTED` with instructions to select another Console model or use the official OpenCode client. Structured `403 SsoRequired` reports `SSO_REQUIRED` with reconnect instructions. These failures preserve safe recovery messages without echoing provider response fields or treating them as invalid API keys; ordinary authentication and unrecognized responses retain shared SDK error handling.

<a id="model-experience"></a>
## Model Experience

### Console model request and response

#### What the model sees

The model receives FI's recorded system prompt, conversation, and actual tool declarations from `GenerateOptions` through shared pi-ai conversion. Advertised request defaults accept only numeric sampling fields and cannot replace credentials, system messages, tools, or conversation input. Requests include the Console organization's authentication and native session-routing headers. pi-ai projects text, reasoning, tool calls, usage, finish reasons, and replay metadata into the existing session protocol; consumer cancellation and idle deadlines abort the transport.

#### Token effect

Provider responses supply token counts and cache usage; absent advertised capacities use the configured defaults. Input conversion preserves the recorded text and tool declarations without transport-only schemas.

#### KV Cache effect

Replay preserves ordered conversation blocks and supported native signatures. The session routing headers remain stable for a durable session and are model-hidden metadata.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This adapter serves text input/output. Images, native search, provider-specific reasoning controls, and remote MCP/policy installation are not offered. The upstream free-tier lane may reject requests with `FreeTierError`; this adapter preserves the recorded tool declarations instead of appending hidden compatibility tools. Free-tier quotas and Console balance remain provider-owned.

**Runtime invariant:** No companion is published. The credential store owns grant serialization; each prepared call retains one immutable catalog/credential generation without an independent registration mirror.

Organization-managed policies require the official OpenCode client; a catalog declaring policies is rejected rather than silently ignoring them.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
