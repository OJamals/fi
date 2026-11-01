/** Google Code Assist project entitlement and the state-checked loopback sign-in. */
import { createServer } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { discoverProject, loginGemini, refreshGemini } from '../src/gemini-auth.ts'
import type { SubscriptionGrant, SubscriptionOptions } from '../src/protocol.ts'

const realFetch = globalThis.fetch
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const options: SubscriptionOptions = {
  requestTimeoutMs: 2000,
  streamIdleTimeoutMs: 2000,
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
type Responder = (method: string, request: Request) => unknown
/** Answer Code Assist RPCs by method name and everything else through a handler. */
function rpc(responder: Responder) {
  const calls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (new URL(request.url).hostname === '127.0.0.1') return realFetch(request)
    const method = request.url.split(/[:/]/).at(-1) ?? ''
    calls.push(method)
    return Response.json(responder(method, request))
  }))
  return calls
}
const discover = (config: Partial<SubscriptionOptions> = {}) =>
  discoverProject('token', { ...options, ...config }, new AbortController().signal)

it('resolves the project of an account that already has a tier', async () => {
  rpc(() => ({ currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'tier-project' }))
  expect(await discover()).toBe('tier-project')
  rpc(() => ({ currentTier: { id: 'standard-tier' } }))
  expect(await discover({ geminiProjectId: 'configured-project' })).toBe('configured-project')
  await expect(discover()).rejects.toThrow('requires geminiProjectId')
})

it('onboards the default tier, polling its operation until the project arrives', async () => {
  const bodies: unknown[] = []
  const calls = rpc((method, request) => {
    if (method === 'loadCodeAssist') return { allowedTiers: [{ id: 'free-tier' }, { id: 'standard-tier', isDefault: true }] }
    if (method === 'onboardUser') {
      void request.clone().json().then((body: unknown) => bodies.push(body))
      return { done: false, name: 'operations/abc_1/x' }
    }
    return { done: true, response: { cloudaicompanionProject: { id: 'polled-project' } } }
  })
  expect(await discover({ geminiProjectId: 'configured-project' })).toBe('polled-project')
  expect(calls).toEqual(['loadCodeAssist', 'onboardUser', 'operations/abc_1/x'].map(call => call.split('/').at(-1)))
  expect(bodies[0]).toMatchObject({ tierId: 'standard-tier', cloudaicompanionProject: 'configured-project' })
})

it('refuses accounts and operations that cannot yield a project', async () => {
  const tiered = (tier: object, operation: object = { done: true, response: {} }) => rpc(method =>
    method === 'loadCodeAssist' ? { allowedTiers: [{ id: 't', isDefault: true, ...tier }] } : operation)
  rpc(() => ({}))
  await expect(discover()).rejects.toThrow('No eligible Code Assist onboarding tier')
  tiered({ userDefinedCloudaicompanionProject: true })
  await expect(discover()).rejects.toThrow('requires geminiProjectId')
  tiered({}, { done: false })
  await expect(discover()).rejects.toThrow('Invalid Code Assist onboarding operation')
  tiered({}, { done: false, name: '../escape' })
  await expect(discover()).rejects.toThrow('Invalid Code Assist onboarding operation')
  tiered({}, { done: true, error: { code: 3 } })
  await expect(discover()).rejects.toThrow('onboarding failed')
  tiered({}, { done: true })
  await expect(discover()).rejects.toThrow('returned no project')
  tiered({}, { done: true, response: { cloudaicompanionProject: 'string-project' } })
  expect(await discover()).toBe('string-project')
  tiered({}, { done: true, response: {} })
  expect(await discover({ geminiProjectId: 'fallback-project' })).toBe('fallback-project')
})

async function freePort() {
  const probe = createServer()
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve))
  const address = probe.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  await new Promise<void>(resolve => probe.close(() => { resolve() }))
  return address.port
}
async function signIn(config: SubscriptionOptions, callback: (base: string, state: string) => Promise<void>) {
  const notices: string[] = []
  const login = loginGemini({ notify: (notice: { url?: string }) => { if (notice.url) notices.push(notice.url) }, prompt: () => Promise.resolve('') } as never,
    config, AbortSignal.timeout(4000))
  const settled = login.then(value => ({ value }), (error: unknown) => ({ error }))
  await vi.waitFor(() => { expect(notices).toHaveLength(1) })
  const url = new URL(notices[0] ?? '')
  await callback(`http://127.0.0.1:${config.geminiCallbackPort}/oauth2callback`, url.searchParams.get('state') ?? '')
  return { url, outcome: await settled }
}

it('signs in through a state-checked loopback callback, then exchanges the code and resolves the project', async () => {
  const port = await freePort()
  const forms: URLSearchParams[] = []
  rpc((method, request) => {
    if (request.url.startsWith('https://oauth2.googleapis.com/token')) return { access_token: 'access', refresh_token: 'refresh', expires_in: 3600 }
    void method
    return { currentTier: { id: 'standard-tier' }, cloudaicompanionProject: 'signed-in-project' }
  })
  const { url, outcome } = await signIn({ ...options, geminiCallbackPort: port }, async (base, state) => {
    expect((await realFetch(`${base}?state=wrong&code=x`)).status).toBe(400)
    expect((await realFetch(`http://127.0.0.1:${port}/elsewhere?state=${state}&code=x`)).status).toBe(400)
    expect((await realFetch(`${base}?state=${state}`, { method: 'POST' })).status).toBe(400)
    const ok = await realFetch(`${base}?state=${state}&code=the-code`)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('Sign-in received')
  })
  void forms
  expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  expect(url.searchParams.get('redirect_uri')).toBe(`http://127.0.0.1:${port}/oauth2callback`)
  expect(outcome).toMatchObject({ value: { provider: 'gemini-cli', accessToken: 'access', refreshToken: 'refresh', subscriptionAuth: { projectId: 'signed-in-project' } } })
})

it('reports a denied consent and a missing refresh token', async () => {
  const port = await freePort()
  rpc(() => ({ access_token: 'access', expires_in: 3600 }))
  const denied = await signIn({ ...options, geminiCallbackPort: port }, async (base, state) => {
    const response = await realFetch(`${base}?state=${state}`)
    expect(response.status).toBe(400)
  })
  expect((denied.outcome as { error: Error }).error.message).toBe('Google authorization denied')
  const second = await freePort()
  const missing = await signIn({ ...options, geminiCallbackPort: second }, async (base, state) => {
    await realFetch(`${base}?state=${state}&code=c`)
  })
  expect((missing.outcome as { error: Error }).error.message).toContain('omitted refresh token')
})

it('stops listening when cancelled and refuses to start without a client or a free port', async () => {
  const port = await freePort()
  const controller = new AbortController()
  const login = loginGemini({ notify: () => { controller.abort(new Error('cancelled')) } } as never, { ...options, geminiCallbackPort: port }, controller.signal)
  await expect(login).rejects.toThrow('cancelled')
  const pre = new AbortController()
  pre.abort(new Error('before listening'))
  await expect(loginGemini({ notify: vi.fn() } as never, { ...options, geminiCallbackPort: port }, pre.signal)).rejects.toThrow('before listening')
  await expect(loginGemini({ notify: vi.fn() } as never, { ...options, geminiClientId: '' }, new AbortController().signal)).rejects.toThrow('Configure geminiClientId')
  const busy = createServer()
  await new Promise<void>(resolve => busy.listen(0, '127.0.0.1', resolve))
  const address = busy.address()
  if (!address || typeof address === 'string') throw new Error('No port')
  await expect(loginGemini({ notify: vi.fn() } as never, { ...options, geminiCallbackPort: address.port }, new AbortController().signal)).rejects.toThrow('EADDRINUSE')
  await new Promise<void>(resolve => busy.close(() => { resolve() }))
})

it('refreshes the access token, keeping the refresh token unless Google rotates it', async () => {
  const grant: SubscriptionGrant = {
    provider: 'gemini-cli', accessToken: 'old', refreshToken: 'refresh', expiresAt: '2000-01-01T00:00:00.000Z', subscriptionAuth: { projectId: 'p' },
  }
  rpc(() => ({ access_token: 'renewed', expires_in: 3600 }))
  expect(await refreshGemini(grant, options)).toMatchObject({ accessToken: 'renewed', refreshToken: 'refresh', subscriptionAuth: { projectId: 'p' } })
  rpc(() => ({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 }))
  const rotated = await refreshGemini(grant, options, new AbortController().signal)
  expect(rotated.refreshToken).toBe('rotated')
  expect(Date.parse(rotated.expiresAt)).toBeGreaterThan(Date.now())
})
