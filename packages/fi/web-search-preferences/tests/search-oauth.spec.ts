/** Official MCP OAuth resources use PKCE, state validation, refresh, and isolated credentials. */
import { Context } from '@deepseek-ai/cordis'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { afterEach, expect, it, vi } from 'vitest'
import { registerSearchOAuth, resolveSearchToken, searchFetch } from '../src/search-oauth.ts'
import { createOAuthSearchProvider, normalizeSearchResult } from '../src/oauth-provider.ts'

const limits = { authTimeoutMs: 10_000, requestTimeoutMs: 5000, maxResponseBytes: 100_000 }
const nativeFetch = globalThis.fetch
afterEach(() => vi.unstubAllGlobals())

function flows(): AuthorizationFlow[] {
  const flows: AuthorizationFlow[] = []
  registerSearchOAuth({ authorization: { registerFlow: (flow: AuthorizationFlow) => { flows.push(flow) } } } as Context, () => limits)
  return flows
}

function server() {
  const requests: { url: URL; body: Record<string, unknown>; authorization: string | null }[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.protocol === 'http:') return nativeFetch(input, init)
    const raw = typeof init?.body === 'string' ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : ''
    const body = raw.startsWith('{') ? z.record(z.string(), z.unknown()).parse(JSON.parse(raw)) : Object.fromEntries(new URLSearchParams(raw))
    requests.push({ url, body, authorization: new Headers(init?.headers).get('authorization') })
    if (url.pathname.includes('oauth-protected-resource')) return Response.json({ resource: 'https://mcp.exa.ai/mcp/oauth', authorization_servers: ['https://auth.search.test'] })
    if (url.pathname.includes('well-known')) return Response.json({
      issuer: 'https://auth.search.test', authorization_endpoint: 'https://auth.search.test/authorize',
      token_endpoint: 'https://auth.search.test/token', registration_endpoint: 'https://auth.search.test/register',
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
    })
    if (url.pathname === '/register') return Response.json({ ...body, client_id: 'fi-test' })
    if (url.pathname === '/token') return Response.json({ access_token: 'access', token_type: 'Bearer', refresh_token: 'refresh', expires_in: 3600 })
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } } })
    if (body.method === 'tools/call') return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: 'Title: Official\nURL: https://example.com\nText: Result' }] } })
    if (init?.method === 'GET') return new Response(null, { status: 405 })
    return new Response(null, { status: 202 })
  }))
  return requests
}

it('completes PKCE after rejecting a wrong callback state; grant then serves authenticated MCP search', async () => {
  const requests = server()
  const flow = flows()[0]!
  let record: CredentialRecord | undefined
  let notified: URL | undefined
  const callback = Promise.withResolvers<undefined>()
  const session: AuthorizationSession = {
    method: 'oauth', signal: new AbortController().signal,
    prompt: async () => { throw new Error('unexpected prompt') },
    notify: (notice) => {
      notified = new URL(notice.url!)
      void (async () => {
        const target = new URL(notified.searchParams.get('redirect_uri')!)
        target.search = new URLSearchParams({ code: 'test-code', state: 'wrong' }).toString()
        expect((await nativeFetch(target)).status).toBe(400)
        target.searchParams.set('state', notified.searchParams.get('state')!)
        expect((await nativeFetch(target)).status).toBe(200)
        callback.resolve(undefined)
      })().catch(callback.reject)
    },
    commit: async (value) => { record = value },
  }
  await flow.run(session)
  await callback.promise
  expect(notified?.searchParams.get('code_challenge_method')).toBe('S256')
  expect(requests.find(request => request.url.pathname === '/token')?.body).toMatchObject({ grant_type: 'authorization_code', code: 'test-code' })
  const ctx = new Context()
  ctx.provide('credentials', { readRecord: async () => record } as never)
  const result = await createOAuthSearchProvider(ctx, 'exa-oauth', limits).search({ query: 'official', maxResults: 1 })
  expect(result.sources).toEqual([{ title: 'Official', url: 'https://example.com' }])
  expect(requests.find(request => request.body.method === 'tools/call')).toMatchObject({ authorization: 'Bearer access', body: { params: { name: 'web_search_exa', arguments: { query: 'official', numResults: 1 } } } })
  const redirect = notified!.searchParams.get('redirect_uri')!
  await expect(nativeFetch(redirect)).rejects.toThrow()
})

it('refreshes expired grants inside the credential update and refuses signed-out accounts', async () => {
  const requests = server()
  let record: CredentialRecord | undefined = { kind: 'grant', payload: { redirect: 'http://127.0.0.1:1234/callback', expiresAt: 0,
    client: { client_id: 'fi-test', issuer: 'https://auth.search.test', redirect_uris: ['http://127.0.0.1:1234/callback'] },
    tokens: { access_token: 'expired', refresh_token: 'refresh', token_type: 'Bearer', issuer: 'https://auth.search.test' },
  } }
  const ctx = new Context()
  ctx.provide('credentials', {
    readRecord: async () => record,
    modifyRecord: async (_key: string, update: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      record = await update(record)
      return record
    },
  } as never)
  await expect(resolveSearchToken(ctx, 'exa-oauth', limits, new AbortController().signal)).resolves.toBe('access')
  expect(requests.find(request => request.url.pathname === '/token')?.body.grant_type).toBe('refresh_token')
  const refreshed = z.object({ payload: z.object({ expiresAt: z.number() }) }).parse(record)
  expect(refreshed.payload.expiresAt).toBeGreaterThan(Date.now())
  record = undefined
  await expect(resolveSearchToken(ctx, 'exa-oauth', limits, new AbortController().signal)).rejects.toThrow('Sign in to Exa')
})

it('bounds responses and rejects non-HTTPS destinations', async () => {
  const fetcher = searchFetch(new AbortController().signal, { ...limits, maxResponseBytes: 2 })
  vi.stubGlobal('fetch', async () => new Response('oversize'))
  await expect((await fetcher('https://example.com')).text()).rejects.toThrow('byte limit')
  await expect(fetcher('http://example.com')).rejects.toThrow('HTTPS')
})

it.each([
  ['exa-oauth', 'web_search_exa', { query: 'evidence', objective: 'evidence', numResults: 1 }],
  ['parallel-oauth', 'web_search', { objective: 'evidence', search_queries: ['evidence'] }],
  ['tavily-oauth', 'tavily_search', { query: 'evidence', objective: 'evidence', max_results: 5 }],
  ['firecrawl-oauth', 'firecrawl_search', { query: 'evidence', objective: 'evidence', limit: 1 }],
] as const)('routes %s grants to their vendor tool', async (id, name, args) => {
  const requests = server()
  const ctx = new Context()
  ctx.provide('credentials', { readRecord: async () => ({ kind: 'grant', payload: {
    redirect: 'http://127.0.0.1:1234/callback', expiresAt: Date.now() + 3_600_000,
    client: { client_id: 'fi-test', issuer: 'https://auth.search.test', redirect_uris: ['http://127.0.0.1:1234/callback'] },
    tokens: { access_token: 'account-token', token_type: 'Bearer', issuer: 'https://auth.search.test' },
  } }) } as never)
  await createOAuthSearchProvider(ctx, id, limits).search({ query: 'evidence', maxResults: 1 })
  expect(requests.find(request => request.body.method === 'tools/call')).toMatchObject({
    authorization: 'Bearer account-token', body: { params: { name, arguments: args } },
  })
})

it('cancels browser consent without committing a grant or retaining its callback listener', async () => {
  server()
  const controller = new AbortController()
  const commit = vi.fn()
  let redirect = ''
  await expect(flows()[0]!.run({
    method: 'oauth', signal: controller.signal, commit,
    prompt: async () => '',
    notify: (notice) => {
      redirect = new URL(notice.url!).searchParams.get('redirect_uri')!
      controller.abort(new Error('cancelled by user'))
    },
  })).rejects.toThrow('cancelled by user')
  expect(commit).not.toHaveBeenCalled()
  await expect(nativeFetch(redirect)).rejects.toThrow()
})

it('keeps native sources distinct from URLs embedded in result prose', () => {
  const result = normalizeSearchResult('Snippet mentions https://fake.example', { data: { web: [{ url: 'https://real.example', title: 'Real' }, { url: 'file:///etc/passwd' }] } }, 1)
  expect(result.sources).toEqual([{ url: 'https://real.example', title: 'Real' }])
})
