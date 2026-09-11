# Agent Note: model-universal first-run setup

Status: implemented

English | [中文](2026-09-10-model-universal-onboarding.zh.md)

## Problem

The first-run onboarding step presumed the official DeepSeek provider. Its readiness join special-cased the `deepseek-official` row — every other vendor fact ended the step silently — and the visible step asked for a DeepSeek API key, reusing the Models page's credential editor inside the onboarding modal. A fi user with no provider yet was funneled to one vendor's key field, while a user whose join was merely read-only or credential-unreadable was skipped with no route to any setup surface.

## Decision

The step is provider-neutral and routes instead of collecting. `onboardingReadiness` now answers one question — can the user talk to some model yet — from the same provider/settings/credential join the Models page reads: any usable provider ends the step; no usable provider, for every reason the old flow treated as skip-worthy (inactive provider, unreadable credentials, read-only settings), shows it; only a failed join load or a catalog with no configurable providers at all skips, because neither can be acted on from the settings surface. The step itself (`ModelSetupDialog`, slot id `model-setup`, replacing `deepseek-official`) presents neutral copy with a primary action that completes the step and routes to the Models section through the shell's existing `openSection` seam, and a secondary action that defers. No credential is entered in onboarding: the Models page meets an unconfigured provider with its setup card already open, so the routed user types a key there — for any provider, shipped or user-added.

The `agent-default-model` composition row and its settings section are unchanged: a default selection remains plumbing for agents created without an explicit pick, and the saved selection still overrides it. Nothing in the prompt, persona, or routing layers names a vendor.

## Alternatives considered

**Keep collecting the official key in the modal.** It presumed one vendor at the exact moment the product should be provider-neutral, and a deferred user was left with a dead default provider and no route.

**Collect a provider-agnostic key field in onboarding.** "Which provider's key?" has no answer without the provider list, and the field would duplicate the Models page's editor — the page whose whole job is that join.

**Auto-complete on read-only or unreadable joins, as before.** Those states describe one provider's repairability, not the user's; routing to the Models page is actionable in every one of them, and a skipped first-run user has nowhere else to learn that setup exists.

## Consequences

First run no longer funnels to DeepSeek: the welcome notice is followed by a neutral setup step that routes to Settings → Models, where the credential is written (the e2e now drives the key write through that page's auto-opened setup card). The step id changed from `deepseek-official` to `model-setup`, and the onboarding copy keys `onboardingSave`/`onboardingSaving` left the dictionary with the embedded editor. Inactive, credential-unreadable, and read-only joins now show the step where they previously skipped — each is resolvable or diagnosable from the page the step routes to. The web e2e scenario `onboarding-deepseek-config` was renamed `onboarding-model-setup` with its goldens. A deferred user who starts a session still reaches the default selection's provider and its credential error; that error's routing is future work.
