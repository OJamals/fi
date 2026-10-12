/** OAuth wire responses, PKCE, and one-shot loopback listener lifecycle. */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, IncomingMessage, ServerResponse, type Server } from 'node:http'
import { Socket } from 'node:net'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  discoverAntigravityProject, exchangeAntigravityCode, generateAntigravityAuthURL,
  generateAntigravityPKCE, getAntigravityOAuthCallback, refreshAntigravityTokens, waitForAntigravityCallback,
} from '../src/auth/oauth.ts'

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>()
  return { ...actual, createServer: vi.fn(actual.createServer) }
})

const client = { clientId: 'fixture-client', clientSecret: 'fixture-secret' }
const pkce = { codeVerifier: 'fixture-verifier', codeChallenge: 'fixture-challenge' }
const exchange = (signal?: AbortSignal) => exchangeAntigravityCode('code', 'state', 'state', pkce, client, signal)

function callbackServer(): Server {
  const server = vi.mocked(createServer).mock.results[0]!.value as Server
  onTestFinished(async () => {
    if (!server.listening) return
    await new Promise<undefined>((resolve) => { server.close(() => { resolve(undefined) }); server.closeAllConnections() })
  })
  return server
}
beforeEach(() => {
  vi.stubEnv('ANTIGRAVITY_PROJECT_ID', '')
  vi.stubEnv('ANTIGRAVITY_OAUTH_REDIRECT_URI', '')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); vi.useRealTimers() })

it('generates fresh PKCE and a consent URL bound to state and callback', () => {
  const first = generateAntigravityPKCE()
  expect(first.codeVerifier).not.toBe(generateAntigravityPKCE().codeVerifier)
  expect(first.codeChallenge).toBe(createHash('sha256').update(first.codeVerifier).digest('base64url'))
  const url = new URL(generateAntigravityAuthURL('state', first, client))
  expect(Object.fromEntries(url.searchParams)).toMatchObject({ state: 'state', code_challenge: first.codeChallenge,
    code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', client_id: 'fixture-client' })
})

it.each([['https://localhost/cb', 443, '/cb'], ['http://localhost/cb', 80, '/cb'], ['http://localhost:1234/cb', 1234, '/cb'], ['data:', 80, '/callback']] as const)
('reads callback address %s', (url, port, path) => {
  vi.stubEnv('ANTIGRAVITY_OAUTH_REDIRECT_URI', url)
  expect(getAntigravityOAuthCallback()).toEqual({ callbackPort: port, callbackPath: path })
})

it('rejects a mismatched state before any network access', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(exchangeAntigravityCode('code', 'wrong', 'state', pkce, client)).rejects.toThrow('OAuth state mismatch')
  expect(fetch).not.toHaveBeenCalled()
})

it.each([{ cloudaicompanionProject: 'project' }, { cloudaicompanionProject: { id: 'project' } },
  { project: 'project' }, { project: { id: 'project' } }, { project: { projectId: 'project' } }])
('discovers supported project response %j', async (body) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
  await expect(discoverAntigravityProject('fixture')).resolves.toBe('project')
})

it('uses an explicitly configured project without dispatch', async () => {
  vi.stubEnv('ANTIGRAVITY_PROJECT_ID', 'configured-project')
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(discoverAntigravityProject('fixture')).resolves.toBe('configured-project')
  expect(fetch).not.toHaveBeenCalled()
})

it('rejects an absent project', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  await expect(discoverAntigravityProject('fixture')).rejects.toThrow('omitted cloudaicompanionProject')
})

it.each([false, true])('exchanges tokens, discovers identity, and preserves optional token fields=%s', async (optional) => {
  const signal = optional ? new AbortController().signal : undefined
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    if (new Request(input).url.includes('/token')) return Response.json({ access_token: 'access', refresh_token: 'refresh',
      ...optional ? { expires_in: 60, id_token: 'identity' } : {} })
    if (new Request(input).url.includes('userinfo')) return Response.json({ email: 'fixture@example.test' })
    return Response.json({ project: 'project' })
  })
  vi.stubGlobal('fetch', fetch)
  const start = Date.now()
  const grant = await exchange(signal)
  expect(grant).toMatchObject({ accessToken: 'access', refreshToken: 'refresh', email: 'fixture@example.test', antigravityProjectId: 'project' })
  expect(Date.parse(grant.expiresAt)).toBeGreaterThanOrEqual(start + (optional ? 60 : 3600) * 1000)
  expect(grant.idToken).toBe(optional ? 'identity' : undefined)
  expect(new URLSearchParams(await new Request(...fetch.mock.calls[0]!).text()).get('code_verifier')).toBe(pkce.codeVerifier)
  for (const [, init] of fetch.mock.calls) expect(init?.signal).toBe(signal ?? null)
})

it.each([{}, { access_token: 'access' }])('refuses incomplete exchanged tokens %j', async (body) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
  await expect(exchange()).rejects.toThrow('omitted access_token or refresh_token')
})

it.each([undefined, '', 7])('refuses invalid user email %s', async (email) => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (new Request(input).url.includes('/token')) return Response.json({ access_token: 'access', refresh_token: 'refresh' })
    if (new Request(input).url.includes('userinfo')) return Response.json({ email })
    return Response.json({ project: 'project' })
  }))
  await expect(exchange()).rejects.toThrow('omitted email')
})

it.each(['token', 'userinfo', 'project'] as const)('preserves %s HTTP status when body cleanup rejects', async (stage) => {
  const cancel = vi.fn(async () => { throw new Error('cleanup failed') })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const requestStage = new Request(input).url.includes('/token') ? 'token' : new Request(input).url.includes('userinfo') ? 'userinfo' : 'project'
    if (requestStage === stage) return new Response(new ReadableStream({ cancel }), { status: 503 })
    if (requestStage === 'token') return Response.json({ access_token: 'access', refresh_token: 'refresh' })
    if (requestStage === 'userinfo') return Response.json({ email: 'fixture@example.test' })
    return Response.json({ project: 'project' })
  }))
  await expect(exchange()).rejects.toThrow('(503)')
  expect(cancel).toHaveBeenCalledOnce()
})

it.each([false, true])('refreshes tokens while retaining or rotating refresh token=%s', async (rotate) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ access_token: 'new-access',
    ...rotate ? { refresh_token: 'rotated', id_token: 'identity', expires_in: 60 } : {} })))
  const grant = await refreshAntigravityTokens('original', client)
  expect(grant.refreshToken).toBe(rotate ? 'rotated' : 'original')
  expect(grant.idToken).toBe(rotate ? 'identity' : undefined)
})

it('refuses refresh without an access token', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  await expect(refreshAntigravityTokens('original', client)).rejects.toThrow('omitted access_token')
})

it('accepts one valid callback after refusing wrong paths and missing parameters', async () => {
  const operation = waitForAntigravityCallback({ port: 0, callbackPath: '/fixture', timeoutMs: 5000 })
  const server = callbackServer()
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener')
  const base = `http://127.0.0.1:${address.port}`
  expect((await fetch(`${base}/wrong`)).status).toBe(404)
  expect((await fetch(`${base}/fixture`)).status).toBe(400)
  expect((await fetch(`${base}/fixture?code=code`)).status).toBe(400)
  const closed = once(server, 'close')
  expect((await fetch(`${base}/fixture?code=code&state=state`)).status).toBe(200)
  await expect(operation).resolves.toEqual({ code: 'code', state: 'state' })
  await closed
})

it.each([undefined, null, new Error('cancelled')])('rejects an already cancelled callback listener: %s', async (reason) => {
  const controller = new AbortController()
  controller.abort(reason)
  await expect(waitForAntigravityCallback({ signal: controller.signal })).rejects.toBeInstanceOf(Error)
})

it('reports provider refusal and closes its callback listener', async () => {
  vi.stubEnv('ANTIGRAVITY_OAUTH_REDIRECT_URI', 'http://127.0.0.1:0/callback')
  const operation = waitForAntigravityCallback()
  const rejection = expect(operation).rejects.toThrow('OAuth error: access_denied')
  const server = callbackServer()
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected TCP listener')
  const closed = once(server, 'close')
  expect((await fetch(`http://127.0.0.1:${address.port}/callback?error=access_denied`)).status).toBe(400)
  await rejection
  await closed
})

it('expires a callback wait and ignores a subsequent listener error', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const operation = waitForAntigravityCallback({ port: 0, timeoutMs: 100 })
  const rejected = expect(operation).rejects.toThrow('callback timeout')
  const server = callbackServer()
  await once(server, 'listening')
  const closed = once(server, 'close')
  await vi.advanceTimersByTimeAsync(100)
  await rejected
  await closed
  server.emit('error', new Error('late listener failure'))
})

it('rejects a callback listener error and closes its port', async () => {
  const operation = waitForAntigravityCallback({ port: 0 })
  const rejected = expect(operation).rejects.toThrow('listener failed')
  const server = callbackServer()
  await once(server, 'listening')
  const closed = new Promise<undefined>((resolve) => { server.once('close', () => { resolve(undefined) }) })
  server.emit('error', new Error('listener failed'))
  await rejected
  await closed
})

it('rejects a request without a URL and cancels a listening callback server', async () => {
  const controller = new AbortController()
  const operation = waitForAntigravityCallback({ port: 0, signal: controller.signal })
  const rejected = expect(operation).rejects.toThrow('cancelled')
  const server = callbackServer()
  await once(server, 'listening')
  const socket = new Socket()
  const request = new IncomingMessage(socket)
  const response = new ServerResponse(request)
  server.emit('request', request, response)
  expect(response.statusCode).toBe(404)
  socket.destroy()
  const closed = once(server, 'close')
  controller.abort(new Error('cancelled'))
  await rejected
  await closed
})
