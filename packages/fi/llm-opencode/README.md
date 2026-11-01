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

Catalog reads retry recognized transient network failures with `catalogRetryCount` (default `3`, `0` disables retries) and `catalogRetryDelayMs` (initial delay, default `500`). Delays double on each retry, capped at `requestTimeoutMs`; all attempts and backoff share that deadline and caller cancellation. Exhausted retries report the network code, destination host, attempt count, and recovery guidance. Authentication, redirects, certificate errors, invalid catalogs, and token exchanges are not retried. This follows the bounded backoff strategy documented by [Undici RetryHandler](https://github.com/nodejs/undici/blob/main/docs/docs/api/RetryHandler.md), without replacing the application's fetch transport.

`catalogCacheMs` (default `300000`; `0` reloads for every call) reuses an authenticated catalog for the same Console server, account, and organization. Concurrent readers share one load, and a caller's cancellation ends only its own wait. Model discovery for the picker always reloads, and a failed load is never answered with an earlier catalog. `registryCacheMs` (default `300000`) and `registryStaleMs` (default 24 hours) bound reuse of the public model registry described under Protocol sources.

### Native client proxy

A local auth2api server with `OPENCODE_NATIVE_BINARY` can serve existing `opencode-console` sessions through the generic pi-ai adapter. Configure that route with `api: openai-completions`, the proxy's `/v1` URL, a credential-store reference in `apiKeyEnv`, `headers: { x-auth2api-provider: opencode }`, and its discovered bare model IDs. Disable this plugin's Loader entry to avoid two adapters owning the route, and remove that route from `agent-default-model.subscriptionCredentials`; keep the default provider/model selection. OAuth grants remain in the credential store. The API caller executes tools; the native bridge blocks local tool execution and preserves streaming. Hosted free-tier quota and policy failures remain visible. The proxy must be running before a model request.

## Protocol sources

The canonical [provider metadata](../provider-compat/src/provider-settings.json) pins the OpenCode Console plugin and model-request source references for device tokens, organization scope, and client/session headers. Auth2api's adapter supplies the local reference for v2 catalog projection and protocol selection.

Authenticated `/api/v2/config` supplies enabled models supporting text input and output, endpoint URLs, protocol, wire identifiers, capacity, and reasoning controls. Models omitting modality metadata use text defaults. Supported packages use Anthropic Messages, OpenAI Responses, OpenAI chat completions, or Google Gemini `streamGenerateContent`. A provider-qualified selection id remains distinct from the wire model id in durable replay. Prepared calls freeze the catalog entry, account, organization, and options together. Discovery errors do not fall back to public models or another account.

When the Console returns a workspace overlay that omits packages, endpoints, or models, the public registry at `https://models.opencode.ai/api.json` completes it. Only providers the authenticated Console lists are admitted, Console fields win, `disabled` entries stay hidden, and registry routes outside `opencode.ai` are dropped. Registry `modalities`, `limit`, `status`, `reasoning`, and `reasoning_options` fill fields the Console omits. The registry request carries no credentials or organization headers and rejects redirects; its copy is revalidated with ETag and Last-Modified, shared by concurrent readers, and capped at 32 MiB. A provider the registry lacks is logged and omitted without discarding the others.

A model lists reasoning efforts through Console `capabilities.reasoning` or registry `reasoning_options`. Anthropic and Google routes whose models offer only a toggle or token budget advertise `low`, `medium`, and `high`, plus `none` for a toggle; models with unknown controls advertise none. A selected effort is encoded for the route: `reasoning_effort` for chat, `reasoning.effort` for Responses, `thinking` with `output_config.effort` or a token budget below `max_tokens` for Anthropic according to the Claude family, and `thinkingConfig` for Gemini. Anthropic requests drop `temperature` and `top_k` while thinking is on, because that API rejects them. `off` selects `none` where the model lists it and otherwise keeps the model default; any other unadvertised effort is refused before dispatch.

Google routes build their request with pi-ai's OpenAI Chat adapter, and `callGeminiChat` from [`@fi/llm-antigravity`](../llm-antigravity/README.md) translates it to a bare Gemini request posted to `{baseURL}/models/{id}:streamGenerateContent?alt=sse` with `x-goog-api-key` and the OpenCode client headers. The path comes from the catalog entry, never from the SDK body. Endpoint admission, redirect rejection, and the `402`, `429`, and `403` classification apply as on other routes; the OpenAI-compatible free-tier retry does not. Without a selected effort, Gemini 3 models return thought summaries.

OpenAI-compatible inference retries `403 FreeTierError` with auth2api-compatible streaming and tool selection. Chat backends rejecting restricted selection with HTTP 400 or 5xx get one `auto` attempt; local validation still rejects undeclared or disabled tools. If `https://opencode.ai/inference/openai/v1/chat/completions` still returns `403 FreeTierError`, one final attempt sends the original request to `https://opencode.ai/zen/v1/chat/completions`, preserving the model, grant, organization, headers, and conversation. This route recovery requires SSE and never applies to other endpoints, protocols, authentication errors, or SSO failures. Persistent free-tier rejection reports `POLICY_REJECTED`. Structured `403 SsoRequired` reports `SSO_REQUIRED` with reconnect instructions. The Console's exact `402` insufficient-funds body and `429 FreeUsageLimitError` report the terminal `QUOTA` failure instead of a retryable error; no provider response fields are exposed. Other errors retain shared SDK handling.

<a id="model-experience"></a>
## Model Experience

### Console model request and response

#### What the model sees

The model receives FI's recorded system prompt, conversation, and actual tool declarations from `GenerateOptions` through shared pi-ai conversion. Advertised request defaults accept only numeric sampling fields and cannot replace credentials, system messages, tools, or conversation input. Requests include the Console organization's authentication and native session-routing headers: `x-opencode-session-id` plus the session, affinity, and session-id names carrying the same value. A selected reasoning effort adds the route's native reasoning fields. pi-ai projects text, reasoning, tool calls, usage, finish reasons, and replay metadata into the existing session protocol; consumer cancellation and idle deadlines abort the transport.

#### Token effect

Provider responses supply token counts and cache usage; absent advertised capacities use the configured defaults. OpenCode prompt assembly adds missing `read` and `shell` compatibility declarations before the request header is logged. Their schemas require string `path` and `command` fields respectively; empty schemas fail Console free-tier validation. Existing same-name tools retain their definitions. Added declarations consume input tokens and cannot execute; direct adapter calls without a Session receive the same declarations during conversion.

#### KV Cache effect

Replay preserves ordered conversation blocks and supported native signatures. Session routing headers encode OpenCode's descending timestamp and remain stable for a durable session during the adapter's lifetime. They are model-hidden metadata.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This adapter serves text input/output. Images, native search, parent-session routing, and remote MCP/policy installation are not offered, and reasoning is limited to efforts the Console or registry lists. Free-tier quotas, model availability, and Console balance remain provider-owned; catalog visibility alone does not establish inference availability.

**Runtime invariant:** No companion is published. The credential store owns grant serialization; each prepared call retains one immutable catalog/credential generation without an independent registration mirror.

Organization-managed policies require the official OpenCode client; a catalog declaring policies is rejected rather than silently ignoring them. Protocol selection accepts only the three supported package names, optionally prefixed with `aisdk:`; inherited JavaScript object-property names cannot advertise a protocol.

### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
