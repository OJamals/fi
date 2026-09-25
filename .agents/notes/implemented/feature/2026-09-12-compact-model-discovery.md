# Agent Note: Compact model discovery

Status: implemented

English | [中文](2026-09-12-compact-model-discovery.zh.md)

## Problem

Large provider catalogs make an expanded model menu difficult to scan. Separate subscription sign-in rows repeat controls and consume Models settings space even when the user is working with only one account.

## Decision

The [composer picker](../../../../packages/client/ui-model-selection/README.md) retains its Model and Effort panes. Provider groups start collapsed on each fresh opening. Search matches provider and model names and identifiers without case or whitespace sensitivity, reveals matching models, and leaves browsing expansion unchanged when cleared. Catalog order and provider-qualified model identities remain authoritative.

Search and expansion belong to the component, not settings or Session data. The existing model directory still loads catalogs and submits selections through the native controller. The agent loop, Session formats, SDK projections, and upstream profile composition need no changes for model discovery.

The [subscription footer](../../../../packages/fi/client-ui-model-signin/README.md) uses one native provider selector with the selected account's status and actions. Choosing an account neither authenticates it nor selects an inference model. Running and completed attempts retain their provider attribution; model-adoption details use a disclosure. Authentication and credential ownership remain defined by the [subscription sign-in decision](2026-09-11-subscription-oauth-sign-in.md).

The [settings shell](../../../../packages/client/ui-settings-general/README.md) places its panel in a body portal so sidebar clipping cannot hide account controls. Narrow viewports use a full-height panel with horizontal navigation and a scrollable section, preserving the desktop layout and existing slots. React DOM supplies the portal; no separate overlay service or routing API is introduced.

## Alternatives considered

**Four permanent account buttons.** They avoid a selector interaction but retain repeated account controls and consume narrow layouts. A native selector provides all registered accounts through one keyboard-accessible control.

**An always-expanded or globally flattened catalog.** Expansion exposes thousands of rows, while flattening obscures which route owns duplicate model identifiers. Provider disclosure preserves ownership; search avoids scanning unrelated models.

**Persisted menu preferences or a separate catalog store.** Neither is required to select a model. Local presentation state avoids new settings, synchronization, and upstream controller changes.

## Consequences

Browsing a provider costs one disclosure interaction. Search bypasses that step without changing the active model or stored account. Transient state resets on a fresh opening, and the existing catalog remains the single source of model identities and reasoning options.

Focused component tests cover discovery, live catalog changes, operation recovery, and keyboard focus. Browser verification exercises the built Web composition, provider-qualified selection persistence, large catalogs, narrow layouts, and localized controls. These UI checks do not substitute for live subscription inference or media verification.
