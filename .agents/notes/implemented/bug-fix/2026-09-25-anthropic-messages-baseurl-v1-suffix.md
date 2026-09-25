# Agent Note: Anthropic Messages baseURL /v1 suffix

Status: implemented

English | [中文](2026-09-25-anthropic-messages-baseurl-v1-suffix.zh.md)

## Problem

The settings surface's baseURL placeholder coaches the OpenAI-style convention, a root ending in `/v1`. pi-ai's Anthropic SDK wrapper appends `/v1/messages` to a route's configured baseURL verbatim, so a `anthropic-messages` route configured with that coached spelling requested `/v1/v1/messages` and 404ed every request. `dsh-llm-pi-ai`'s own model-listing discovery (`discovery.ts`) already normalizes this same coached suffix for its `GET /v1/models` probe; `resolveRouteModels` in `catalog.ts`, which stamps the baseURL that model requests actually use, did not.

## Decision

`catalog.ts` exports `protocolBaseUrl(api, baseUrl)`, called at the one site in `resolveRouteModels` that resolves a model's baseURL after its api is known. For `anthropic-messages` it strips trailing slashes and one trailing `/v1` segment (case-insensitive); every other protocol's baseURL is returned unchanged, because OpenAI-style SDKs need the `/v1` they are given. This is a distinct fix from `dsh-llm-deepseek`'s `messagesApiRoot`, which *appends* `/v1` for DeepSeek's own Messages API when a configured root omits it — the two packages normalize different protocols in opposite directions and do not share a helper.

## Alternatives considered

- **Normalize in pi-ai itself.** Rejected: pi-ai is a vendored third-party client; this harness only controls the baseURL it hands to pi-ai's Anthropic wrapper.
- **Normalize for every protocol.** Rejected: an OpenAI-style protocol's baseURL is used as written, with no interior `/v1` insertion, so stripping one there would corrupt a correctly configured route.

## Consequences

An `anthropic-messages` route configured with either the coached `/v1`-suffixed spelling or the bare root now requests the same endpoint. `discovery.ts`'s listing-URL normalization and this catalog-resolution normalization solve the same coached-spelling problem for two different requests (model listing vs. model requests) and must both be kept if either protocol's endpoint convention changes.
