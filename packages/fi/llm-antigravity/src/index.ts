/**
 * Antigravity OAuth adapter and Cloud Code transport.
 *
 * This package registers the Antigravity sign-in flow on fi's authorization
 * seam (`ctx.authorization`) and provides the transport that serves Gemini
 * and Claude models through Google's paid Cloud Code endpoint.
 *
 * The OAuth flow is Google PKCE with the Antigravity desktop app's public
 * client id, a loopback redirect on `127.0.0.1:54545`, and five scopes
 * including `cloud-platform` and `cclog`. After exchange it discovers the
 * `cloudaicompanionProject` via `loadCodeAssist`, which becomes the billing
 * project every inference request names.
 *
 * The transport wraps Gemini `contents`/`generationConfig` in the Cloud Code
 * envelope and POSTs to `v1internal:streamGenerateContent?alt=sse`.
 *
 * @module @fi/llm-antigravity
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

import { Context, Service } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cordis'
// Type-only: pulls the seams' Context merges into this program
// (ctx.authorization, ctx.credentials, ctx.llm, ctx.settings).
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord, CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

import {
  ANTIGRAVITY_CREDENTIAL_ID,
  ANTIGRAVITY_CREDENTIAL_KEY,
  ANTIGRAVITY_CREDENTIAL_SCOPE,
  ANTIGRAVITY_FLOW_LABEL,
  ANTIGRAVITY_OAUTH_CLIENT_ID_REF,
  ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF,
  ANTIGRAVITY_PROVIDER_ID,
} from './auth/compat.ts'
import {
  exchangeAntigravityCode,
  generateAntigravityAuthURL,
  generateAntigravityPKCE,
  getAntigravityOAuthCallback,
  refreshAntigravityTokens,
  waitForAntigravityCallback,
} from './auth/oauth.ts'
import type { AntigravityOAuthClient, AntigravityTokenData } from './auth/oauth.ts'
import {
  DEFAULT_ANTIGRAVITY_DISCOVERY_OPTIONS,
  DEFAULT_ANTIGRAVITY_OAUTH_FINGERPRINTS,
  DISABLED_ANTIGRAVITY_DISCOVERY,
  defaultAntigravityDiscoveryLocations,
  runAntigravityDiscovery,
} from './auth/discovery.ts'
import type { AntigravityDiscoveryOptions, AntigravityOAuthFingerprintPair } from './auth/discovery.ts'
import { AntigravityAdapter } from './adapter.ts'
import type { AntigravityGrant } from './adapter.ts'

export {
  ANTIGRAVITY_CREDENTIAL_ID,
  ANTIGRAVITY_CREDENTIAL_KEY,
  ANTIGRAVITY_CREDENTIAL_SCOPE,
  ANTIGRAVITY_FLOW_LABEL,
  ANTIGRAVITY_OAUTH_CLIENT_ID_REF,
  ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF,
  ANTIGRAVITY_PROVIDER_ID,
}
export type { AntigravityOAuthClient, AntigravityTokenData }
export { AntigravityAdapter } from './adapter.ts'
export type { AntigravityGrant, AntigravityGrantResolver } from './adapter.ts'
export { ANTIGRAVITY_STATIC_CATALOG, antigravityModelName } from './catalog.ts'
export type { AntigravityCatalogEntry } from './catalog.ts'
export {
  DEFAULT_ANTIGRAVITY_DISCOVERY_OPTIONS,
  DEFAULT_ANTIGRAVITY_OAUTH_FINGERPRINTS,
  DISABLED_ANTIGRAVITY_DISCOVERY,
  defaultAntigravityDiscoveryLocations,
}
export type { AntigravityDiscoveryOptions, AntigravityOAuthFingerprintPair }

/** The two credential refs jointly configuring the Google OAuth client used by every route. */
export interface AntigravityOAuthClientRefs {
  readonly clientIdRef: CredentialRef
  readonly clientSecretRef: CredentialRef
}

/** The refs {@link FiAntigravityConfig}'s schema defaults to, used by every standalone caller below. */
const DEFAULT_OAUTH_CLIENT_REFS: AntigravityOAuthClientRefs = {
  clientIdRef: credentialRef(ANTIGRAVITY_OAUTH_CLIENT_ID_REF),
  clientSecretRef: credentialRef(ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF),
}

/**
 * Resolve one credential reference through the credentials seam, or the
 * launch environment when no credentials service is mounted — the same
 * fallback `llm-pi-ai` and `fi-web-search-preferences` use.
 * @param ctx - context supplying the optional credentials service and the launch environment.
 * @param ref - the reference to resolve.
 * @returns the non-empty value, or `undefined` while unconfigured.
 */
async function resolveOAuthClientValue(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  const value = credentials === undefined
    ? launchEnvironmentOf(ctx).get(ref)?.value
    : (await credentials.resolve(ref))?.value
  return value !== undefined && value.length > 0 ? value : undefined
}

/**
 * Attempt local-install discovery and, on success, persist both values under
 * `refs` before returning them. Discovery only runs when the credentials
 * seam is mounted — persistence is the point, and there is nowhere durable
 * to write without it. `credentials.set` is safe to call here: it would only
 * reject a ref the inherited environment shadows, and a shadowed ref would
 * already have resolved a non-empty value, which is exactly the case this
 * function's caller has already ruled out.
 * @param ctx - context supplying the optional credentials service.
 * @param refs - the refs a discovered client is persisted under.
 * @param discovery - locations, accepted fingerprints, and cache behavior for the scan.
 * @returns the discovered and persisted client, or `undefined` when discovery is unavailable or found nothing.
 */
async function discoverAndPersistAntigravityOAuthClient(
  ctx: Context,
  refs: AntigravityOAuthClientRefs,
  discovery: AntigravityDiscoveryOptions,
): Promise<AntigravityOAuthClient | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) return undefined
  const found = await runAntigravityDiscovery(discovery, ctx.logger)
  if (found === undefined) return undefined
  await credentials.set(refs.clientIdRef, found.clientId)
  await credentials.set(refs.clientSecretRef, found.clientSecret)
  return found
}

/**
 * Resolve the Google OAuth client id and secret used for every Antigravity
 * sign-in and token refresh. Both values are mandatory: a Google installed-app
 * OAuth client authenticates the whole account, so a missing half must fail
 * loud rather than default to a guessed or absent secret. When neither value
 * is configured, this scans the user's local Antigravity install
 * ({@link discoverAntigravityOAuthClient}) before failing; a value found
 * there is persisted under `refs` so later resolutions skip the scan.
 * @param ctx - context supplying the optional credentials service and the launch environment.
 * @param refs - the two refs to resolve, from {@link FiAntigravityConfig} or {@link DEFAULT_OAUTH_CLIENT_REFS}.
 * @param discovery - locations, accepted fingerprints, and cache behavior for the local-install scan; defaults to
 *   {@link DEFAULT_ANTIGRAVITY_DISCOVERY_OPTIONS}.
 * @returns the resolved client id and secret.
 * @throws when either ref resolves to nothing and discovery also finds nothing, naming both refs and every place
 *   they can be set.
 */
export async function resolveAntigravityOAuthClient(
  ctx: Context,
  refs: AntigravityOAuthClientRefs = DEFAULT_OAUTH_CLIENT_REFS,
  discovery: AntigravityDiscoveryOptions = DEFAULT_ANTIGRAVITY_DISCOVERY_OPTIONS,
): Promise<AntigravityOAuthClient> {
  const [clientId, clientSecret] = await Promise.all([
    resolveOAuthClientValue(ctx, refs.clientIdRef),
    resolveOAuthClientValue(ctx, refs.clientSecretRef),
  ])
  if (clientId !== undefined && clientSecret !== undefined) {
    return { clientId, clientSecret }
  }
  // Discovery only makes sense when NEITHER half is configured: a partially
  // configured client (one ref set, the other not) is a deliberate,
  // ambiguous state a discovered pair must never silently overwrite.
  if (clientId === undefined && clientSecret === undefined) {
    const discovered = await discoverAndPersistAntigravityOAuthClient(ctx, refs, discovery)
    if (discovered !== undefined) return discovered
  }
  const missing = [
    clientId === undefined ? refs.clientIdRef : undefined,
    clientSecret === undefined ? refs.clientSecretRef : undefined,
  ].filter((ref): ref is CredentialRef => ref !== undefined)
  throw new Error(
    `Antigravity sign-in and token refresh need ${missing.join(' and ')} to authenticate the Google OAuth `
    + `client; set ${missing.length > 1 ? 'them' : 'it'} as an environment variable, in a .env file in the `
    + 'fi home directory or your launch directory, or as a stored credential (the web Models page writes it). '
    + 'Installing or launching the Antigravity CLI or app also lets fi pick up the client automatically on the '
    + 'next sign-in attempt.',
  )
}

/**
 * Register the Antigravity sign-in flow on the authorization seam.
 *
 * The flow runs the browser-based Google PKCE dance: it notifies the user
 * of the authorization URL, waits for the loopback callback, exchanges the
 * code, discovers the Cloud Code project, and commits the grant to the
 * credential store under `fi-antigravity/antigravity`.
 *
 * @param ctx - the plugin context carrying `ctx.authorization` and `ctx.credentials`.
 * @param refs - reads the OAuth client refs to resolve for one attempt, fresh on every call so a live
 *   {@link FiAntigravityConfig} edit reaches the next sign-in without a restart; defaults to
 *   {@link ANTIGRAVITY_OAUTH_CLIENT_ID_REF} and {@link ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF}.
 * @param discovery - reads the local-install discovery options for one attempt, fresh on every call on the same
 *   terms as `refs`; defaults to {@link DEFAULT_ANTIGRAVITY_DISCOVERY_OPTIONS}.
 */
export function registerAntigravityFlow(
  ctx: Context,
  refs: () => AntigravityOAuthClientRefs = () => DEFAULT_OAUTH_CLIENT_REFS,
  discovery: () => AntigravityDiscoveryOptions = () => DEFAULT_ANTIGRAVITY_DISCOVERY_OPTIONS,
): void {
  ctx.authorization.registerFlow({
    key: credentialKey(ANTIGRAVITY_CREDENTIAL_SCOPE, ANTIGRAVITY_CREDENTIAL_ID),
    label: ANTIGRAVITY_FLOW_LABEL,
    methods: [{ id: 'oauth', label: 'Sign in with Antigravity' }],
    async run(session) {
      const client = await resolveAntigravityOAuthClient(ctx, refs(), discovery())
      const pkce = generateAntigravityPKCE()
      const state = randomUUID()
      const authUrl = generateAntigravityAuthURL(state, pkce, client)

      session.notify({
        message: 'Open this page to sign in with your Google account.',
        url: authUrl,
      })

      const callback = getAntigravityOAuthCallback()
      const result = await waitForAntigravityCallback({
        port: callback.callbackPort,
        callbackPath: callback.callbackPath,
        signal: session.signal,
      })

      if (result.state !== state) {
        throw new Error('OAuth state mismatch — possible CSRF attack')
      }

      const token = await exchangeAntigravityCode(result.code, result.state, state, pkce, client, session.signal)

      await ctx.credentials.modifyRecord(
        credentialKey(ANTIGRAVITY_CREDENTIAL_SCOPE, ANTIGRAVITY_CREDENTIAL_ID),
        () => Promise.resolve({
          kind: 'grant',
          payload: {
            type: 'oauth',
            access: token.accessToken,
            refresh: token.refreshToken,
            expires: new Date(token.expiresAt).getTime(),
            email: token.email,
            accountUuid: token.accountUuid,
            antigravityProjectId: token.antigravityProjectId,
            idToken: token.idToken,
          },
        }),
      )
    },
  })
}

/**
 * The settings section this plugin owns: one profile per Antigravity route.
 * The profile is deliberately thin — the grant, not the profile, picks the
 * account — so the schema carries presentation fields only and the Models
 * page's editor shows nothing to mistype.
 */
interface FiAntigravityProfile {
  /** Name the Models page shows for this route. */
  displayName?: string
}

/** The plugin Config: profiles keyed by route id, edited live through the profile-backed settings form. */
export interface FiAntigravityConfig {
  /** Antigravity routes keyed by route id; each route serves through the signed-in Google grant. */
  providers: Volatile<Record<string, FiAntigravityProfile>>
  /** Credential reference resolved per sign-in/refresh for the Google OAuth client id. */
  oauthClientIdRef: Volatile<string>
  /** Credential reference resolved per sign-in/refresh for the Google OAuth client secret. */
  oauthClientSecretRef: Volatile<string>
  /**
   * Bounded local install locations scanned for the OAuth client when
   * neither `oauthClientIdRef` nor `oauthClientSecretRef` resolves to a
   * value; each entry is `which:<name>` (a `PATH` lookup) or a filesystem
   * path (`~` and `%VAR%` expand). Defaults to the running platform's known
   * Antigravity CLI/app install locations.
   */
  oauthClientDiscoveryLocations: Volatile<string[]>
  /**
   * Accepted (client id, client secret) SHA-256 fingerprint pairs a
   * discovered candidate must match before it is trusted; a rotated
   * Antigravity OAuth client is accepted by adding its pair here.
   */
  oauthClientDiscoveryFingerprints: Volatile<AntigravityOAuthFingerprintPair[]>
  /** Files larger than this are skipped unread during discovery, in bytes. */
  oauthClientDiscoveryMaxFileBytes: Volatile<number>
  /** How long a failed discovery scan is cached before the next resolution attempt retries it, in milliseconds. */
  oauthClientDiscoveryNegativeCacheMs: Volatile<number>
}

const Profile = z.object({
  displayName: z.string(),
})
const FingerprintPair = z.object({
  clientIdSha256: z.string(),
  clientSecretSha256: z.string(),
})
const Config = z.object({
  providers: z.dict(Profile).default({}).volatile(),
  oauthClientIdRef: z.string().role('credential-ref').default(ANTIGRAVITY_OAUTH_CLIENT_ID_REF).volatile(),
  oauthClientSecretRef: z.string().role('credential-ref').default(ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF).volatile(),
  oauthClientDiscoveryLocations: z.array(z.string())
    .default([...defaultAntigravityDiscoveryLocations()])
    .volatile(),
  oauthClientDiscoveryFingerprints: z.array(FingerprintPair)
    .default([...DEFAULT_ANTIGRAVITY_OAUTH_FINGERPRINTS])
    .volatile(),
  oauthClientDiscoveryMaxFileBytes: z.number().step(1).min(1)
    .default(DEFAULT_ANTIGRAVITY_DISCOVERY_OPTIONS.maxFileBytes).volatile(),
  oauthClientDiscoveryNegativeCacheMs: z.number().step(1).min(0)
    .default(DEFAULT_ANTIGRAVITY_DISCOVERY_OPTIONS.negativeCacheMs).volatile(),
}) as unknown as z<FiAntigravityConfig>

/** The grant payload as the sign-in flow commits it. */
interface StoredGrantPayload {
  access: string
  refresh?: string
  expires?: number
  projectId?: string
}

/**
 * Narrow one credential record to this adapter's grant payload. The record
 * key is already scoped to this plugin's own flow, so the check is
 * structural only: an access token string is the grant, and the project id
 * rides whichever of the three historical keys carried it
 * (`antigravityProjectId` from the flow, `accountUuid` from auth2api's
 * shape, or `projectId` from a record written before the flow carried the
 * profile fields through). Anything without an access token answers
 * `undefined`, which reads downstream as signed out rather than mis-shapen.
 */
function rawGrantPayload(record: CredentialRecord | undefined): Record<string, unknown> | undefined {
  if (record?.kind !== 'grant' || record.payload === null || typeof record.payload !== 'object') {
    return undefined
  }
  return record.payload as Record<string, unknown>
}

function grantPayload(record: CredentialRecord | undefined): StoredGrantPayload | undefined {
  const payload = rawGrantPayload(record)
  if (payload === undefined) return undefined
  if (typeof payload.access !== 'string' || payload.access.length === 0) return undefined
  const project = payload.antigravityProjectId ?? payload.accountUuid ?? payload.projectId
  return {
    access: payload.access,
    ...typeof payload.refresh === 'string' ? { refresh: payload.refresh } : {},
    ...typeof payload.expires === 'number' ? { expires: payload.expires } : {},
    ...typeof project === 'string' ? { projectId: project } : {},
  }
}

/** Refresh margin: near-expiry tokens rotate before a call strands mid-stream. */
const REFRESH_MARGIN_MS = 120_000

/**
 * Resolve the current Antigravity grant for one provider call. A near-expiry
 * token with a refresh token rotates inside the seam's serialized
 * `modifyRecord`, so concurrent calls and processes cannot lose each other's
 * rotation; the refresh response omits the profile fields, so the stored
 * payload's email/account/project ride through untouched.
 * @param ctx - context carrying the canonical credential store.
 * @param signal - optional cancellation for an in-flight token refresh.
 * @param refs - the OAuth client refs to resolve before a refresh; defaults to
 *   {@link ANTIGRAVITY_OAUTH_CLIENT_ID_REF} and {@link ANTIGRAVITY_OAUTH_CLIENT_SECRET_REF} — every caller
 *   outside `FiAntigravityService` (image generation, subscription search) reuses the same stored grant
 *   through these defaults, so a deployment that renames either ref must keep the default names resolvable too.
 * @param discovery - local-install discovery options resolved before a refresh, on the same terms as `refs`;
 *   defaults to {@link DEFAULT_ANTIGRAVITY_DISCOVERY_OPTIONS}.
 * @returns the current usable grant, or `undefined` when Antigravity is signed out.
 */
export async function resolveAntigravityGrant(
  ctx: Context,
  signal?: AbortSignal,
  refs: AntigravityOAuthClientRefs = DEFAULT_OAUTH_CLIENT_REFS,
  discovery: AntigravityDiscoveryOptions = DEFAULT_ANTIGRAVITY_DISCOVERY_OPTIONS,
): Promise<AntigravityGrant | undefined> {
  const key = credentialKey(ANTIGRAVITY_CREDENTIAL_SCOPE, ANTIGRAVITY_CREDENTIAL_ID)
  let record = await ctx.credentials.readRecord(key)
  let payload = grantPayload(record)
  if (payload === undefined) return undefined
  if (payload.expires !== undefined && payload.expires - Date.now() < REFRESH_MARGIN_MS
    && payload.refresh !== undefined) {
    const client = await resolveAntigravityOAuthClient(ctx, refs, discovery)
    record = await ctx.credentials.modifyRecord(key, async (current) => {
      const currentPayload = grantPayload(current)
      const rawPayload = rawGrantPayload(current)
      // Another caller may have rotated while this read was in flight.
      if (currentPayload === undefined || rawPayload === undefined || currentPayload.refresh === undefined) return current
      if (currentPayload.expires !== undefined
        && currentPayload.expires - Date.now() >= REFRESH_MARGIN_MS) return current
      const token = await refreshAntigravityTokens(currentPayload.refresh, client, signal)
      return {
        kind: 'grant',
        payload: {
          ...rawPayload,
          access: token.accessToken,
          refresh: token.refreshToken,
          expires: new Date(token.expiresAt).getTime(),
        },
      }
    })
    payload = grantPayload(record) ?? payload
  }
  return { accessToken: payload.access, projectId: payload.projectId }
}

/**
 * The Cordis plugin that mounts the Antigravity adapter family.
 *
 * Beyond the sign-in flow it wires the serving half: a `fi-antigravity`
 * settings section whose profiles name routes, one `LlmAdapter` instance
 * serving those routes through the Cloud Code transport, a directory entry
 * so the Models page offers Antigravity natively, and model discovery so
 * adoption can enumerate what the route serves. A bare mount is dormant —
 * no routes register until the section declares a profile, matching the
 * pi-ai plugin's posture.
 */
export class FiAntigravityService extends Service {
  static inject = ['authorization', 'credentials', 'llm']
  static Config = Config

  constructor(ctx: Context, config: FiAntigravityConfig) {
    super(ctx, 'fi-antigravity')
    // Read fresh on every call: a live edit to either ref (both `.volatile()`)
    // reaches the next sign-in attempt or token refresh without a restart.
    const oauthClientRefs = (): AntigravityOAuthClientRefs => ({
      clientIdRef: credentialRef(config.oauthClientIdRef.get()),
      clientSecretRef: credentialRef(config.oauthClientSecretRef.get()),
    })
    // Read fresh on every call on the same terms as `oauthClientRefs`, so a
    // live edit to any discovery field reaches the next scan without a restart.
    const oauthClientDiscoveryOptions = (): AntigravityDiscoveryOptions => ({
      locations: config.oauthClientDiscoveryLocations.get(),
      fingerprints: config.oauthClientDiscoveryFingerprints.get(),
      maxFileBytes: config.oauthClientDiscoveryMaxFileBytes.get(),
      negativeCacheMs: config.oauthClientDiscoveryNegativeCacheMs.get(),
    })
    registerAntigravityFlow(this.ctx, oauthClientRefs, oauthClientDiscoveryOptions)
    // The Models page renders this section through the provider directory, not an automatic form.
    this.ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, this.ctx.fiber)) })
    const settingsNs = this.ctx.fiber.entry?.options.id ?? ANTIGRAVITY_CREDENTIAL_SCOPE

    const adapter = new AntigravityAdapter(
      signal => resolveAntigravityGrant(this.ctx, signal, oauthClientRefs(), oauthClientDiscoveryOptions()),
      () => this.ctx.get('attachments'),
    )
    let registration: AdapterRegistrationHandle | undefined
    const sync = (): void => {
      const routes = Object.keys(config.providers.get())
      if (registration === undefined) {
        // Dormant bare mount: nothing registers until the Config declares a
        // profile, and an emptied Config drops every route.
        if (routes.length === 0) return
        registration = this.ctx.llm.registerAdapter(routes, adapter)
      } else {
        registration.replace(routes)
      }
    }
    sync()
    this.ctx.on('loader/volatile-update', () => { sync() })
    // The Models page's add-provider catalog draws from these entries, so
    // Antigravity appears there before any route exists — the same way the
    // pi-ai plugin surfaces its whole installed catalog.
    this.ctx.llm.registerConfigurableProviders([{
      provider: ANTIGRAVITY_PROVIDER_ID,
      displayName: ANTIGRAVITY_FLOW_LABEL,
      settingsNs,
      settingsPath: ['providers', ANTIGRAVITY_PROVIDER_ID],
    }])
    // Discovery serves the adopt flow's model enumeration: the live
    // projected catalog when a grant is stored, the static list otherwise.
    this.ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
      const models = await adapter.listModels(request.provider ?? ANTIGRAVITY_PROVIDER_ID)
      return models.map(model => ({ id: model.id, name: model.name }))
    })
  }
}

export default FiAntigravityService
