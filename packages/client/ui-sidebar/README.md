---
description: "Sidebar shell plugin for the dsh web client: brand row, New Session action, collapse control, scroll-aware region seat, and bottom-pinned Settings seat."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar

English | [中文](README.zh.md)

Desktop product events use the optional [product analytics service](../product-analytics/README.md); ordinary Web interactions are excluded.

## Summary

The dsh web client sidebar lets users recognize the active build, start a new session, collapse navigation to a 56px rail, browse Workspaces and Sessions, and open Settings. It preserves a bottom-pinned Settings entry and hides idle scrollbars without moving browser rows. New Session uses an explicitly selected Workspace, then the current Session's Workspace, then the most recently active Workspace; if none exists, it opens a blank New Session page. Deployments can replace the brand mark or name while retaining the navigation controls and rail geometry.

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

The sidebar is the navigation shell: users see the brand, start new sessions, collapse the rail, and reach Settings. Feature plugins fill its seats — ui-workspace fills `sidebar.workspaces`, ui-settings registers the trigger row and settings panel at `sidebar.settings`.

### Brand and New Session

The expanded brand row renders `sidebar.brand.mark` and `sidebar.brand.name` as independent single slots; the collapsed rail renders the same mark slot. The expanded mark owner requests a 40px square; the collapsed owner requests 24px. On Web and Windows desktop, clicking the expanded brand starts a new session; on macOS desktop, a dedicated top strip above the logo row houses the sidebar toggle clear of the native traffic lights, and the logo row tucks in 12px below it. Without occupants, the shell uses the fish mark and a localized local-build label. A complete build stacks a code badge below the label as `version[-commit][-dirty]`, using `DSH_CLIENT_VERSION`, the optional 7-character `DSH_CLIENT_COMMIT_HASH`, and `DSH_CLIENT_GIT_DIRTY=true`; missing version metadata omits the badge. New Session targets the explicit Workspace used by a scoped action, otherwise the current Session's Workspace, otherwise the most recently active Workspace; when none exists it clears into the blank New Session page. The expanded New Session button displays the effective binding as trailing grey text on hover or keyboard focus. While the shortcut is visible, the centered icon and label fade before it when space is narrow; CSS reserves the shortcut’s width without measuring the button. Icon-only controls retain tooltips with platform-formatted keycaps, including the resident macOS header control when the sidebar is hidden. All controls expose `aria-keyshortcuts`.

### Global panel entries

Plugins add an icon component to the root-scoped `sidebar.panellist` list with an `id`, optional `order`, and a string or locale-aware `label`. The same id addresses the component registered in the layout's root-scoped `main` keyed slot; selecting a missing main entry throws without changing the current selection. The label supplies plain visible text, the accessible name, and the collapsed tooltip. Each row reads its own selected state through `usePanelInfo`; moving DOM focus to search or a directory picker does not change the displayed panel or its selected row. With no registrations, neither the list nor spacing for it is rendered. The shipped composition registers no example panel.

### Collapse behavior

Back and Forward sit beside the sidebar toggle, with localized labels and disabled buttons at history ends. They use the [Workspace navigation service](../ui-workspace/README.md#understand-the-implementation). The collapsed Web rail stacks the three controls vertically; the hidden macOS sidebar moves them into the header before New Session.

The sidebar and conversation-header toggles show the effective shortcut from the command catalog in their hover and keyboard-focus tooltips and `aria-keyshortcuts`. An unbound command shows only the action label.

The top expand button hosts the optional, non-interactive `sidebar.toggle.badge` slot while collapsed. Its occupant supplies status and tooltip content without adding another action or changing the button's navigation behavior.

During a live collapse, the expanded content fades out at its current width, the upper controls share one fade and leftward translation into the 56px rail, and the layout's column slide ends the motion. A page that starts collapsed renders the rail statically, and reduced-motion mode disables both transitions. The bottom-pinned `sidebar.settings` control shares the fade timing but has no horizontal translation.

On Windows Electron, `html[data-windows-titlebar]` fixes the sidebar toggle, Back, and Forward in the caption's top-left corner. The expanded brand sits below the caption and above New Session, with 8px of extra space above that button. Collapsing hides the brand and sidebar content and places New Session after Forward. The sidebar sets `--dsh-windows-menu-start` to 120px expanded and 156px collapsed so Desktop menus clear the controls. Caption controls exclude themselves from the window drag region; their tooltips open below the menus. An occupying `sidebar.toggle.badge` chooses its own tooltip side.

### macOS desktop

Under `html[data-platform='darwin']` (set only by the desktop preload), the expanded column opens with a 52px top strip that clears the hiddenInset traffic lights and carries the sidebar and history controls. The strip and logo row mark themselves `data-window-drag`; ui-web base.css makes each row's box draggable while buttons stay clickable. The brand is a drag surface; the dedicated New Session button owns that action. Collapse hides the column entirely. `HeaderLeadingControls` then occupies the frame's `shell.leading` seat beside the traffic lights over every main panel, with sidebar, Back, Forward, and New Session controls. See the [macOS hidden-titlebar Agent Note](../../../.agents/notes/implemented/feature/2026-09-13-macos-hidden-titlebar-vibrancy.md).

### Scrollbars

Scrollbars in the column are a pointer affordance: the shell rebinds the scrollbar indirection to `transparent` whenever the pointer is outside the column and keeps the thumb drawn for 2s after the pointer leaves, so a list nobody is pointing at carries no bar. The reservation that keeps rows from moving belongs to the scrolling region (ui-workspace), so revealing a thumb never reflows.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The shell is pure composition: `SidebarRootComponentProps` composes the layout owner share, the global `useSessions` and `useWorkspaces` hooks, the declared brand, the `sidebar.workspaces` and `sidebar.settings` child slots, and injected navigation callbacks. Panel entries and their optional titles use the same composition path. Panel metadata is derived from list registrations and locale changes; selection belongs to the layout store.

### Slot discipline

Declaration-aware `slots.inject()` lets a replacing package activate before or after the sidebar. The foot is the `sidebar.settings` seat: the sidebar renders only the bottom-pinned layout slot and shares its column state (`wide`). The `/client` exports are the plugin body (`apply`/`inject`) plus the contract types only; SidebarRoot, the row components, and the tree derivation remain package-internal behind the slot registration.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover the surfaces that fill the shell's seats and the composition model.

- [ui-workspace](../ui-workspace/README.md) — the Workspace and Session browser rendered into `sidebar.workspaces`.
- [ui-settings](../ui-settings/README.md) — the settings domain base registering the trigger row at `sidebar.settings`.
- [ui-layout](../ui-layout/README.md) — the layout owner whose rail and column state the collapse uses.
- [ui-theme](../ui-theme/README.md) — the scrollbar token indirection the shell rebinds.
- [Slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) — the composition model behind the seats.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the shell owns versus what its occupants own; they are current package constraints.

- **Session state-dot rendering is owned by ui-workspace** — no done/error notification sources are available to this shell.
- **Workspace browser behavior is composition-owned** — grouping, ordering, search, and row state belong to ui-workspace, not this shell.
- **"New task completed" unread marking is local viewing state** — completion-time > last-seen never reaches the host.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Panel metadata is a read-only presentation projection of the Slot registry and locale, with no independent write API. The registry owns entry identity and disposal; this package's assembly tests assert the projection after registration and locale notifications settle. The shell owns no separate navigation state to reconcile with those sources.
