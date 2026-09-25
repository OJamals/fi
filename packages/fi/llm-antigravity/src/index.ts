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
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

import {
  ANTIGRAVITY_CREDENTIAL_ID,
  ANTIGRAVITY_CREDENTIAL_KEY,
  ANTIGRAVITY_CREDENTIAL_SCOPE,
  ANTIGRAVITY_FLOW_LABEL,
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
import type { AntigravityTokenData } from './auth/oauth.ts'
import { AntigravityAdapter } from './adapter.ts'
import type { AntigravityGrant } from './adapter.ts'

export {
  ANTIGRAVITY_CREDENTIAL_ID,
  ANTIGRAVITY_CREDENTIAL_KEY,
  ANTIGRAVITY_CREDENTIAL_SCOPE,
  ANTIGRAVITY_FLOW_LABEL,
  ANTIGRAVITY_PROVIDER_ID,
}
export type { AntigravityTokenData }
export { AntigravityAdapter } from './adapter.ts'
export type { AntigravityGrant, AntigravityGrantResolver } from './adapter.ts'
export { ANTIGRAVITY_STATIC_CATALOG, antigravityModelName } from './catalog.ts'
export type { AntigravityCatalogEntry } from './catalog.ts'

/**
 * Register the Antigravity sign-in flow on the authorization seam.
 *
 * The flow runs the browser-based Google PKCE dance: it notifies the user
 * of the authorization URL, waits for the loopback callback, exchanges the
 * code, discovers the Cloud Code project, and commits the grant to the
 * credential store under `fi-antigravity/antigravity`.
 *
 * @param ctx - the plugin context carrying `ctx.authorization` and `ctx.credentials`.
 */
export function registerAntigravityFlow(ctx: Context): void {
  ctx.authorization.registerFlow({
    key: credentialKey(ANTIGRAVITY_CREDENTIAL_SCOPE, ANTIGRAVITY_CREDENTIAL_ID),
    label: ANTIGRAVITY_FLOW_LABEL,
    methods: [{ id: 'oauth', label: 'Sign in with Antigravity' }],
    async run(session) {
      const pkce = generateAntigravityPKCE()
      const state = randomUUID()
      const authUrl = generateAntigravityAuthURL(state, pkce)

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

      const token = await exchangeAntigravityCode(result.code, result.state, state, pkce, session.signal)

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
}

const Profile = z.object({
  displayName: z.string(),
})
const Config = z.object({
  providers: z.dict(Profile).default({}).volatile(),
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
 * @returns the current usable grant, or `undefined` when Antigravity is signed out.
 */
export async function resolveAntigravityGrant(
  ctx: Context,
  signal?: AbortSignal,
): Promise<AntigravityGrant | undefined> {
  const key = credentialKey(ANTIGRAVITY_CREDENTIAL_SCOPE, ANTIGRAVITY_CREDENTIAL_ID)
  let record = await ctx.credentials.readRecord(key)
  let payload = grantPayload(record)
  if (payload === undefined) return undefined
  if (payload.expires !== undefined && payload.expires - Date.now() < REFRESH_MARGIN_MS
    && payload.refresh !== undefined) {
    record = await ctx.credentials.modifyRecord(key, async (current) => {
      const currentPayload = grantPayload(current)
      const rawPayload = rawGrantPayload(current)
      // Another caller may have rotated while this read was in flight.
      if (currentPayload === undefined || rawPayload === undefined || currentPayload.refresh === undefined) return current
      if (currentPayload.expires !== undefined
        && currentPayload.expires - Date.now() >= REFRESH_MARGIN_MS) return current
      const token = await refreshAntigravityTokens(currentPayload.refresh, signal)
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
    registerAntigravityFlow(this.ctx)
    // The Models page renders this section through the provider directory, not an automatic form.
    this.ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, this.ctx.fiber)) })
    const settingsNs = this.ctx.fiber.entry?.options.id ?? ANTIGRAVITY_CREDENTIAL_SCOPE

    const adapter = new AntigravityAdapter(
      signal => resolveAntigravityGrant(this.ctx, signal),
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
