/** Cursor browser approval, Kiro device approval, and Cline account-key entry. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { authContextFrom, credentialStoreFrom, createModels } from '@deepseek-ai/dsh-llm-pi-ai'
import { githubCopilotProvider } from '@earendil-works/pi-ai/providers/github-copilot'
import { z } from 'zod'
import { clineHeaders, grantSchema, json, kiroRegion, providerIds, withTimeoutSignal } from './protocol.ts'
import type { SubscriptionGrant, SubscriptionId, SubscriptionOptions } from './protocol.ts'
import { CURSOR_REFRESH_LEAD_MS, refreshCursor } from './cursor-auth.ts'
import { loginGemini, refreshGemini } from './gemini-auth.ts'

/** Labels shared by provider discovery and sign-in. */
export const labels = {
  'copilot': 'github copilot',
  cursor: 'cursor',
  kiro: 'kiro',
  cline: 'cline free / pass',
  'gemini-cli': 'gemini code assist',
} as const
const cursorSchema = z.object({ accessToken: z.string().min(1), refreshToken: z.string().optional() })
const kiroToken = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresIn: z.number().positive().max(31_536_000),
})

async function cursor(
  session: AuthorizationSession,
  config: SubscriptionOptions,
  signal: AbortSignal,
): Promise<SubscriptionGrant> {
  const verifier = randomBytes(32).toString('base64url'),
    uuid = randomUUID()
  const url = new URL('https://cursor.com/loginDeepControl')
  url.search = new URLSearchParams({
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    uuid,
    mode: 'login',
    redirectTarget: 'cli',
  }).toString()
  session.notify({ message: 'Complete Cursor sign-in in your browser.', url: url.href })
  const poll = new URL('https://api2.cursor.sh/auth/poll')
  poll.search = new URLSearchParams({ uuid, verifier }).toString()
  while (true) {
    await delay(config.pollIntervalMs, undefined, { signal })
    const response = await fetch(poll, {
      redirect: 'error',
      signal: withTimeoutSignal(config.requestTimeoutMs, signal),
    })
    if (response.status === 404) {
      await response.body?.cancel()
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`Cursor authorization failed (${response.status})`)
    }
    const token = cursorSchema.parse(await response.json())
    const claims = z
      .object({ exp: z.number().positive() })
      .parse(JSON.parse(Buffer.from(token.accessToken.split('.')[1] ?? '', 'base64url').toString()))
    if (claims.exp * 1000 <= Date.now()) throw new Error('Cursor returned an expired credential')
    return {
      provider: 'cursor',
      accessToken: token.accessToken,
      refreshToken: token.refreshToken ?? '',
      expiresAt: new Date(claims.exp * 1000).toISOString(),
      subscriptionAuth: { machineId: randomBytes(32).toString('hex') },
    }
  }
}

async function kiro(
  session: AuthorizationSession,
  config: SubscriptionOptions,
  signal: AbortSignal,
): Promise<SubscriptionGrant> {
  const region = kiroRegion({ region: config.kiroRegion }),
    base = `https://oidc.${region}.amazonaws.com`
  const registration = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1) }).parse(
    await json(`${base}/client/register`, config, {
      method: 'POST',
      signal,
      body: JSON.stringify({
        clientName: 'kiro-oauth-client',
        clientType: 'public',
        scopes: ['codewhisperer:completions', 'codewhisperer:analysis', 'codewhisperer:conversations'],
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
        issuerUrl: 'https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6',
      }),
    }),
  )
  const device = z
    .object({
      deviceCode: z.string().min(1),
      userCode: z.string().min(1),
      verificationUri: z.url(),
      expiresIn: z.number().positive().max(3600),
      interval: z.number().positive().max(60).default(5),
    })
    .parse(
      await json(`${base}/device_authorization`, config, {
        method: 'POST',
        signal,
        body: JSON.stringify({ ...registration, startUrl: 'https://view.awsapps.com/start' }),
      }),
    )
  const url = new URL(device.verificationUri)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !(url.hostname === 'view.awsapps.com' || url.hostname.endsWith('.amazonaws.com'))
  )
    throw new Error('Invalid Kiro approval URL')
  session.notify({ message: 'Approve this device in your AWS account.', url: url.href, code: device.userCode })
  const deadline = withTimeoutSignal(device.expiresIn * 1000, signal)
  let interval = device.interval * 1000
  while (true) {
    await delay(interval, undefined, { signal: deadline })
    const response = await fetch(`${base}/token`, {
      method: 'POST',
      redirect: 'error',
      signal: withTimeoutSignal(config.requestTimeoutMs, deadline),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...registration,
        deviceCode: device.deviceCode,
        grantType: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    })
    const data: unknown = await response.json()
    const error = z.object({ error: z.string() }).safeParse(data)
    if (error.success && error.data.error === 'authorization_pending') continue
    if (error.success && error.data.error === 'slow_down') {
      interval += 5000
      continue
    }
    if (!response.ok || error.success) throw new Error('Kiro authorization denied or expired')
    const token = kiroToken.parse(data)
    return {
      provider: 'kiro',
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: new Date(Date.now() + token.expiresIn * 1000).toISOString(),
      subscriptionAuth: { ...registration, region },
    }
  }
}

/**
 * Register each native provider's account flow in the canonical credential store.
 * @param ctx - authorization and credential owners.
 * @param options - validated deployment configuration.
 */
export function registerFlows(ctx: Context, options: () => SubscriptionOptions): void {
  for (const id of providerIds.filter(id => id !== 'copilot'))
    ctx.authorization.registerFlow({
      key: credentialKey('fi-subscriptions', id),
      label: labels[id],
      methods: [
        {
          id: id === 'cline' ? 'api-key' : 'oauth',
          label: id === 'cline' ? 'Connect Cline account' : `Sign in with ${labels[id]}`,
        },
      ],
      async run(session) {
        const config = options(),
          signal = withTimeoutSignal(config.authTimeoutMs, session.signal)
        let grant: SubscriptionGrant
        if (id === 'cline') {
          session.notify({
            message: 'Create an API key in your Cline account. Free and Pass model access follows your account.',
            url: 'https://app.cline.bot/',
          })
          const key = (await session.prompt({ kind: 'secret', message: 'Cline API key' })).trim()
          if (!key || /\s/.test(key)) throw new Error('Enter one Cline API key')
          await json('https://api.cline.bot/api/v1/ai/cline/recommended-models', config, {
            headers: clineHeaders(key),
            signal,
          })
          grant = { provider: id, accessToken: key, refreshToken: '', expiresAt: '9999-01-01T00:00:00.000Z' }
        } else if (id === 'cursor') grant = await cursor(session, config, signal)
        else if (id === 'kiro') grant = await kiro(session, config, signal)
        else grant = await loginGemini(session, config, signal)
        signal.throwIfAborted()
        await session.commit({ kind: 'grant', payload: grant })
      },
    })
}

/**
 * Read or serialize refresh of an account grant; sign-out cannot resurrect credentials.
 * @param ctx - credential owner.
 * @param id - native provider.
 * @param config - refresh timing and provider settings.
 * @param signal - caller cancellation.
 * @returns usable grant, or undefined while signed out.
 */
export async function resolveGrant(
  ctx: Context,
  id: SubscriptionId,
  config: SubscriptionOptions,
  signal?: AbortSignal,
): Promise<SubscriptionGrant | undefined> {
  if (id === 'copilot') {
    const store = credentialStoreFrom(ctx)
    const models = createModels({ credentials: store, authContext: authContextFrom(ctx) })
    models.setProvider(githubCopilotProvider())
    const resolved = await models.getAuth('github-copilot', signal === undefined ? {} : { signal })
    // The GitHub account token identifies the install and looks up the premium quota reset.
    const stored = await store.read('github-copilot', signal === undefined ? {} : { signal })
    if (resolved?.source !== 'OAuth' || typeof resolved.auth.apiKey !== 'string' || stored?.type !== 'oauth') return undefined
    return {
      provider: id, accessToken: resolved.auth.apiKey, refreshToken: stored.refresh,
      expiresAt: '9999-01-01T00:00:00.000Z',
      subscriptionAuth: { apiBase: resolved.auth.baseUrl },
    }
  }
  const key = credentialKey('fi-subscriptions', id)
  const parse = (record: Awaited<ReturnType<typeof ctx.credentials.readRecord>>) => {
    if (!record) return undefined
    if (record.kind !== 'grant') throw new Error('Subscription credential must be a grant')
    const grant = grantSchema.parse(record.payload)
    if (grant.provider !== id) throw new Error('Subscription credential provider mismatch')
    return grant
  }
  const margin = id === 'cursor' ? Math.max(config.refreshMarginMs, CURSOR_REFRESH_LEAD_MS) : config.refreshMarginMs
  const current = parse(await ctx.credentials.readRecord(key))
  signal?.throwIfAborted()
  if (!current || Date.parse(current.expiresAt) > Date.now() + margin) return current
  const record = await ctx.credentials.modifyRecord(key, async (stored) => {
    const grant = parse(stored)
    signal?.throwIfAborted()
    if (!grant || Date.parse(grant.expiresAt) > Date.now() + margin) return stored
    let next: SubscriptionGrant
    if (id === 'cursor') next = await refreshCursor(grant, config, signal)
    else if (id === 'gemini-cli') next = await refreshGemini(grant, config, signal)
    else if (id === 'kiro') {
      const auth = grant.subscriptionAuth
      const token = kiroToken.extend({ refreshToken: z.string().min(1).optional() }).parse(
        await json(`https://oidc.${kiroRegion(auth)}.amazonaws.com/token`, config, {
          method: 'POST',
          signal: signal ?? null,
          body: JSON.stringify({
            clientId: auth?.clientId,
            clientSecret: auth?.clientSecret,
            grantType: 'refresh_token',
            refreshToken: grant.refreshToken,
          }),
        }),
      )
      next = {
        ...grant,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? grant.refreshToken,
        expiresAt: new Date(Date.now() + token.expiresIn * 1000).toISOString(),
      }
    } else throw new Error('Cline key expired; reconnect your account')
    signal?.throwIfAborted()
    return { kind: 'grant', payload: next }
  })
  return parse(record)
}
