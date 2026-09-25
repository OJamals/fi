# Agent Note: Give FI Desktop its own Harness home

Status: implemented

English | [中文](2026-09-15-fi-desktop-data-home.zh.md)

## Problem

FI Desktop and CLI dsh can start separate processes against one default `.dsh` home. A live CLI writer may hold a session lock, preventing Desktop from resuming that session and changing its model or agent preset. Sharing the entire home also makes Desktop startup depend on CLI-owned settings, credentials, and plugin profile data.

## Decision

FI Desktop resolves one Harness home before profile access or Host startup. Without a nonblank `DSH_HOME`, the home is `<Electron userData>/harness`; on macOS, the normal FI application path is `~/Library/Application Support/fi/harness`. Electron passes the resolved absolute home to its profile operations and as `DSH_HOME` to the bundled Host process. Upstream dsh keeps its existing home-path resolution and session, storage, settings, credential, attachment, and preset paths relative to that home.

A nonblank `DSH_HOME` remains an explicit opt-in to an existing home. FI does not copy, move, delete, or fall back to data in the CLI home. First launch under the FI home therefore has no CLI session history or configuration. Development launchers retain their disposable `DSH_HOME` unless explicitly overridden.

The [Electron packaging decision](2026-08-25-electron-desktop-packaging-and-updates.md) continues to own the reserved profile, executable packages, update identity, and package-manager state. This decision replaces only its default shared-data-root assumption.

## Alternatives considered

**Redirect sessions alone.** Other durable services and the Desktop profile would still use the CLI home, and the two processes would no longer agree on one Harness home. This would require FI-only path changes inside upstream packages.

**Import CLI data automatically.** Existing sessions, settings, credentials, and plugin state may be incompatible or active under another writer. A clean FI home avoids unrequested migration and preserves the CLI data intact.

**Keep the shared default.** Session locks prevent concurrent writers, but normal Desktop actions can fail when a CLI process owns the same session. Users may opt into that behavior with `DSH_HOME` when sharing is intentional.

## Consequences

- Default FI and CLI processes do not contend for the same session lock or storage files.
- Desktop and its Host use one resolved home; upstream home-relative paths remain unchanged.
- Existing CLI history remains in its original home and is not visible in a clean FI home.
- Explicit `DSH_HOME` sharing retains upstream format-version and lock protections and may still produce session ownership errors when another writer is active.
- The running application and any existing data are unchanged until a FI build using this source starts.
