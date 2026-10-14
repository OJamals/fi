/** Browser authorization and refresh for official search MCP services. */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { auth, type OAuthClientProvider, type OAuthDiscoveryState, type StoredOAuthClientInformation, type StoredOAuthTokens } from '@modelcontextprotocol/client'
import { z } from 'zod'

/** Official OAuth resources; access tokens remain scoped to these MCP endpoints. */
export const searchOAuthProviders = {
  'exa-oauth': { label: 'Exa', url: 'https://mcp.exa.ai/mcp/oauth', tool: 'web_search_exa' },
  'parallel-oauth': { label: 'Parallel', url: 'https://search.parallel.ai/mcp-oauth', tool: 'web_search' },
  'tavily-oauth': { label: 'Tavily', url: 'https://mcp.tavily.com/mcp', tool: 'tavily_search' },
  'firecrawl-oauth': { label: 'Firecrawl', url: 'https://mcp.firecrawl.dev/v2/mcp-oauth', tool: 'firecrawl_search' },
} as const

/** Search routes whose credentials are OAuth grants. */
export type SearchOAuthId = keyof typeof searchOAuthProviders

/** Deployment bounds for browser authorization and search requests. */
export interface SearchOAuthLimits {
  /** Maximum time waiting for browser consent. */
  authTimeoutMs: number
  /** Deadline for each HTTP request. */
  requestTimeoutMs: number
  /** Maximum bytes read from one HTTP response. */
  maxResponseBytes: number
}

const grantSchema = z.object({
  redirect: z.url(),
  client: z.object({
    client_id: z.string().min(1), client_secret: z.string().optional(), issuer: z.string(),
    redirect_uris: z.array(z.string()), token_endpoint_auth_method: z.string().optional(),
  }),
  tokens: z.object({
    access_token: z.string().min(1), token_type: z.string().min(1),
    refresh_token: z.string().optional(), expires_in: z.number().optional(),
    scope: z.string().optional(), issuer: z.string(),
  }),
  expiresAt: z.number(),
})
type Grant = z.infer<typeof grantSchema>

/**
 * Bound HTTPS requests made by the MCP SDK, including discovery and token exchange.
 * @param signal - complete operation cancellation.
 * @param limits - per-request time and response-byte limits.
 * @returns fetch implementation with redirects refused and bounded response bodies.
 */
export function searchFetch(signal: AbortSignal, limits: SearchOAuthLimits): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.protocol !== 'https:') throw new Error('Search OAuth requires HTTPS')
    const response = await fetch(input, { ...init, redirect: 'error', signal: AbortSignal.any([
      signal, AbortSignal.timeout(limits.requestTimeoutMs), ...(init?.signal ? [init.signal] : []),
    ]) })
    if (response.body === null) return response
    let size = 0
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength
        if (size > limits.maxResponseBytes) throw new Error('Search response exceeds configured byte limit')
        controller.enqueue(chunk)
      },
    }))
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

function oauthClient(redirect: string, notify: (url: URL) => void, previous?: Grant) {
  let client: StoredOAuthClientInformation | undefined = previous?.client
  let tokens: StoredOAuthTokens | undefined = previous?.tokens
  let expiresAt = previous?.expiresAt ?? 0
  let verifier = ''
  let discovery: OAuthDiscoveryState | undefined
  const state = randomBytes(32).toString('base64url')
  const provider: OAuthClientProvider = {
    redirectUrl: redirect,
    clientMetadata: {
      client_name: 'Fi', redirect_uris: [redirect],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
    },
    state: () => state,
    clientInformation: () => client,
    saveClientInformation: (value) => { client = value },
    tokens: () => tokens,
    saveTokens: (value) => {
      tokens = { ...value, refresh_token: value.refresh_token ?? tokens?.refresh_token }
      // OAuth permits omitted expiry; such tokens remain usable until the resource refuses them.
      expiresAt = value.expires_in === undefined ? Number.MAX_SAFE_INTEGER : Date.now() + value.expires_in * 1000
    },
    redirectToAuthorization: notify,
    saveCodeVerifier: (value) => { verifier = value },
    codeVerifier: () => verifier,
    saveDiscoveryState: (value) => { discovery = value },
    discoveryState: () => discovery,
  }
  return { provider, state, grant: () => grantSchema.parse({ redirect, client, tokens, expiresAt }) }
}

async function login(session: AuthorizationSession, id: SearchOAuthId, limits: SearchOAuthLimits): Promise<Grant> {
  const signal = AbortSignal.any([session.signal, AbortSignal.timeout(limits.authTimeoutMs)])
  const callback = Promise.withResolvers<{ authorizationCode: string; iss?: string }>()
  void callback.promise.catch(() => undefined)
  let expectedState = ''
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (request.method !== 'GET' || url.pathname !== '/callback' || !expectedState || url.searchParams.get('state') !== expectedState) {
      response.writeHead(400).end('Invalid OAuth callback')
      return
    }
    const authorizationCode = url.searchParams.get('code')
    const iss = url.searchParams.get('iss')
    response.writeHead(authorizationCode ? 200 : 400, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      .end(authorizationCode ? 'Sign-in received. Return to Fi.' : 'Authorization denied.')
    if (!authorizationCode) callback.reject(new Error('Search authorization denied'))
    else callback.resolve({ authorizationCode, ...(iss === null ? {} : { iss }) })
  })
  const abort = () => { callback.reject(signal.reason); server.closeAllConnections(); server.close() }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    signal.throwIfAborted()
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Search callback unavailable')
    const client = oauthClient(`http://127.0.0.1:${address.port}/callback`, (url) => {
      session.notify({ message: `Sign in to ${searchOAuthProviders[id].label} in your browser.`, url: url.href })
    })
    expectedState = client.state
    const options = { serverUrl: searchOAuthProviders[id].url, fetchFn: searchFetch(signal, limits) }
    if (await auth(client.provider, options) === 'REDIRECT') {
      const answer = await callback.promise
      if (await auth(client.provider, { ...options, ...answer }) !== 'AUTHORIZED') throw new Error('Search authorization incomplete')
    }
    signal.throwIfAborted()
    return client.grant()
  } finally {
    signal.removeEventListener('abort', abort)
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() =>{  resolve() }) })
  }
}

/**
 * Register browser flows without changing the user's selected search provider.
 * @param ctx - authorization and credential owners.
 * @param limits - current deployment bounds.
 */
export function registerSearchOAuth(ctx: Context, limits: () => SearchOAuthLimits): void {
  for (const id of Object.keys(searchOAuthProviders) as SearchOAuthId[]) {
    ctx.authorization.registerFlow({
      key: credentialKey('fi-search', id), label: searchOAuthProviders[id].label,
      methods: [{ id: 'oauth', label: `Sign in to ${searchOAuthProviders[id].label}` }],
      async run(session) {
        const grant = await login(session, id, limits())
        session.signal.throwIfAborted()
        await session.commit({ kind: 'grant', payload: grant })
      },
    })
  }
}

/**
 * Resolve or serialize refresh of one OAuth grant; a concurrent revoke cannot resurrect it.
 * @param ctx - credential owner.
 * @param id - selected OAuth search resource.
 * @param limits - request bounds.
 * @param signal - caller cancellation.
 * @returns bearer token scoped to the official MCP endpoint.
 */
export async function resolveSearchToken(ctx: Context, id: SearchOAuthId, limits: SearchOAuthLimits, signal: AbortSignal): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('Search credentials are unavailable')
  const key = credentialKey('fi-search', id)
  const parse = (record: Awaited<ReturnType<typeof ctx.credentials.readRecord>>) => {
    if (!record || record.kind !== 'grant') throw new Error(`Sign in to ${searchOAuthProviders[id].label} in search settings`)
    return grantSchema.parse(record.payload)
  }
  const current = parse(await credentials.readRecord(key))
  signal.throwIfAborted()
  if (current.expiresAt > Date.now()) return current.tokens.access_token
  const record = await credentials.modifyRecord(key, async (stored) => {
    const grant = parse(stored)
    if (grant.expiresAt > Date.now()) return stored
    const client = oauthClient(grant.redirect, () => { throw new Error('Search sign-in expired; sign in again') }, grant)
    if (await auth(client.provider, { serverUrl: searchOAuthProviders[id].url, fetchFn: searchFetch(signal, limits) }) !== 'AUTHORIZED') {
      throw new Error('Search sign-in expired; sign in again')
    }
    signal.throwIfAborted()
    return { kind: 'grant', payload: client.grant() }
  })
  return parse(record).tokens.access_token
}
