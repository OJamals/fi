/** Device authorization and serialized grant rotation for OpenCode Console. */
import { setTimeout as delay } from 'node:timers/promises'
import { addAbortListener } from 'node:events'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import { consoleJson, consoleUrl, exchangeToken, grantSchema, tokenSchema } from './protocol.ts'
import type { ConsoleGrant, ConsoleOptions } from './protocol.ts'

/** Canonical grant key shared by the login, discovery, and inference paths. */
export const OPENCODE_KEY = credentialKey('fi-opencode', 'opencode-console')

const deviceSchema = z.object({
  device_code: z.string().min(1), user_code: z.string().min(1),
  verification_uri_complete: z.string().min(1),
  expires_in: z.number().positive().max(3600),
  interval: z.number().positive(),
})
const userSchema = z.object({ id: z.string().min(1), email: z.string() })
const orgSchema = z.array(z.object({ id: z.string().min(1), name: z.string() }))

/** Validate durable data; malformed owned grants fail rather than masquerade as a sign-out. */
function storedGrant(record: CredentialRecord | undefined): ConsoleGrant | undefined {
  if (record === undefined) return undefined
  if (record.kind !== 'grant') throw new Error('OpenCode credential record must be an OAuth grant')
  return grantSchema.parse(record.payload)
}

/**
 * Register OpenCode Console device login with organization-scoped grants.
 * @param ctx - context supplying authorization and durable credentials.
 * @param options - resolve settings at the start of each attempt.
 */
export function registerConsoleFlow(ctx: Context, options: () => ConsoleOptions): void {
  ctx.authorization.registerFlow({
    key: OPENCODE_KEY, label: 'OpenCode Console',
    methods: [{ id: 'oauth', label: 'Sign in with OpenCode Console' }],
    async run(session) {
      const config = options()
      const device = deviceSchema.parse(await consoleJson(config, '/auth/device/code', {
        method: 'POST', signal: session.signal,
        body: JSON.stringify({ client_id: config.clientId, supports_org_scope: true }),
      }))
      const url = new URL(device.verification_uri_complete, `${config.server}/`)
      consoleUrl(url.origin)
      if (url.username || url.password || url.hostname !== new URL(config.server).hostname) throw new Error('OpenCode verification URL must use the Console host')
      if (device.interval > device.expires_in) throw new Error('OpenCode polling interval exceeds device lifetime')
      const deadline = AbortSignal.timeout(device.expires_in * 1000)
      const signal = AbortSignal.any([session.signal, deadline])
      session.notify({ message: 'Open this page and authorize your OpenCode Console organization.', url: url.href, code: device.user_code })
      let interval = Math.max(1000, device.interval * 1000)
      while (true) {
        await delay(interval, undefined, { signal })
        const response = await fetch(`${config.server}/auth/device/token`, {
          method: 'POST', redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]),
          headers: { 'content-type': 'application/json', 'user-agent': config.userAgent },
          body: JSON.stringify({ client_id: config.clientId, device_code: device.device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
        })
        const data: unknown = await response.json()
        signal.throwIfAborted()
        const pending = z.object({ error: z.string() }).safeParse(data)
        if (pending.success) {
          if (pending.data.error === 'authorization_pending') continue
          if (pending.data.error === 'slow_down') { interval += 5000; continue }
          throw new Error('OpenCode device authorization denied or expired')
        }
        if (!response.ok) throw new Error(`OpenCode device authorization failed (${response.status})`)
        const token = tokenSchema.parse(data)
        const expires = Date.now() + token.expires_in * 1000
        const headers = { authorization: `Bearer ${token.access_token}` }
        const [userData, orgData] = await Promise.all([
          consoleJson(config, '/api/user', { headers, signal }),
          consoleJson(config, '/api/orgs', { headers, signal }),
        ])
        const user = userSchema.parse(userData)
        const orgs = orgSchema.parse(orgData)
        const org = token.org_id == null
          ? orgs.toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0]
          : orgs.find(candidate => candidate.id === token.org_id)
        if (token.org_id != null && org === undefined) throw new Error('OpenCode authorized organization is unavailable')
        const payload: ConsoleGrant = {
          type: 'oauth', server: config.server, access: token.access_token, refresh: token.refresh_token,
          expires, email: user.email, accountId: user.id,
          ...org === undefined ? {} : { orgId: org.id, orgName: org.name },
        }
        signal.throwIfAborted()
        await ctx.credentials.modifyRecord(OPENCODE_KEY, () => {
          signal.throwIfAborted()
          return Promise.resolve({ kind: 'grant', payload })
        })
        return
      }
    },
  })
}

/**
 * Resolve or rotate the stored grant under the credential store's per-record lock.
 * @param ctx - canonical credential-store context.
 * @param config - settings frozen for this operation.
 * @param signal - cancellation, including cancellation while waiting for the record lock.
 * @returns usable grant, or undefined after sign-out; rotation preserves account and organization metadata.
 */
export async function resolveConsoleGrant(ctx: Context, config: ConsoleOptions, signal?: AbortSignal): Promise<ConsoleGrant | undefined> {
  signal?.throwIfAborted()
  const grant = storedGrant(await ctx.credentials.readRecord(OPENCODE_KEY))
  signal?.throwIfAborted()
  if (grant === undefined) return undefined
  if (consoleUrl(grant.server) !== config.server) throw new Error('OpenCode Console server changed; reconnect the account')
  if (grant.expires - Date.now() >= config.refreshMarginMs) return grant
  const rotation = ctx.credentials.modifyRecord(OPENCODE_KEY, async (current) => {
    signal?.throwIfAborted()
    const latest = storedGrant(current)
    if (latest === undefined || latest.expires - Date.now() >= config.refreshMarginMs) return current
    if (consoleUrl(latest.server) !== config.server) throw new Error('OpenCode Console server changed; reconnect the account')
    // Rotation consumes the previous refresh token; its bounded request and commit must finish even if one waiter cancels.
    const token = await exchangeToken(config, { grant_type: 'refresh_token', refresh_token: latest.refresh })
    const orgId = token.org_id ?? latest.orgId
    return { kind: 'grant', payload: {
      ...latest, access: token.access_token, refresh: token.refresh_token, expires: Date.now() + token.expires_in * 1000,
      ...orgId === undefined ? {} : { orgId, orgName: orgId === latest.orgId ? latest.orgName : orgId },
    } }
  })
  const cancelled = Promise.withResolvers<never>()
  const listener = signal === undefined ? undefined : addAbortListener(signal, () => { cancelled.reject(signal.reason) })
  try {
    const record = await (signal === undefined ? rotation : Promise.race([rotation, cancelled.promise]))
    signal?.throwIfAborted()
    return storedGrant(record)
  } finally {
    listener?.[Symbol.dispose]()
  }
}
