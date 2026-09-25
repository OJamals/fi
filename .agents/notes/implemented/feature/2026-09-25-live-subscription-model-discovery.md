# Agent Note: Live subscription model discovery for pi-ai routes

Status: implemented

English | [中文](2026-09-25-live-subscription-model-discovery.zh.md)

## Problem

fi's Claude Code, Codex, and Grok routes list only pi-ai's installed catalog for `anthropic`, `openai-codex`, and `xai`; a signed-in account's new release stays invisible until the vendored catalog catches up, unlike the fork's native Antigravity adapter, which already lists live models beyond its static fallback.

## Decision

[`@deepseek-ai/dsh-llm-pi-ai`](../../../../packages/llm/llm-pi-ai/README.md) gained one generic, provider-agnostic extension point: the `llm-pi-ai/live-models` waterfall. The adapter calls it only for a route with no curated `models` list whose stored credential resolves through pi-ai's own `Models.getAuth` to `OAuth`, and only for a provider pi-ai's installed catalog marks `auth.oauth.isSubscription`. A live id absent from the installed catalog is served as a clone of its closest catalog template — the model whose id shares the longest prefix, or the route's first model when none shares any — so it streams through the same api, baseUrl, and compat quirks as its family; id and name are the only fields that change. `listModels`, `resolveModel`, a request naming a live-only id, and this package's own `discoverModels` (used by the adopt flow and "fetch available models") all resolve through this one path.

[`@fi/provider-compat`](../../../../packages/fi/provider-compat/README.md) is the sole listener. It fetches Claude Code's `/v1/models`, Codex's `/codex/models` (with `If-None-Match` ETag reuse), and Grok's `/models`, each with the exact identity `subscriptionHeaders` already builds for a chat request, and caches each provider's list for a deployment-configured TTL (`liveModelDiscoveryCacheTtlMs`, default five minutes) behind a stale-while-error policy; `liveModelDiscoveryEnabled` turns the whole mechanism off. No fi provider id is named inside `llm-pi-ai`.

Re-listing after a fresh sign-in reuses the existing `llm/adapters-updated` announcement rather than adding a second one: a brand-new route already retriggers it through the ordinary route-set-changed path, and `registerPiAiFlows`'s new `onSignedIn` callback forces the same announcement for a route that already existed under a weaker or absent grant, since that case changes no registration fact the existing path tracks.

## Alternatives considered

**Bake live ids into pi-ai's `Provider.getModels()` return value** — rejected: that function is read synchronously while profile resolution builds the collection, and live discovery is inherently an async, cached network call. Merging at the adapter level (`listModels`/`resolveModel`/`stream`) keeps the collection's synchronous contract intact and lets the merge always reflect the latest cached listing.

**Let the fi listener build full pi-ai `Model` descriptors itself** — rejected: cloning a template model requires catalog knowledge (compat block, reasoning maps, baseUrl) that already lives in `llm-pi-ai/catalog.ts`. Asking `@fi/provider-compat` to reconstruct that logic would duplicate it and risk drifting from it. The waterfall carries only ids and optional names; `llm-pi-ai` does the cloning.

**A new dedicated re-announce event** — rejected: `AdapterRegistrationHandle.replace()` already exists and already emits `llm/adapters-updated` unconditionally on every call. Replaying the same route set through it is a one-line reuse instead of a second mechanism the Web model picker would need to learn.

**Expose only the provider string to the live-models listener, resolving the token through a separate credential read** — rejected: a live listing is a side call the listener originates itself, unlike `llm-pi-ai/request-transport`'s header/fetch transform of a request pi-ai's own SDK already authenticated. The listener needs the resolved token to make that call at all, so the adapter hands it over directly after performing the one `Models.getAuth` check itself; the listener never reads a raw credential.

## Consequences

A subscription account gains new models the moment pi-ai's installed catalog has not caught up, without a package release. An ambient or API-key route, and a curated `models` list, are never touched — the gate that decides whether a route may be augmented lives entirely in `llm-pi-ai`, never in the listener. A live-listing outage degrades to the installed catalog only: it cannot break `listModels`, `resolveModel`, a request, or discovery, because every failure path resolves to an empty live list rather than propagating.

`@fi/provider-compat`'s cache is per plugin instance and per provider, not per account: a deployment routing more than one account through the same provider route sees whichever account's listing last refreshed until the next TTL boundary. Nothing here polls in the background; a cache only refreshes when `listModels`, discovery, or a request actually reaches that path after the TTL elapses.

## Required verification

Unit tests with local mock HTTP servers cover each provider's request URL and headers (no real tokens), response parsing, the Anthropic `claude-*` prefix filter and Codex `visibility: "hide"` filter, the Codex ETag 304 path, TTL expiry and refresh, and failure falling back to the installed catalog — in [`packages/fi/provider-compat/tests/provider-compat.host.spec.ts`](../../../../packages/fi/provider-compat/tests/provider-compat.host.spec.ts). Adapter-level tests cover the OAuth/full-catalog gate, a curated `models` list staying untouched, a live-only id resolving and streaming through its cloned template, and `listModels` reflecting a later hook change — in [`packages/llm/llm-pi-ai/tests/live-models.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/live-models.spec.ts) and [`clone-live-model.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/clone-live-model.spec.ts). Discovery-merge behavior is covered in [`discovery.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/discovery.spec.ts), and the sign-in re-announce callback in [`login.spec.ts`](../../../../packages/llm/llm-pi-ai/tests/login.spec.ts).
