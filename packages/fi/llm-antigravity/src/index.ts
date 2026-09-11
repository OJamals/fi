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
// Type-only: pulls the authorization seam's Context merge (ctx.authorization)
// into this program.
import type {} from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

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
  waitForAntigravityCallback,
} from './auth/oauth.ts'
import type { AntigravityTokenData } from './auth/oauth.ts'

export {
  ANTIGRAVITY_CREDENTIAL_ID,
  ANTIGRAVITY_CREDENTIAL_KEY,
  ANTIGRAVITY_CREDENTIAL_SCOPE,
  ANTIGRAVITY_FLOW_LABEL,
  ANTIGRAVITY_PROVIDER_ID,
}
export type { AntigravityTokenData }

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
    methods: [{ id: 'oauth', label: 'Sign in with Antigravity (Gemini Code Assist)' }],
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
 * The Cordis plugin that mounts the Antigravity adapter.
 *
 * It registers the sign-in flow on the authorization seam. The transport
 * functions are exported separately for callers that already hold a grant.
 */
export class FiAntigravityService extends Service {
  static inject = ['authorization', 'credentials']

  constructor(ctx: Context) {
    super(ctx, 'fi-antigravity')
  }

  protected start(): void {
    registerAntigravityFlow(this.ctx)
  }
}

export default FiAntigravityService
