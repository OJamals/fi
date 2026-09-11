---
description: "Official fi brand occupants for the sidebar and conversation hero, active only in official builds; for users and maintainers choosing or replacing brand presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

## Summary

This package gives an `official` client build the self-lettered fi artwork in the sidebar and new-session hero. Light mode uses the default artwork; dark mode replaces its dark fill with white while preserving the cyan and purple accents. The sidebar places complete build metadata beneath the artwork without repeating fi as adjacent text. Other build profiles keep the shell's fish mark and local-build label. Choose it for deployments branded as fi; deployments with another identity provide a replacement brand package. It has no runtime state and does not affect model requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in the browser roster of a deployment branded as fi, then build the client with the `official` profile so the occupants register.

### Choosing the profile

`DSH_CLIENT_BUILD_PROFILE` selects which brand renders. An `official` build shows the self-lettered fi artwork with build metadata beneath it in the sidebar and the same artwork without metadata in the conversation hero. Both surfaces follow the shared `body[data-ds-dark-theme]` state: light mode reads `/fi-logo.png`, while dark mode reads `/fi-logo-dark-background.png`. Any other profile leaves the shell fallbacks — the fish marks and the local-build label — in place. The plugin still loads and validates in both cases; only the registration is profile-gated.

### Replacing the brand

A deployment with its own identity leaves this package out and composes another package that occupies both sidebar slots and the conversation-hero slot. Occupying a slot is the only composition route; there is no brand configuration surface here.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The three occupants install as one declaration-aware registration set: nested `ctx.slots.inject()` calls wait on the sidebar and conversation-hero declarations, so the set works whether this row activates before or after the declarers, withdraws every occupant when a declaration collapses, and leaves no partial brand mix during HMR. The sidebar name occupant intentionally renders nothing, which suppresses the generic adjacent label because the artwork already spells fi. The sidebar mark receives build metadata from its owner and renders it beneath the image. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The browser title is a build-environment concern (`DSH_CLIENT_TITLE`), outside the slot system.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark` and `sidebar.brand.name` and renders their fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how brand presentation is supplied. They are current package constraints, not a brand-design comparison or a task backlog.

- **One occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package retains no mutable state, and its three slot occupants install and leave through one transactional effect.
