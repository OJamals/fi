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

`server`, `clientId`, and `userAgent` configure the Console endpoint and public client identity. Endpoint, OAuth, and catalog defaults come from the canonical `opencodeConsole` record in [`@fi/provider-compat`](../provider-compat/README.md). The default User-Agent comes from the [verified client capture](src/client-capture.json), independently of release metadata; advancing it requires a new capture and live inference validation. `requestTimeoutMs`, `streamIdleTimeoutMs`, `refreshMarginMs`, `defaultContextWindow`, and `defaultMaxTokens` configure deadlines and missing advertised capacity. Endpoints accept only HTTPS OpenCode domains; all requests reject redirects.

Route profiles accept `displayName` and a `models` array of selected ids. An absent array exposes all advertised models; an empty array hides them all. Discovery always returns the complete authenticated catalog. Selection affects the picker, not explicit resolution or prepared calls; the grant still chooses the account and organization. Default provider names use the lowercase route id.

Catalog reads retry recognized transient network failures with `catalogRetryCount` (default `1`, `0` disables retries) and `catalogRetryDelayMs` (default `250`). All attempts and backoff share one `requestTimeoutMs` deadline and caller cancellation. Exhausted retries report only the network code and recovery guidance. Authentication, redirects, certificate errors, invalid catalogs, and token exchanges are not retried.

## Protocol sources

The canonical [provider metadata](../provider-compat/src/provider-settings.json) pins the OpenCode Console plugin and model-request source references for device tokens, organization scope, and client/session headers. Auth2api's adapter supplies the local reference for v2 catalog projection and protocol selection.

Authenticated `/api/v2/config` supplies enabled models supporting text input and output, endpoint URLs, protocol, wire identifiers, and capacity. Models omitting modality metadata use text defaults. Supported packages use Anthropic Messages, OpenAI Responses, or OpenAI chat completions. A provider-qualified selection id remains distinct from the wire model id in durable replay. Prepared calls freeze the catalog entry, account, organization, and options together. Discovery errors do not fall back to public models or another account.

OpenAI-compatible inference retries `403 FreeTierError` with auth2api-compatible streaming and tool selection. Chat backends rejecting restricted selection with HTTP 400 or 5xx get one `auto` attempt; local validation still rejects undeclared or disabled tools. Persistent free-tier rejection reports `POLICY_REJECTED`. Structured `403 SsoRequired` reports `SSO_REQUIRED` with reconnect instructions; other errors retain shared SDK handling.

<a id="model-experience"></a>
## Model Experience

### Console model request and response

#### What the model sees

The model receives FI's recorded system prompt, conversation, and actual tool declarations from `GenerateOptions` through shared pi-ai conversion. Advertised request defaults accept only numeric sampling fields and cannot replace credentials, system messages, tools, or conversation input. Requests include the Console organization's authentication and native session-routing headers. pi-ai projects text, reasoning, tool calls, usage, finish reasons, and replay metadata into the existing session protocol; consumer cancellation and idle deadlines abort the transport.

#### Token effect

Provider responses supply token counts and cache usage; absent advertised capacities use the configured defaults. OpenCode prompt assembly adds missing `read` and `shell` compatibility declarations before the request header is logged. Their schemas require string `path` and `command` fields respectively; empty schemas fail Console free-tier validation. Existing same-name tools retain their definitions. Added declarations consume input tokens and cannot execute; direct adapter calls without a Session receive the same declarations during conversion.

#### KV Cache effect

Replay preserves ordered conversation blocks and supported native signatures. Session routing headers encode OpenCode's descending timestamp and remain stable for a durable session during the adapter's lifetime. They are model-hidden metadata.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This adapter serves text input/output. Images, native search, provider-specific reasoning controls, and remote MCP/policy installation are not offered. Free-tier quotas, model availability, and Console balance remain provider-owned; catalog visibility alone does not establish inference availability.

**Runtime invariant:** No companion is published. The credential store owns grant serialization; each prepared call retains one immutable catalog/credential generation without an independent registration mirror.

Organization-managed policies require the official OpenCode client; a catalog declaring policies is rejected rather than silently ignoring them. Protocol selection accepts only the three supported package names, optionally prefixed with `aisdk:`; inherited JavaScript object-property names cannot advertise a protocol.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
