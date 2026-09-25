# Agent Note: Subscription providers in the composer model picker

Status: implemented

English | [中文](2026-09-15-subscription-model-picker-section.zh.md)

## Problem

The composer model picker presents every Host catalog group in one undifferentiated list. Users cannot tell which routes use an existing subscription grant and which routes require ordinary API-key configuration. The Antigravity adapter also advertises `Antigravity` while the other subscription routes appear under lowercase route names.

## Decision

The generic client model-selection plugin owns `ctx.modelSubscriptions`, a display-only registration service, and renders matching, visible groups together in a labeled bottom section of the composer Model pane. FI's sign-in client plugin contributes `anthropic`, `openai-codex`, `xai`, and `antigravity` from the same route list that derives its subscription sign-in credential keys. Regular groups retain Host catalog order above the section; matching groups retain Host order within it. Blank or duplicate registered ids fail at registration. The section disappears when no registered subscription group has visible models, and a disposed contribution leaves the picker immediately.

The Antigravity adapter advertises its lowercase route id as its catalog provider name. The Models add-provider entry and sign-in label retain their own display names. The grouping changes no provider or model id, authentication action, inference route, durable Session event, or `/model` popup order. Search filters both sections before rendering and keyboard navigation follows displayed rows.

## Alternatives considered

**Sort the Host model catalog.** This would change `/model` and every other catalog consumer, even though subscription grouping is only a composer presentation need.

**Hardcode FI route ids in the generic picker.** This would bind an upstream-owned client package to FI's provider roster and prevent other compositions from choosing their own subscription routes.

**Badge every subscription provider.** Per-row labels would add noise to the compact picker without giving the services a distinct place in the list.

## Consequences

The bottom section makes subscription routes recognizable while preserving exact selection and catalog semantics. FI's sign-in roster owns the route list for both sign-in and picker grouping, so there is no second configured identity list to drift. The client package has one disposable registration service and one localized section label. Keyless browser evidence covers the section at desktop and narrow width; unit tests cover all four route ids, live registration, search, and unchanged popup ordering.
