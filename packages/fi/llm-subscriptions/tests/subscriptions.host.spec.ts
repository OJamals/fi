/** Credential, Loader, and maintained streaming integration checks. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubscriptionService from '../src/index.ts'
import { SubscriptionAdapter } from '../src/adapter.ts'
import { registerFlows, resolveGrant } from '../src/authorization.ts'
import { catalog } from '../src/catalog.ts'
import { discoverProject, refreshGemini } from '../src/gemini-auth.ts'
import type { SubscriptionGrant, SubscriptionOptions } from '../src/protocol.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

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
  geminiClientSecret: 'public-client',
  geminiCallbackPort: 45289,
}
const seed: SubscriptionGrant = {
  provider: 'cline',
  accessToken: 'fixture-key',
  refreshToken: '',
  expiresAt: '2099-01-01T00:00:00.000Z',
}
const clineKey = credentialKey('fi-subscriptions', 'cline')
const contexts: Context[] = [],
  dirs: string[] = []
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'fi-subscriptions-'))
  dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(LlmRuntime)
  return ctx
}
function script(handler: (request: Request) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))),
  )
}
const models = { free: [{ id: 'cline-free/test' }], clinePass: [{ id: 'cline-pass/test' }] }
it('uses pi-ai Copilot OAuth with the native chat catalog and rejects foreign origins', async () => {
  const ctx = await harness()
  await ctx.credentials.modifyRecord(credentialKey('llm-pi-ai', 'github-copilot'), async () => ({ kind: 'grant', payload: {
    type: 'oauth', access: 'fixture-access', refresh: 'fixture-refresh', expires: Date.now() + 3_600_000,
  } }))
  const grant = await resolveGrant(ctx, 'copilot', options)
  expect(grant?.accessToken).toBe('fixture-access')
  if (!grant) throw new Error('Missing fixture grant')
  script((request) => {
    expect(request.url).toBe('https://api.individual.githubcopilot.com/models')
    expect(request.headers.get('authorization')).toBe('Bearer fixture-access')
    return Response.json({ data: [
      { id: 'gpt-4.1', capabilities: { type: 'chat' } },
      { id: 'responses-only', capabilities: { type: 'chat' }, supported_endpoints: ['/responses'] },
      { id: 'embedding', capabilities: { type: 'embeddings' } },
    ] })
  })
  expect(await catalog(grant, options)).toEqual(['gpt-4.1'])
  await expect(catalog({ ...grant, subscriptionAuth: { apiBase: 'https://example.com' } }, options)).rejects.toThrow('Invalid Copilot API origin')
})

it.each(['cursor', 'kiro'] as const)('commits %s only after browser or device approval', async (provider) => {
  const ctx = await harness()
  registerFlows(ctx, () => options)
  const key = credentialKey('fi-subscriptions', provider)
  const jwt = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`
  const notices: string[] = []
  script(async (request) => {
    expect(await ctx.credentials.readRecord(key)).toBeUndefined()
    const url = new URL(request.url)
    if (provider === 'cursor') {
      expect(url.hostname).toBe('api2.cursor.sh')
      expect(url.searchParams.get('verifier')?.length).toBeGreaterThan(20)
      return Response.json({ accessToken: jwt })
    }
    if (url.pathname === '/client/register') return Response.json({ clientId: 'id', clientSecret: 'secret' })
    if (url.pathname === '/device_authorization') return Response.json({ deviceCode: 'device', userCode: 'code',
      verificationUri: 'https://view.awsapps.com/start', expiresIn: 60, interval: 0.001 })
    expect(url.pathname).toBe('/token')
    return Response.json({ accessToken: 'access', refreshToken: 'refresh', expiresIn: 3600 })
  })
  expect(await ctx.authorization.begin({ key, method: 'oauth', interaction: {
    notify(notice) { if (notice.url) notices.push(notice.url) }, prompt: async () => '',
  } })).toEqual({ status: 'authorized' })
  expect(notices).toHaveLength(1)
  expect(await resolveGrant(ctx, provider, options)).toMatchObject({ provider })
})

it.each(['geminiClientId', 'geminiClientSecret'] as const)('rejects missing %s before Google authorization or refresh', async (field) => {
  const config = { ...options, [field]: '' }
  const ctx = await harness()
  registerFlows(ctx, () => config)
  const notify = vi.fn()
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const key = credentialKey('fi-subscriptions', 'gemini-cli')
  await expect(ctx.authorization.begin({ key, method: 'oauth', interaction: {
    notify, prompt: async () => '',
  } })).rejects.toThrow('Configure geminiClientId and geminiClientSecret')
  await expect(refreshGemini({ ...seed, provider: 'gemini-cli' }, config))
    .rejects.toThrow('Configure geminiClientId and geminiClientSecret')
  expect(notify).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
  expect(await ctx.credentials.readRecord(key)).toBeUndefined()
})

it('uses Code Assist project envelope and shared Gemini stream translation', async () => {
  const grant: SubscriptionGrant = { ...seed, provider: 'gemini-cli', subscriptionAuth: { projectId: 'test-project' } }
  script(async (request) => {
    if (request.url.endsWith('retrieveUserQuota')) return Response.json({ buckets: [{ modelId: 'gemini-test' }] })
    expect(request.url).toBe('https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse')
    const body: unknown = await request.json()
    expect(body).toMatchObject({ model: 'gemini-test', project: 'test-project' })
    expect(body).toHaveProperty('request.contents')
    expect(body).not.toHaveProperty('userAgent')
    return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'PONG' }] }, finishReason: 'STOP' }] } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } })
  })
  const adapter = new SubscriptionAdapter(() => options, async () => grant, () => ({}))
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider: 'gemini-cli', model: 'gemini-test',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'PING' }] }] })) chunks.push(chunk)
  expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'PONG' }))
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
})
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

it('exposes native flows and adopts routes through Loader without coupling discovery to selection', async () => {
  const ctx = await harness()
  const live = await liveConfig(ctx, SubscriptionService, { ...options, providers: {} }, 'fi-subscriptions')
  expect(ctx.authorization.list().map(row => row.key)).toEqual(
    ['cursor', 'kiro', 'cline', 'gemini-cli'].map(id => `fi-subscriptions/${id}`),
  )
  expect(ctx.llm.listProviders()).toEqual([])
  await ctx.credentials.modifyRecord(clineKey, async () => ({ kind: 'grant', payload: seed }))
  script(() => Response.json(models))
  await live.update({ providers: { cline: { models: [] } } })
  expect(await ctx.llm.listModels('cline')).toEqual([])
  expect(await ctx.llm.discoverModels('fi-subscriptions', { provider: 'cline' })).toHaveLength(2)
  await live.fiber.dispose()
  expect(ctx.authorization.list()).toEqual([])
  expect(ctx.llm.listConfigurableProviders()).toEqual([])
})

it('validates Cline account key before commit; cancellation preserves existing grant', async () => {
  const ctx = await harness()
  registerFlows(ctx, () => options)
  script((request) => {
    expect(request.headers.get('x-client-type')).toBe('fi')
    expect(request.headers.get('authorization')).toBe('Bearer entered-key')
    return Response.json(models)
  })
  expect(
    await ctx.authorization.begin({
      key: clineKey,
      method: 'api-key',
      interaction: { notify() {}, prompt: async () => 'entered-key' },
    }),
  ).toEqual({ status: 'authorized' })
  const stored = await ctx.credentials.readRecord(clineKey)
  script(() => {
    ctx.authorization.cancel(clineKey)
    return Response.json(models)
  })
  expect(
    await ctx.authorization.begin({
      key: clineKey,
      method: 'api-key',
      interaction: { notify() {}, prompt: async () => 'replacement' },
    }),
  ).toEqual({ status: 'cancelled' })
  expect(await ctx.credentials.readRecord(clineKey)).toEqual(stored)
})

it('serializes Kiro refresh and retains refresh token when upstream omits rotation', async () => {
  const ctx = await harness(),
    key = credentialKey('fi-subscriptions', 'kiro')
  await ctx.credentials.modifyRecord(key, async () => ({
    kind: 'grant',
    payload: {
      ...seed,
      provider: 'kiro',
      refreshToken: 'refresh',
      expiresAt: '2000-01-01T00:00:00.000Z',
      subscriptionAuth: { clientId: 'id', clientSecret: 'secret', region: 'us-east-1' },
    },
  }))
  script((request) => {
    expect(request.url).toBe('https://oidc.us-east-1.amazonaws.com/token')
    return Response.json({ accessToken: 'renewed', expiresIn: 3600 })
  })
  const grants = await Promise.all([resolveGrant(ctx, 'kiro', options), resolveGrant(ctx, 'kiro', options)])
  expect(grants.every(grant => grant?.refreshToken === 'refresh' && grant.accessToken === 'renewed')).toBe(true)
  expect(fetch).toHaveBeenCalledOnce()
})

it('fails Code Assist entitlement without inventing an eligible project', async () => {
  script(() => Response.json({ ineligibleTiers: [{ reasonCode: 'UNSUPPORTED_CLIENT' }] }))
  await expect(discoverProject('token', options, new AbortController().signal)).rejects.toThrow('UNSUPPORTED_CLIENT')
})

it('omits a configured Cloud project from free-tier onboarding metadata', async () => {
  script(async (request) => {
    const body: unknown = await request.json()
    if (request.url.endsWith(':loadCodeAssist'))
      return Response.json({ allowedTiers: [{ id: 'free-tier', isDefault: true }] })
    expect(body).toEqual({ tierId: 'free-tier', metadata: {
      ideType: 'IDE_UNSPECIFIED', pluginType: 'GEMINI', platform: 'PLATFORM_UNSPECIFIED',
    } })
    return Response.json({ done: true, response: { cloudaicompanionProject: 'free-project' } })
  })
  expect(await discoverProject('token', { ...options, geminiProjectId: 'configured-project' }, new AbortController().signal))
    .toBe('free-project')
})

it('deduplicates Gemini quota models and rejects malformed catalogs', async () => {
  const grant: SubscriptionGrant = { ...seed, provider: 'gemini-cli', subscriptionAuth: { projectId: 'project-id' } }
  script(() =>
    Response.json({ buckets: [{ modelId: 'gemini-test' }, { modelId: 'gemini-test' }, { modelId: 'not-chat' }] }),
  )
  expect(await catalog(grant, options)).toEqual(['gemini-test'])
  script(() => Response.json({ buckets: false }))
  await expect(catalog(grant, options)).rejects.toThrow()
})

it.each([
  { model: 'cline-free/test', sessionId: undefined },
  { model: 'cline-pass/test', sessionId: SessionId('cline-session') },
])('streams $model with truthful identity and optional task tracking', async ({ model, sessionId }) => {
  script(async (request) => {
    if (request.url.endsWith('recommended-models')) return Response.json(models)
    expect(request.url).toBe('https://api.cline.bot/api/v1/chat/completions')
    expect(request.headers.get('x-client-type')).toBe('fi')
    expect(request.headers.get('x-task-id')).toBe(sessionId ?? null)
    const body = await request.text()
    expect(body).not.toContain(seed.accessToken)
    expect(z.object({ model: z.string() }).parse(JSON.parse(body)).model).toBe(model)
    expect(body).not.toContain('cline-session')
    return new Response(
      'data: {"choices":[{"index":0,"delta":{"content":"PONG"},"finish_reason":null}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  })
  const adapter = new SubscriptionAdapter(
    () => options,
    async () => seed,
    () => ({}),
  )
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'cline',
    model,
    ...sessionId === undefined ? {} : { sessionId },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'PING' }] }],
  }))
    chunks.push(chunk)
  expect(JSON.stringify(chunks)).toContain('PONG')
  expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
})
