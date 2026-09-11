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
- Provides the Cloud Code transport: `streamGenerateContent` with the Antigravity envelope

## How it works

The OAuth flow uses the Antigravity desktop app's public client id, a loopback redirect on `127.0.0.1:54545`, and five scopes including `cloud-platform` and `cclog`. After exchange it discovers the `cloudaicompanionProject` via `loadCodeAssist`, which becomes the billing project every inference request names.

The transport wraps Gemini `contents`/`generationConfig` in the Cloud Code envelope (`{project, model, request, userAgent: "antigravity", requestId, requestType: "agent"}`) and POSTs to `v1internal:streamGenerateContent?alt=sse`.

## Model Experience

The adapter enables the Models page to offer Antigravity sign-in. Once signed in, the provider appears with its models listed, and inference requests route through the paid Cloud Code endpoint.

## Known Limitations and Deferred Work

- The OAuth flow requires a browser (loopback callback). Headless environments need `--manual` mode or a pre-authorized token file.
- The transport is not yet wired into fi's `llm.discoverModels` — the route is created by the authorization controller's `adopt`, but model enumeration requires the Host's LLM service to recognize the `antigravity` provider id.
- Stealth is minimal: the UA string and `ideType: "ANTIGRAVITY"` in discovery are the only identity claims, both capture-derived.
