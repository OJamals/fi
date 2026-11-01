/** Account sign-in flows and grant resolution against scripted provider endpoints. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { registerFlows, resolveGrant } from '../src/authorization.ts'
import type { SubscriptionGrant, SubscriptionOptions } from '../src/protocol.ts'

const delays: number[] = []
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number) => {
    delays.push(ms)
    return Promise.resolve()
  },
}))
afterEach(() => {
  delays.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const options: SubscriptionOptions = {
  requestTimeoutMs: 1000,
  streamIdleTimeoutMs: 1000,
  authTimeoutMs: 2000,
  pollIntervalMs: 1,
  refreshMarginMs: 60_000,
  defaultContextWindow: 32768,
  defaultMaxTokens: 1024,
  kiroRegion: 'us-east-1',
  geminiProjectId: '',
  geminiClientId: 'client',
  geminiClientSecret: 'secret',
  geminiCallbackPort: 45289,
}
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'fi-subscriptions-auth-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(LlmRuntime)
  registerFlows(ctx, () => options)
  return ctx
}
const jwt = (claims: Record<string, unknown>) => `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
const soon = () => Math.floor(Date.now() / 1000) + 3600
type Responder = (request: Request) => Response | Promise<Response>
function script(responders: Responder[]) {
  const queue = [...responders]
  const seen: Request[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push(request.clone())
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (!next) throw new Error('unexpected request')
    return next(request)
  }))
  return seen
}
const interaction = (answer = '') => ({ notify: vi.fn<(notice: { url?: string }) => void>(), prompt: () => Promise.resolve(answer) })
const begin = (ctx: Context, provider: string, method: string, ui = interaction()) =>
  ctx.authorization.begin({ key: credentialKey('fi-subscriptions', provider), method, interaction: ui })

it('polls Cursor browser approval, ignoring pending polls, and stores the account with its refresh token', async () => {
  const ctx = await harness()
  const token = jwt({ exp: soon() })
  const seen = script([() => new Response(null, { status: 404 }), () => Response.json({ accessToken: token, refreshToken: 'refresh' })])
  const ui = interaction()
  expect(await begin(ctx, 'cursor', 'oauth', ui)).toEqual({ status: 'authorized' })
  expect(seen).toHaveLength(2)
  expect(new URL(seen[0]?.url ?? '').searchParams.get('uuid')).toBeTruthy()
  expect(ui.notify.mock.calls[0]?.[0].url).toContain('cursor.com/loginDeepControl')
  const grant = await resolveGrant(ctx, 'cursor', options)
  expect(grant).toMatchObject({ provider: 'cursor', accessToken: token, refreshToken: 'refresh' })
  expect(grant?.subscriptionAuth?.machineId).toMatch(/^[0-9a-f]{64}$/)
  // Without a refresh token the grant cannot be refreshed later.
  script([() => Response.json({ accessToken: token })])
  await begin(ctx, 'cursor', 'oauth')
  expect((await resolveGrant(ctx, 'cursor', options))?.refreshToken).toBe('')
})

it('fails Cursor approval on a server error or an already expired credential and stores nothing', async () => {
  const ctx = await harness()
  script([() => new Response('x', { status: 500 })])
  await expect(begin(ctx, 'cursor', 'oauth')).rejects.toThrow('Cursor authorization failed (500)')
  script([() => Response.json({ accessToken: jwt({ exp: Math.floor(Date.now() / 1000) - 10 }) })])
  await expect(begin(ctx, 'cursor', 'oauth')).rejects.toThrow('expired credential')
  script([() => Response.json({ accessToken: 'opaque' })])
  await expect(begin(ctx, 'cursor', 'oauth')).rejects.toThrow()
  expect(await ctx.credentials.readRecord(credentialKey('fi-subscriptions', 'cursor'))).toBeUndefined()
})

const register = () => Response.json({ clientId: 'id', clientSecret: 'secret' })
const device = (verificationUri = 'https://view.awsapps.com/start', interval = 0.001) => () =>
  Response.json({ deviceCode: 'device', userCode: 'CODE', verificationUri, expiresIn: 60, interval })

it('waits through pending and slow-down polls before storing the Kiro grant', async () => {
  const ctx = await harness()
  script([
    register, device(),
    () => Response.json({ error: 'authorization_pending' }),
    () => Response.json({ error: 'slow_down' }),
    () => Response.json({ accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600 }),
  ])
  const ui = interaction()
  expect(await begin(ctx, 'kiro', 'oauth', ui)).toEqual({ status: 'authorized' })
  expect(ui.notify).toHaveBeenCalledWith(expect.objectContaining({ code: 'CODE', url: 'https://view.awsapps.com/start' }))
  // The first poll waits the advertised interval; slow-down adds five seconds.
  expect(delays).toEqual([1, 1, 5001])
  expect(await resolveGrant(ctx, 'kiro', options)).toMatchObject({ provider: 'kiro', accessToken: 'access', subscriptionAuth: { clientId: 'id', region: 'us-east-1' } })
})

it('refuses unsafe approval URLs and denied Kiro authorizations', async () => {
  const ctx = await harness()
  for (const uri of ['http://view.awsapps.com/start', 'https://user:pw@view.awsapps.com/', 'https://view.awsapps.com:8443/', 'https://evil.example.com/start']) {
    script([register, device(uri)])
    await expect(begin(ctx, 'kiro', 'oauth'), uri).rejects.toThrow('Invalid Kiro approval URL')
  }
  script([register, device(), () => Response.json({ error: 'access_denied' })])
  await expect(begin(ctx, 'kiro', 'oauth')).rejects.toThrow('denied or expired')
  script([register, device(), () => Response.json({ accessToken: 'a' }, { status: 400 })])
  await expect(begin(ctx, 'kiro', 'oauth')).rejects.toThrow('denied or expired')
  expect(await ctx.credentials.readRecord(credentialKey('fi-subscriptions', 'kiro'))).toBeUndefined()
})

it('accepts exactly one Cline key', async () => {
  const ctx = await harness()
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  for (const answer of ['', '   ', 'two words']) await expect(begin(ctx, 'cline', 'api-key', interaction(answer))).rejects.toThrow('Enter one Cline API key')
  expect(fetchMock).not.toHaveBeenCalled()
})

const write = (ctx: Context, provider: string, payload: unknown) =>
  ctx.credentials.modifyRecord(credentialKey('fi-subscriptions', provider), async () => ({ kind: 'grant', payload }))
const stored = (provider: SubscriptionGrant['provider'], extra: Partial<SubscriptionGrant> = {}): SubscriptionGrant => ({
  provider, accessToken: 'old', refreshToken: 'refresh', expiresAt: '2000-01-01T00:00:00.000Z', ...extra,
})

it('returns unexpired grants untouched and refreshes Cursor with its stored refresh token', async () => {
  const ctx = await harness()
  expect(await resolveGrant(ctx, 'cline', options)).toBeUndefined()
  await write(ctx, 'cline', stored('cline', { expiresAt: '2099-01-01T00:00:00.000Z' }))
  expect(await resolveGrant(ctx, 'cline', options)).toMatchObject({ accessToken: 'old' })
  // Cursor refreshes five minutes early even though the configured margin is one minute.
  const fresh = jwt({ sub: 'u', exp: soon() })
  await write(ctx, 'cursor', stored('cursor', { accessToken: jwt({ sub: 'u', exp: Math.floor(Date.now() / 1000) + 240 }), expiresAt: new Date(Date.now() + 240_000).toISOString(), subscriptionAuth: { machineId: 'm' } }))
  const seen = script([() => Response.json({ access_token: fresh })])
  const [a, b] = await Promise.all([resolveGrant(ctx, 'cursor', options), resolveGrant(ctx, 'cursor', options)])
  expect([a?.accessToken, b?.accessToken]).toEqual([fresh, fresh])
  expect(seen).toHaveLength(1)
  expect(a).toMatchObject({ refreshToken: 'refresh', subscriptionAuth: { machineId: 'm' } })
  // A grant that refreshed elsewhere while this call waited is returned as is.
  expect(await resolveGrant(ctx, 'cursor', options)).toMatchObject({ accessToken: fresh })
})

it('reports expired Cursor and Cline grants and malformed stored credentials', async () => {
  const ctx = await harness()
  await write(ctx, 'cursor', stored('cursor', { refreshToken: '' }))
  await expect(resolveGrant(ctx, 'cursor', options)).rejects.toThrow('Cursor authorization expired; sign in again')
  await write(ctx, 'cline', stored('cline'))
  await expect(resolveGrant(ctx, 'cline', options)).rejects.toThrow('Cline key expired; reconnect your account')
  await write(ctx, 'kiro', stored('cline'))
  await expect(resolveGrant(ctx, 'kiro', options)).rejects.toThrow('provider mismatch')
  await ctx.credentials.modifyRecord(credentialKey('fi-subscriptions', 'kiro'), async () => ({ kind: 'api-key', key: 'x' }))
  await expect(resolveGrant(ctx, 'kiro', options)).rejects.toThrow('must be a grant')
  const aborted = new AbortController()
  aborted.abort()
  await write(ctx, 'cline', stored('cline', { expiresAt: '2099-01-01T00:00:00.000Z' }))
  await expect(resolveGrant(ctx, 'cline', options, aborted.signal)).rejects.toThrow()
})

it('refreshes a Google grant through the configured client and keeps its refresh token', async () => {
  const ctx = await harness()
  await write(ctx, 'gemini-cli', stored('gemini-cli', { subscriptionAuth: { projectId: 'project' } }))
  const seen = script([() => Response.json({ access_token: 'renewed', expires_in: 3600 })])
  expect(await resolveGrant(ctx, 'gemini-cli', options)).toMatchObject({
    accessToken: 'renewed', refreshToken: 'refresh', subscriptionAuth: { projectId: 'project' },
  })
  expect(seen[0]?.url).toBe('https://oauth2.googleapis.com/token')
  expect(new URLSearchParams(await seen[0]?.text()).get('grant_type')).toBe('refresh_token')
})

it('refreshes a Kiro grant under cancellation and honors a rotated refresh token', async () => {
  const ctx = await harness()
  await write(ctx, 'kiro', stored('kiro', { subscriptionAuth: { clientId: 'id', clientSecret: 'secret' } }))
  script([() => Response.json({ accessToken: 'renewed', refreshToken: 'rotated', expiresIn: 3600 })])
  expect(await resolveGrant(ctx, 'kiro', options, new AbortController().signal)).toMatchObject({ accessToken: 'renewed', refreshToken: 'rotated' })
  const midway = new AbortController()
  await write(ctx, 'kiro', stored('kiro'))
  script([() => { midway.abort(); return Response.json({ accessToken: 'late', expiresIn: 3600 }) }])
  await expect(resolveGrant(ctx, 'kiro', options, midway.signal)).rejects.toThrow()
})

it('uses the pi-ai Copilot login: signed out, default origin, and an account-specific origin', async () => {
  const ctx = await harness()
  const key = credentialKey('llm-pi-ai', 'github-copilot')
  expect(await resolveGrant(ctx, 'copilot', options)).toBeUndefined()
  const oauth = (access: string) => ({ type: 'oauth', access, refresh: 'github-token', expires: Date.now() + 3_600_000 })
  await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: oauth('plain-access') }))
  expect(await resolveGrant(ctx, 'copilot', options)).toMatchObject({
    accessToken: 'plain-access', refreshToken: 'github-token', subscriptionAuth: { apiBase: 'https://api.individual.githubcopilot.com' },
  })
  await ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: oauth('tid=1;proxy-ep=proxy.business.githubcopilot.com;') }))
  expect((await resolveGrant(ctx, 'copilot', options))?.subscriptionAuth?.apiBase).toBe('https://api.business.githubcopilot.com')
  const aborted = new AbortController()
  await expect(resolveGrant(ctx, 'copilot', options, aborted.signal)).resolves.toBeDefined()
})
