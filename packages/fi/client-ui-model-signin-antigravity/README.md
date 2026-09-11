# @fi/client-ui-model-signin-antigravity

[English](README.zh.md) | 中文

Models-page Antigravity sign-in card for fi. Adds a footer section to the Models settings page offering "Sign in with Antigravity" when the Host has registered the flow and no grant is stored.

## Table of Contents

- [Summary](#summary)
- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Summary

`@fi/client-ui-model-signin-antigravity` adds OAuth sign-in to the Models settings page for Antigravity. It renders in the page's footer slot, runs the Google PKCE conversation, and chains the Host's `adopt` to upsert the settings route and enumerate models.

## What it does

- Registers into the `settings.models.footer` slot
- Offers "Sign in with Antigravity" when the flow is registered and no grant is stored
- Runs the OAuth conversation: notices (URL to open), prompts (paste code), settled outcome
- Chains `adopt('fi-antigravity/antigravity')` on success to create the route and list models
- Shows "Remove sign-in" when a grant is stored, using `revoke`

## How it works

The plugin mounts the `authorization` Remote namespace itself (the application Remote owner's client side mounts only a curated namespace list), then enters a scoped fiber that lists the namespace in its inject. It registers into the `settings.models.footer` slot through `slots.inject()`, which waits for the Models section to declare the slot.

## Model Experience

The user sees a footer section on the Models page offering Antigravity sign-in. Clicking it opens the Google OAuth URL in a browser, waits for the loopback callback, and on success shows the route outcome and the models the route now serves.

## Known Limitations and Deferred Work

- The card only appears in the footer; Antigravity is not in pi-ai's catalog, so there are no pi-ai provider cards to extend.
- The OAuth flow requires a browser (loopback callback). Headless environments need manual mode.
- The card's store is separate from the pi-ai card's store; both can be active simultaneously.
