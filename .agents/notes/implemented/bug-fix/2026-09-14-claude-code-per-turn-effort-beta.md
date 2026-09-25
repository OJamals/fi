# Agent Note: Claude Code per-turn effort beta

Status: implemented

English | [中文](2026-09-14-claude-code-per-turn-effort-beta.zh.md)

## Problem

The Anthropic subscription wrapper replaced pi-ai's request-specific `anthropic-beta` header with a captured static set. pi-ai emits a system message `output_config` for per-message effort, so Anthropic rejected that field when its enabling beta disappeared with `messages.<index>.output_config: Extra inputs are not permitted`.

## Decision

`subscriptionHeaders()` merges request-specific Anthropic betas with the captured Claude Code beta set. It maps pi-ai's public `mid-conversation-output-config-2026-07-01` name to `per-turn-control-2026-07-01`, the wire name observed from Claude Code 2.1.270. The wrapper keeps unrelated request-specific betas and removes duplicates.

Public release discovery remains separate from wire capture. The automatic updater can advance release metadata, but `version`, `fingerprintCapturedVersion`, and other capture-gated fields retain their reviewed evidence until a new protocol capture is recorded.

## Alternatives considered

**Keep the static captured beta set authoritative for every request.** This loses feature betas selected by pi-ai from the actual request body and recreates the reported rejection.

**Send pi-ai's public beta name unchanged.** [Anthropic documents that name](https://platform.claude.com/docs/en/build-with-claude/effort), but Claude Code 2.1.270 sends the private `per-turn-control-2026-07-01` wire name. The subscription transport follows the product request.

**Reimplement the Anthropic request body.** This duplicates pi-ai's message conversion, tool, thinking, streaming, and replay behavior. The defect is confined to compatibility-header replacement.

## Consequences

Mid-conversation effort requests retain their required beta while static Claude Code compatibility headers remain present. A loopback transport test rejects `output_config` unless the exact Claude Code beta is present. Release-update tests preserve the distinction between automatically refreshed release metadata and capture-gated protocol fields.
