# Agent Note: fi CLI and Web default home

Status: implemented

English | [中文](2026-09-25-fi-cli-home.zh.md)

## Problem

fi's CLI and Web profiles load DeepSeek Harness user data from `~/.dsh` by default, the shared upstream harness home. fi Desktop already resolves its own isolated home ([one Harness home for FI Desktop](2026-09-15-fi-desktop-data-home.md)), but fi's non-Desktop surfaces still load from the harness's own root, mixing fi state with any other DeepSeek Harness installation on the same machine and leaving fi's identity ([fi product identity](../feature/2026-09-10-fi-product-identity.md)) incomplete at the filesystem layer.

## Decision

fi's default harness home is `~/.fi`, set once in `@deepseek-ai/dsh-home-paths`'s `DSH_HOME_DIR_NAME` — the single resolver every home-relative path (sessions, settings, credentials, profiles, skills, attachments cache, the anonymous telemetry id) derives from. Every consumer that previously hand-derived the default outside that resolver (for example the historical Sessions-migration script) now calls the shared resolver instead of joining `.dsh` itself. A nonblank `DSH_HOME` still overrides the default with highest precedence, unchanged from [the single-resolver decision](2026-07-24-single-harness-home-resolver.md); no new environment variable is introduced, and `DSH_HOME`, `$DSH_HOME`-relative paths, and every other `DSH_*` identifier keep their existing names, matching the compatibility boundary the product-identity decision already drew.

fi Desktop's isolated `<Electron userData>/harness` home is unaffected: Desktop always supplies its own resolved home as the explicit override before falling through to the shared resolver, so it never reaches the changed default.

The CLI's own `web` profile template now includes fi's `@fi/authorization-bundle` after the two upstream bundles, matching the bundle order Desktop already ships, so a `dsh --profile web` boot loads fi's sign-in and model-authorization surface by default instead of only the upstream web app. The profile-normalization mechanism that upgrades an installation-owned bundle tuple to its current shipped template gains a `web` entry naming the prior two-bundle tuple, so an already-initialized `web` profile whose bundles still match the old upstream pair upgrades to the new three-bundle template on its next load; a profile already customized away from that exact tuple is left untouched. `apps/cli` depends on `@fi/authorization-bundle` directly (workspace protocol) so the bundle resolves from the CLI's own installation anchor, matching how bundle resolution already looks at the installation before the profile directory.

There is no automatic copy or migration of existing `~/.dsh` data into `~/.fi`: a person who wants their prior CLI history available under the new default sets `DSH_HOME=~/.dsh` explicitly.

## Alternatives considered

**Share Desktop's isolated home.** Desktop's home is Electron-userData-relative and has no meaning for a CLI process with no Electron runtime; reusing it would require inventing a CLI-side stand-in path with none of Desktop's actual isolation guarantee, for a home boundary Desktop owns for a different reason (session-lock contention between two long-lived UI processes, not CLI/Web product identity).

**Give Desktop `~/.fi` too, retiring its Electron-userData home.** Desktop's separate home exists to avoid session-lock contention between concurrent Desktop and CLI writers. Pointing Desktop back at the same root the CLI now defaults to would reintroduce exactly that contention, only under a renamed shared directory.

**Keep `~/.dsh` and rename only in user-facing display strings.** Cosmetic renaming without changing `DSH_HOME_DIR_NAME` would leave fi's own CLI and Web sessions, settings, and credentials physically stored under a directory named for the upstream project rather than fi, leaving the product identity fi already committed to for every other user-visible surface incomplete at the filesystem layer.

## Consequences

- A fresh fi CLI or Web install with no `DSH_HOME` set creates and reads `~/.fi`, not `~/.dsh`; every home-relative path (sessions, settings, credentials, profiles, plugins, attachments cache, anonymous telemetry id) moves with it.
- Existing `~/.dsh` installations are untouched and invisible by default; setting `DSH_HOME=~/.dsh` restores full access to that data with no format or migration step.
- fi Desktop's home is unchanged: it never reads the new default because it always supplies its own explicit override.
- A `dsh --profile web` boot now requires `@fi/authorization-bundle` to be resolvable from the CLI's own installation; a `web` profile initialized before this change and never customized away from the upstream two-bundle tuple upgrades to the three-bundle template on its next load.
- Every place that hand-derived the old default outside `@deepseek-ai/dsh-home-paths` was found and now calls the shared resolver, so a future default change has one call site per consumer instead of a re-audit of the whole tree.
