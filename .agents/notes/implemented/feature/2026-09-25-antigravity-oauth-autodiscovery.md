# Agent Note: Antigravity OAuth client local-install auto-discovery

Status: implemented

English | [中文](2026-09-25-antigravity-oauth-autodiscovery.zh.md)

## Problem

[The prior Agent Note](../bug-fix/2026-09-25-antigravity-oauth-client-configuration.md) moved the Antigravity Google OAuth client id and secret off a repository literal and onto `ANTIGRAVITY_OAUTH_CLIENT_ID`/`ANTIGRAVITY_OAUTH_CLIENT_SECRET`, resolved through `ctx.credentials` or the launch environment. That closed the secret-scanning exposure, but left every user needing to set two values by hand before Antigravity sign-in would work at all — a step with no equivalent in the source Antigravity CLI, which carries its own installed-app client. A user who already has the Antigravity CLI or app installed locally has that same client sitting on disk; fi had no way to find and reuse it.

## Decision

`packages/fi/llm-antigravity/src/auth/discovery.ts` adds local-install auto-discovery, invoked only when `resolveAntigravityOAuthClient` (`index.ts`) resolves neither ref: a bounded scan of known Antigravity CLI/app install locations for the same installed-app OAuth client the CLI itself carries, verified by SHA-256 fingerprint before it is ever trusted.

- **Locations** are a `FiAntigravityConfig.oauthClientDiscoveryLocations` (`Volatile<string[]>`) list, defaulting per platform (`defaultAntigravityDiscoveryLocations`): `which:agy` (a `PATH` lookup) and `~/.local/bin/agy` on every platform, plus the macOS `.app` bundle, Linux share/opt/flatpak/snap paths, or the Windows `Programs`/`Program Files` install directories. A directory root is walked recursively under a fixed depth and total-file budget (a scan robustness bound, not a deployment choice, so it stays a module constant rather than a Config field) rather than by special-casing `app.asar`, `app.asar.unpacked`, or `Contents/Resources/bin/*` — the generic walk finds all of them inside a configured root.
- **Extraction** streams each candidate file in chunks (a matched binary can be roughly 180 MB), decoding `latin1` so every byte maps to one code point — the correct decoding for scanning a binary blob for an ASCII-only pattern — with a carry window bridging chunk boundaries. Files over `oauthClientDiscoveryMaxFileBytes` are skipped unread.
- **Verification** hashes every extracted candidate id and secret with SHA-256 and checks the accumulated hashes against `oauthClientDiscoveryFingerprints` (`Volatile<AntigravityOAuthFingerprintPair[]>`), defaulting to one pair for the Antigravity CLI's known client. A binary carries more than one id/secret, so candidates accumulate across every scanned file before a pair is judged complete; scanning stops as soon as one configured pair is. A rotated client is accepted by adding its fingerprint pair to this Config field, never by changing the default.
- **Persistence**: `discoverAndPersistAntigravityOAuthClient` only runs discovery when `ctx.credentials` is mounted (there is nowhere durable to write without it) and, on a match, calls `ctx.credentials.set` for both refs before returning the pair — so later resolutions skip the scan. Discovery only triggers when *both* refs are unconfigured; a partially configured client (one ref set, the other not) is left to its existing fail-loud path rather than silently overwritten.
- **Single-flight and negative cache**: `runAntigravityDiscovery` holds one module-level in-flight promise so concurrent resolutions share one scan, and caches a failed scan for `oauthClientDiscoveryNegativeCacheMs` so a burst of failed resolutions does not re-walk the filesystem on every call.
- **Logging**: every log call carries a path or an outcome, never a matched value; `discoverAntigravityOAuthClient`'s logger parameter is a two-method interface structurally satisfied by `ctx.logger`, keeping this module free of a `cordis` dependency.
- Never spawns or executes a scanned file; only reads its bytes.
- The existing "not configured" error (`resolveAntigravityOAuthClient`) is extended with one sentence pointing at this fallback, rather than replaced.
- Desktop already runs the same Host plugin, so this covers Desktop without separate wiring; the existing optional build-time embedding (`apps/desktop/electron-builder.config.mjs`) is unchanged and still takes precedence whenever it packages both values.

## Alternatives considered

- **Ship the fingerprint values as the client id/secret themselves, gated by an opt-in flag** — rejected: that reintroduces the exact repository literal the prior note removed; a SHA-256 fingerprint is the only form of "the known client" safe to commit.
- **Match by filename or install-manifest metadata instead of by content fingerprint** — rejected: a binary's embedded strings are the only value observed to be stable across an install; filenames and manifest layouts are not part of any compatibility contract this package owns.
- **Walk every configured broad root (`/usr/share`, `/opt`) unfiltered** — rejected: an unrelated root's ordinary contents would burn most of the file budget before reaching an actual Antigravity install, if one is even under that root; the defaults instead name plausible Antigravity-specific subpaths directly.
- **Persist a discovered pair into a `.env` file instead of through `ctx.credentials`** — rejected: every other fi-managed credential already goes through the credentials seam's writable local provider, which lives in the fi home directory outside any repository by construction; a second persistence path would duplicate that guarantee for no benefit.
- **Retry discovery on every failed resolution with no cache** — rejected: a deployment with no local Antigravity install and no configured client would re-walk the filesystem on every sign-in attempt and every near-expiry refresh check; the negative cache bounds that cost.

## Testing

| Evidence | Behaviour |
|---|---|
| [discovery.host.spec.ts](../../../../packages/fi/llm-antigravity/tests/discovery.host.spec.ts) | Scans synthetic fixture files built from runtime-concatenated fake id/secret pieces (never a literal matching a secret-scanning pattern in this repository); verifies fingerprint matching, the maxFileBytes ceiling, symlink-cycle safety, single-flight de-duplication, and the negative cache. |
| [plugin.host.spec.ts](../../../../packages/fi/llm-antigravity/tests/plugin.host.spec.ts) | `harness()` disables discovery (`oauthClientDiscoveryLocations: []`) so the existing fail-loud and grant-resolution tests stay hermetic regardless of what the test host has installed locally. |
| [flow.host.spec.ts](../../../../packages/fi/llm-antigravity/tests/flow.host.spec.ts) | The "fails loud" sign-in test passes `DISABLED_ANTIGRAVITY_DISCOVERY` for the same reason. |
| [verify-no-secrets.spec.ts](../../../../scripts/verify-no-secrets.spec.ts) | The repository secret guard (added alongside this feature; see its own section below) rejects the same fake, runtime-built fixture shapes this package's tests use, proving neither this package's tests nor its source ever commit a matching literal. |

## Repository secret guard

Alongside auto-discovery, `scripts/verify-no-secrets.ts` scans staged content (`--staged`, wired into the `lefthook.yml` pre-commit job) and an outgoing push's diff (`--push`, wired into pre-push) for a Google OAuth client secret, a Google OAuth client id, a Google API key, or a private key header, plus a `--tree` mode (`pnpm run verify-no-secrets`, wired into `ciSharedStaticGates` in `scripts/run-gates.ts`) that audits every tracked file's full content. The two hook modes scan only added diff lines — content already committed is not re-flagged on every later commit — parsed from `git diff -U0` output; `--tree` has no such history to lean on. An explicit, reviewed allowlist (keyed by exact repository-relative path and pattern name, never a directory prefix) exempts a fixture a reviewer has confirmed is fake; a fixture built from runtime-concatenated pieces, as this feature's own tests are, needs no such entry because its source text never spells the matched pattern at all.

## Consequences

A user with the Antigravity CLI or app installed locally can sign in with no manual configuration; installing or launching either is enough. A deployment with neither ref configured nor Antigravity installed still gets the same fail-loud error as before, now naming the auto-discovery fallback. Discovery cost is bounded per scan (depth, total files, per-file size) and amortized to at most one scan per negative-cache interval per process; a rotated Antigravity client is accepted by adding its fingerprint pair to `FiAntigravityConfig.oauthClientDiscoveryFingerprints`, not by a code change. The repository secret guard is a second, independent layer against a future literal credential reaching git history, alongside GitHub's own secret scanning.
