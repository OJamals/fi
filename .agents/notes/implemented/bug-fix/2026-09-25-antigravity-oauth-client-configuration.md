# Agent Note: Antigravity OAuth client id and secret move to the credentials seam

Status: implemented

English | [中文](2026-09-25-antigravity-oauth-client-configuration.zh.md)

## Problem

`packages/fi/llm-antigravity/src/auth/compat.ts` shipped the Antigravity CLI's Google installed-app OAuth client id and secret as repository string literals, read by `oauth.ts`'s module-level config with an environment-variable override. `packages/fi/provider-compat/src/provider-settings.json` carried the same client id a second time, at `antigravityCli.oauth.clientId`, reproduced every sync by the vendored auth2api updater (`scripts/vendor/auth2api/update-provider-settings.mjs`) — fi's own code never read that copy; it duplicated the literal without using it. GitHub secret scanning flags the Google `\d+-[a-z0-9]+\.apps\.googleusercontent\.com` client id and the `GOCSPX-` secret identically to a leaked credential: this OAuth client authenticates every Antigravity sign-in against Google's account system, so its committed presence in git history is a standing exposure.

## Decision

- The literal client id and secret are removed from `compat.ts`. `oauth.ts` takes an `AntigravityOAuthClient { clientId, clientSecret }` as an explicit parameter on every function that talks to Google (`generateAntigravityAuthURL`, `exchangeAntigravityCode`, `refreshAntigravityTokens`) instead of reading a module-level config.
- `index.ts` resolves both values through the credentials seam per operation: `resolveAntigravityOAuthClient(ctx, refs)` calls `ctx.credentials.resolve(ref)` when the credentials service is mounted, or `launchEnvironmentOf(ctx).get(ref)?.value` otherwise — the same fallback `llm-pi-ai` and `fi-web-search-preferences` already use. Both values are mandatory; a missing one throws before any network call, naming both refs and every place they can be set (an environment variable, a `.env` file in the fi home directory or the launch directory, or a stored credential the web Models page writes).
- The ref *names*, not the values, are `FiAntigravityConfig` fields: `oauthClientIdRef`/`oauthClientSecretRef`, both `Volatile<string>` defaulting to `ANTIGRAVITY_OAUTH_CLIENT_ID`/`ANTIGRAVITY_OAUTH_CLIENT_SECRET`. A live edit reaches the next sign-in attempt or refresh without a restart: `registerAntigravityFlow`'s flow closure reads a refs-returning thunk on every `run()` rather than a snapshot captured at registration time.
- `resolveAntigravityGrant(ctx, signal?, refs?)` keeps `signal` in its established second position — `tool-image-generation` and `web-search-subscription` already called it that way — and resolves the OAuth client before entering the credential store's serialized `modifyRecord`, so the fail-loud path runs once per refresh regardless of which contender wins.
- `scripts/fi-provider-settings-lib.mjs`'s `validateProviderSettings` projects `antigravityCli.oauth.clientId` out of every snapshot it validates, leaving every other provider's `oauth.clientId` (`claudeCode`, `codexCli`) untouched — those are opaque application ids in shapes secret scanning does not flag. The vendored updater script stays byte-identical; the hash manifest is recomputed with the lib's own `providerSettingsHashManifest`, matching the self-consistent hashing the "refresh" update flow already produces (the source-settings hash equals the snapshot hash because both are the same freshly serialized value).
- Packaged Desktop: `apps/desktop/electron-builder.config.mjs` embeds `ANTIGRAVITY_OAUTH_CLIENT_ID`/`ANTIGRAVITY_OAUTH_CLIENT_SECRET` into the packaged manifest's `extraMetadata` only when the packaging environment sets them; `apps/desktop/src/main.ts` reads them back and seeds the Host process environment with them only where the user's own environment does not already define the variable. An unsigned/dev build, or a release built without those two environment variables, packages neither value and behaves exactly like the source CLI.

## Alternatives considered

**Keep the literal but rotate it.** A rotated client id is still a repository literal GitHub would flag again on its next commit; rotation buys nothing structural.

**Ship the client id but not the secret.** Google's installed-app OAuth token exchange for this client requires the secret; splitting them would still leave the id — matched by the same secret-scanning pattern — committed.

**Resolve only from `process.env`, skipping the credentials seam.** Every other fi provider credential (`llm-pi-ai`, `fi-web-search-preferences`) resolves through `ctx.credentials` first, falling back to the launch environment only when no credentials service is mounted; resolving Antigravity's OAuth client differently would leave it unable to use the stored-credential UI the web Models page already writes to for every other provider.

**Refuse `clientId` for every provider in `fi-provider-settings-lib.mjs`.** `claudeCode` and `codexCli` also carry an `oauth.clientId` that secret scanning does not flag and that this snapshot legitimately captures; a blanket refusal would break those providers' metadata capture for no security benefit.

## Testing

| Evidence | Behaviour |
|---|---|
| [flow.host.spec.ts](../../../../packages/fi/llm-antigravity/tests/flow.host.spec.ts) | The sign-in flow fails loud, naming both OAuth client refs, before any network call, when neither is configured. |
| [plugin.host.spec.ts](../../../../packages/fi/llm-antigravity/tests/plugin.host.spec.ts) | Token refresh resolves the OAuth client through a seeded fake credential and, when neither ref is configured, fails loud naming both refs before any `fetch` call. |
| [fi-provider-settings.spec.ts](../../../../scripts/fi-provider-settings.spec.ts) | `validateProviderSettings` strips `antigravityCli.oauth.clientId` while keeping `codexCli.oauth.clientId`, and the stripped snapshot round-trips unchanged. |

## Consequences

- The Google OAuth client id and secret no longer exist anywhere in the repository or its history going forward; a deployment supplies them once, through whichever of the three channels its operator already uses for other credentials.
- A source checkout or an unconfigured packaged Desktop build serves the static Antigravity model catalog but cannot sign in or refresh until the two values are set; this is the intended fail-loud behavior, not a regression.
- Packaged Desktop releases built without the two packaging-time environment variables ship with Antigravity sign-in unconfigured, same as the CLI; a maintainer who wants it preconfigured in a specific release sets both variables for that packaging run.
- `resolveAntigravityGrant`'s two other callers (`tool-image-generation`, `web-search-subscription`) always resolve the default ref names; a deployment that renames either ref through `FiAntigravityConfig` must keep the default names resolvable too if it also uses those two features' Antigravity grant reuse.
