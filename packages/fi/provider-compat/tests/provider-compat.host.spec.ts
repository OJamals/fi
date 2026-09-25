import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import type { PiAiLiveModelsContext } from '@deepseek-ai/dsh-llm-pi-ai'
import {
  apply,
  allProviderSettings,
  authorizationHeaders,
  Config,
  createAsyncCache,
  HARNESS_ATTRIBUTION_HEADER,
  providerSettingsFor,
  subscriptionEndpoint,
  subscriptionFetch,
  subscriptionHeaders,
} from '../src/index.ts'

const HARNESS_USER_AGENT = 'deepseek-harness/test (+https://example.test)'

afterEach(() => { vi.unstubAllGlobals() })

/**
 * One mounted instance of the plugin's `llm-pi-ai/live-models` listener,
 * reusable across several calls in the same test — the shape a TTL or ETag
 * case needs, since each instance owns its own caches for as long as it
 * stays mounted.
 */
interface LiveModelsSession {
  request(
    request: PiAiLiveModelsContext & { provider: 'anthropic' | 'openai-codex' | 'xai' },
  ): Promise<readonly { id: string; name?: string }[]>
  dispose(): Promise<void>
}

function mountLiveModels(config: Config = {}): LiveModelsSession {
  const ctx = new Context()
  apply(ctx, config)
  return {
    request: request => ctx.waterfall('llm-pi-ai/live-models', request, () => Promise.resolve([])),
    dispose: () => ctx.fiber.dispose(),
  }
}

/**
 * Fetch requests as `fetchLiveModels` would send them, in one fresh mount:
 * a live-model request through the `llm-pi-ai/live-models` waterfall over a
 * stubbed global `fetch`. Every case is offered the same OAuth apiKey a real
 * Claude Code, Codex, or Grok CLI carries, never a real production token.
 */
async function liveModelRequest(
  request: PiAiLiveModelsContext & { provider: 'anthropic' | 'openai-codex' | 'xai' },
  config: Config = {},
): Promise<readonly { id: string; name?: string }[]> {
  const session = mountLiveModels(config)
  try {
    return await session.request(request)
  } finally {
    await session.dispose()
  }
}

interface CapturedRequest {
  url: string
  headers: Headers
}

/** Stub the global `fetch` to record every call and answer from a script, one reply per call. */
function stubFetch(script: readonly (() => Response)[]): CapturedRequest[] {
  const requests: CapturedRequest[] = []
  let index = 0
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, headers: new Headers(init?.headers) })
    const respond = script[index++] ?? (() => new Response('script exhausted', { status: 500 }))
    return respond()
  })
  return requests
}

const ANTHROPIC_OAUTH_TOKEN = 'sk-ant-oat-test-placeholder'
const CODEX_OAUTH_TOKEN = `header.${Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' },
})).toString('base64url')}.signature`
const GROK_OAUTH_TOKEN = `header.${Buffer.from(JSON.stringify({ sub: 'user-test' })).toString('base64url')}.signature`

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

function headersOf(input: RequestInfo | URL, init?: RequestInit): Headers {
  const headers = new Headers(input instanceof Request ? input.headers : undefined)
  new Headers(init?.headers).forEach((value, name) => { headers.set(name, value) })
  return headers
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

describe('provider compatibility metadata', () => {
  it('retains all four canonical records, OAuth scopes, release evidence, and capture separation', () => {
    const settings = allProviderSettings()

    expect(Object.keys(settings)).toEqual(['grokCode', 'antigravityCli', 'claudeCode', 'codexCli'])
    expect(settings.grokCode.oauthScopes).toContain('grok-cli:access')
    expect(settings.antigravityCli.oauth.scopes).toEqual([
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
    ])
    expect(settings.antigravityCli.oauth).not.toHaveProperty('clientSecret')
    expect(settings.claudeCode.oauth.scopes).toContain('user:inference')
    expect(settings.codexCli.oauth.scopes).toContain('api.connectors.invoke')
    // Release versions advance with the daily metadata refresh; captured fingerprints change only by review.
    expect(settings.claudeCode.latestReleaseVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(settings.claudeCode.fingerprintCapturedVersion).toBe('2.1.269')
    expect(settings.antigravityCli.latestReleaseVersion).toMatch(/^\d+\.\d+\.\d+$/)
    expect(settings.antigravityCli.fingerprintCapturedVersion).toBe('1.2.1')
    expect(settings.claudeCode.fingerprintEvidence.artifact.binarySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(settings.antigravityCli.releaseEvidence.verifiedArtifact.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('returns copies so callers cannot replace package-owned metadata', () => {
    const first = providerSettingsFor('grokCode')
    const version = first.version
    ;(first as { version: string }).version = 'changed-by-caller'

    expect(providerSettingsFor('grokCode').version).toBe(version)
  })
})

describe('pi-ai transport integration', () => {
  it('provides a WebSocket factory only for Codex subscription candidates', async () => {
    const ctx = new Context()
    apply(ctx)

    const codex = await ctx.waterfall('llm-pi-ai/request-transport', {
      provider: 'openai-codex',
      model: 'gpt-5.5',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, () => Promise.resolve(undefined))
    const grok = await ctx.waterfall('llm-pi-ai/request-transport', {
      provider: 'xai',
      model: 'grok-4.3',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, () => Promise.resolve(undefined))

    expect(codex?.websocketFactory).toBeTypeOf('function')
    expect(grok?.websocketFactory).toBeUndefined()
    await ctx.fiber.dispose()
  })
})

describe('subscription headers', () => {
  it('normalizes API-key authorization without replacing supplied authorization', () => {
    expect(authorizationHeaders({ apiKey: 'stored-key' })).toEqual({ Authorization: 'Bearer stored-key' })
    expect(authorizationHeaders({
      apiKey: 'ignored-key',
      headers: { authorization: 'Bearer supplied-token', 'x-client': 'test' },
    })).toEqual({ authorization: 'Bearer supplied-token', 'x-client': 'test' })
  })

  it('builds Codex wire identity while preserving Harness attribution separately', () => {
    const token = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-test' },
    })
    const headers = subscriptionHeaders('openai-codex', 'gpt-5.5', 'session-test', 45_000, {
      Authorization: `Bearer ${token}`,
      'User-Agent': HARNESS_USER_AGENT,
      'X-Caller': 'preserved',
    })

    expect(headers['User-Agent']).toMatch(new RegExp(`^codex_cli_rs/${escapeRegExp(providerSettingsFor('codexCli').version)} `))
    expect(headers[HARNESS_ATTRIBUTION_HEADER]).toBe(HARNESS_USER_AGENT)
    expect(headers['ChatGPT-Account-ID']).toBe('account-test')
    expect(headers['X-Caller']).toBe('preserved')
  })

  it('uses the captured Haiku beta set and request metadata for Claude', () => {
    const headers = subscriptionHeaders('anthropic', 'claude-haiku-4-5', 'session-test', 45_001, {
      Authorization: 'Bearer sk-ant-oat-test-placeholder',
      'User-Agent': HARNESS_USER_AGENT,
    })

    expect(headers['User-Agent']).toBe('claude-cli/2.1.269 (external, sdk-cli)')
    expect(headers['X-Claude-Code-Session-Id']).toBe('session-test')
    expect(headers['X-Stainless-Timeout']).toBe('46')
    expect(headers['anthropic-beta']).toContain('claude-code-20250219')
    expect(headers['anthropic-beta']).not.toContain('effort-2025-11-24')
  })

  it('derives Grok CLI routing headers from the OAuth subject', () => {
    const token = jwt({ sub: 'user-test' })
    const headers = subscriptionHeaders('xai', 'grok-4.3', 'session-test', 60_000, {
      Authorization: `Bearer ${token}`,
      'User-Agent': HARNESS_USER_AGENT,
    })

    expect(headers['X-XAI-Token-Auth']).toBe('xai-grok-cli')
    expect(headers['x-grok-model-override']).toBe('grok-4.3')
    expect(headers['x-grok-user-id']).toBe('user-test')
    expect(headers[HARNESS_ATTRIBUTION_HEADER]).toBe(HARNESS_USER_AGENT)
  })

  it('fails closed without provider OAuth bearer evidence', () => {
    expect(() => subscriptionHeaders('xai', 'grok-4.3', 'session-test', 60_000, {
      Authorization: 'Bearer ordinary-public-api-key',
    })).toThrow('JWT payload')
    expect(() => subscriptionHeaders('anthropic', 'claude-sonnet-4-5', 'session-test', 60_000, {
      'x-api-key': 'ordinary-public-api-key',
    })).toThrow('bearer OAuth')
  })
})

describe('subscription fetch', () => {
  it('rewrites the exact xAI Responses request and asserts final wire headers', async () => {
    const token = jwt({ sub: 'wire-user-test' })
    const delegate = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      expect(urlOf(input)).toBe('https://cli-chat-proxy.grok.com/v1/responses')
      const headers = headersOf(input, init)
      expect(headers.get('authorization')).toBe(`Bearer ${token}`)
      expect(headers.get('user-agent')).toMatch(new RegExp(`^grok-shell/${escapeRegExp(providerSettingsFor('grokCode').version)} `))
      expect(headers.get('x-xai-token-auth')).toBe('xai-grok-cli')
      expect(headers.get('x-deepseek-harness-user-agent')).toBe(HARNESS_USER_AGENT)
      return Promise.resolve(new Response('{}'))
    })
    const fetch = subscriptionFetch({
      provider: 'xai',
      model: 'grok-4.3',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, delegate)

    await fetch('https://api.x.ai/v1/responses', {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'pi/test' },
    })

    expect(delegate).toHaveBeenCalledOnce()
    expect(subscriptionEndpoint('xai')).toBe('https://cli-chat-proxy.grok.com/v1/responses')
  })

  it('matches Anthropic messages with beta=true while preserving the query', async () => {
    const delegate = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      expect(urlOf(input)).toBe('https://api.anthropic.com/v1/messages?beta=true')
      const headers = headersOf(input, init)
      expect(headers.get('authorization')).toBe('Bearer sk-ant-oat-wire-placeholder')
      expect(headers.get('user-agent')).toBe('claude-cli/2.1.269 (external, sdk-cli)')
      expect(headers.get('x-claude-code-session-id')).toBe('session-test')
      expect(headers.get('x-deepseek-harness-user-agent')).toBe(HARNESS_USER_AGENT)
      return Promise.resolve(new Response('{}'))
    })
    const fetch = subscriptionFetch({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, delegate)

    await fetch('https://api.anthropic.com/v1/messages?beta=true', {
      headers: { Authorization: 'Bearer sk-ant-oat-wire-placeholder', 'User-Agent': 'pi/test' },
    })

    expect(delegate).toHaveBeenCalledOnce()
  })

  it('preserves request-specific Anthropic betas using Claude Code wire names', async () => {
    const delegate = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const betas = headersOf(input, init).get('anthropic-beta')?.split(',') ?? []
      if (typeof init?.body !== 'string') throw new Error('Anthropic request body must be serialized JSON')
      const body = JSON.parse(init.body) as { messages?: Array<Record<string, unknown>> }
      if (body.messages?.some(message => message.output_config !== undefined)
        && !betas.includes('per-turn-control-2026-07-01')) {
        return Promise.resolve(new Response(JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: 'messages.1.output_config: Extra inputs are not permitted',
          },
        }), { status: 400 }))
      }
      return Promise.resolve(new Response('{}'))
    })
    const fetch = subscriptionFetch({
      provider: 'anthropic',
      model: 'claude-fable-5-1',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, delegate)

    const response = await fetch('https://api.anthropic.com/v1/messages?beta=true', {
      headers: {
        Authorization: 'Bearer sk-ant-oat-wire-placeholder',
        'anthropic-beta': [
          'claude-code-20250219',
          'mid-conversation-output-config-2026-07-01',
          'thinking-binding-controls-2026-08-01',
        ].join(','),
      },
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-fable-5-1',
        messages: [
          { role: 'user', content: 'ping' },
          { role: 'system', content: [], output_config: { effort: 'low' } },
        ],
        output_config: { effort: 'low' },
        thinking: {
          type: 'adaptive',
          block_binding: { prefix_mismatch_behavior: 'drop_block' },
        },
      }),
    })

    expect(response.status).toBe(200)
    const betas = headersOf(...delegate.mock.calls[0]!).get('anthropic-beta')?.split(',') ?? []
    expect(betas).toContain('claude-code-20250219')
    expect(betas).toContain('per-turn-control-2026-07-01')
    expect(betas).toContain('thinking-binding-controls-2026-08-01')
    expect(betas).not.toContain('mid-conversation-output-config-2026-07-01')
    expect(delegate).toHaveBeenCalledOnce()
  })

  it('does not decorate non-inference or unsupported-query requests', async () => {
    const delegate = vi.fn(() => Promise.resolve(new Response('{}')))
    const fetch = subscriptionFetch({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, delegate)
    const init = { headers: { Authorization: 'Bearer ordinary-public-api-key' } }

    await fetch('https://api.anthropic.com/v1/messages?other=true', init)

    expect(delegate).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages?other=true', init)
  })

  it('refuses redirects before credential-derived identity can reach another origin', async () => {
    let targetRequests = 0
    const target = createServer((_request, response) => {
      targetRequests += 1
      response.end('{}')
    })
    target.listen(0, '127.0.0.1')
    await once(target, 'listening')
    const targetAddress = target.address()
    if (targetAddress === null || typeof targetAddress === 'string') throw new Error('test target lacks TCP address')
    const source = createServer((_request, response) => {
      response.writeHead(307, { Location: `http://127.0.0.1:${targetAddress.port}/capture` })
      response.end()
    })
    source.listen(0, '127.0.0.1')
    await once(source, 'listening')
    const sourceAddress = source.address()
    if (sourceAddress === null || typeof sourceAddress === 'string') throw new Error('test source lacks TCP address')
    const delegate: typeof globalThis.fetch = (_input, init) => fetch(
      `http://127.0.0.1:${sourceAddress.port}/messages`,
      init,
    )
    const wrapped = subscriptionFetch({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      sessionId: 'session-test',
      timeoutMs: 60_000,
      harnessUserAgent: HARNESS_USER_AGENT,
    }, delegate)

    try {
      await expect(wrapped('https://api.anthropic.com/v1/messages?beta=true', {
        headers: { Authorization: 'Bearer sk-ant-oat-wire-placeholder' },
        method: 'POST',
        body: JSON.stringify({ prompt: 'private-test-placeholder' }),
        redirect: 'follow',
      })).rejects.toThrow()
      expect(targetRequests).toBe(0)
    } finally {
      source.close()
      target.close()
      await Promise.all([once(source, 'close'), once(target, 'close')])
    }
  })
})

describe('live subscription model discovery', () => {
  it('reads Anthropic\'s model directory with Claude Code OAuth identity, keeping only claude- ids', async () => {
    const requests = stubFetch([() => new Response(JSON.stringify({
      data: [{ id: 'claude-sonnet-4-7' }, { id: 'claude-sonnet-4-7' }, { id: 'gpt-4' }, { id: 42 }],
    }), { status: 200 })])

    const models = await liveModelRequest({ provider: 'anthropic', apiKey: ANTHROPIC_OAUTH_TOKEN })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://api.anthropic.com/v1/models?limit=1000')
    const headers = requests[0]?.headers
    expect(headers?.get('authorization')).toBe(`Bearer ${ANTHROPIC_OAUTH_TOKEN}`)
    expect(headers?.get('anthropic-version')).toBe('2023-06-01')
    expect(headers?.get('anthropic-beta')).toContain('oauth-2025-04-20')
    expect(headers?.get('user-agent')).toMatch(/^claude-cli\//)
    // No wire token, other secret, or their headers ever reach a log call this
    // test can observe; the assertions above are made against the captured
    // request alone, never a console/logger spy.
    expect(models).toEqual([{ id: 'claude-sonnet-4-7' }])
  })

  it('reads Codex\'s model manifest with account headers, dropping hidden entries', async () => {
    const settings = providerSettingsFor('codexCli')
    const requests = stubFetch([() => new Response(JSON.stringify({
      models: [
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6 Sol' },
        { slug: 'gpt-5.6-hidden', display_name: 'Hidden', visibility: 'hide' },
        { display_name: 'no slug' },
      ],
    }), { status: 200, headers: { etag: '"v1"' } })])

    const models = await liveModelRequest({ provider: 'openai-codex', apiKey: CODEX_OAUTH_TOKEN })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(
      `${settings.baseUrl}${settings.modelsPath}?client_version=${encodeURIComponent(settings.version)}`,
    )
    const headers = requests[0]?.headers
    expect(headers?.get('authorization')).toBe(`Bearer ${CODEX_OAUTH_TOKEN}`)
    expect(headers?.get('chatgpt-account-id')).toBe('account-test')
    expect(headers?.get('originator')).toBe(settings.originator)
    expect(headers?.get('accept')).toBe('application/json')
    expect(headers?.has('if-none-match')).toBe(false)
    expect(models).toEqual([{ id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' }])
  })

  it('revalidates Codex\'s manifest with the prior ETag and reuses its model list on a 304', async () => {
    const session = mountLiveModels({ liveModelDiscoveryCacheTtlMs: 1_000 })
    try {
      const requests = stubFetch([
        () => new Response(JSON.stringify({ models: [{ slug: 'gpt-5.6-sol' }] }), {
          status: 200,
          headers: { etag: '"v1"' },
        }),
        () => new Response(null, { status: 304 }),
      ])
      vi.useFakeTimers()

      const first = await session.request({ provider: 'openai-codex', apiKey: CODEX_OAUTH_TOKEN })
      vi.advanceTimersByTime(1_001)
      const second = await session.request({ provider: 'openai-codex', apiKey: CODEX_OAUTH_TOKEN })

      expect(requests).toHaveLength(2)
      expect(requests[1]?.headers.get('if-none-match')).toBe('"v1"')
      expect(second).toEqual(first)
      expect(second).toEqual([{ id: 'gpt-5.6-sol' }])
    } finally {
      vi.useRealTimers()
      await session.dispose()
    }
  })

  it('reads Grok\'s CLI model listing with Grok CLI identity', async () => {
    const settings = providerSettingsFor('grokCode')
    const requests = stubFetch([() => new Response(JSON.stringify({
      data: [{ id: 'grok-4.5' }, { id: 'grok-9-preview' }, { notAnId: true }],
    }), { status: 200 })])

    const models = await liveModelRequest({ provider: 'xai', apiKey: GROK_OAUTH_TOKEN })

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${settings.cliBaseUrl}/models`)
    const headers = requests[0]?.headers
    expect(headers?.get('authorization')).toBe(`Bearer ${GROK_OAUTH_TOKEN}`)
    expect(headers?.get('x-xai-token-auth')).toBe(settings.tokenAuth)
    expect(headers?.get('x-grok-user-id')).toBe('user-test')
    expect(models).toEqual([{ id: 'grok-4.5' }, { id: 'grok-9-preview' }])
  })

  it('keeps the catalog-only list — an empty result — on a non-2xx reply, for every provider', async () => {
    stubFetch([() => new Response('server error', { status: 500 })])
    await expect(liveModelRequest({ provider: 'anthropic', apiKey: ANTHROPIC_OAUTH_TOKEN })).resolves.toEqual([])

    stubFetch([() => new Response('server error', { status: 500 })])
    await expect(liveModelRequest({ provider: 'openai-codex', apiKey: CODEX_OAUTH_TOKEN })).resolves.toEqual([])

    stubFetch([() => new Response('server error', { status: 500 })])
    await expect(liveModelRequest({ provider: 'xai', apiKey: GROK_OAUTH_TOKEN })).resolves.toEqual([])
  })

  it('keeps the catalog-only list when the network itself fails', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('network down')))

    await expect(liveModelRequest({ provider: 'anthropic', apiKey: ANTHROPIC_OAUTH_TOKEN })).resolves.toEqual([])
  })

  it('keeps the catalog-only list when the reply is not the expected JSON shape', async () => {
    stubFetch([() => new Response(JSON.stringify({ unexpected: true }), { status: 200 })])

    await expect(liveModelRequest({ provider: 'anthropic', apiKey: ANTHROPIC_OAUTH_TOKEN })).resolves.toEqual([])
  })

  it('caches a successful listing for the configured TTL, then refreshes once it elapses', async () => {
    const session = mountLiveModels({ liveModelDiscoveryCacheTtlMs: 1_000 })
    try {
      const requests = stubFetch([
        () => new Response(JSON.stringify({ data: [{ id: 'grok-4.5' }] }), { status: 200 }),
        () => new Response(JSON.stringify({ data: [{ id: 'grok-9-preview' }] }), { status: 200 }),
      ])
      vi.useFakeTimers()

      const first = await session.request({ provider: 'xai', apiKey: GROK_OAUTH_TOKEN })
      const stillCached = await session.request({ provider: 'xai', apiKey: GROK_OAUTH_TOKEN })
      expect(requests).toHaveLength(1)
      expect(stillCached).toEqual(first)

      vi.advanceTimersByTime(1_001)
      const refreshed = await session.request({ provider: 'xai', apiKey: GROK_OAUTH_TOKEN })

      expect(requests).toHaveLength(2)
      expect(refreshed).toEqual([{ id: 'grok-9-preview' }])
    } finally {
      vi.useRealTimers()
      await session.dispose()
    }
  })

  it('never fetches for a route this package carries no subscription identity for', async () => {
    const requests = stubFetch([() => new Response('unexpected', { status: 500 })])

    const passthrough = await mountLiveModels().request(
      { provider: 'deepseek' as unknown as 'anthropic', apiKey: 'irrelevant' },
    )

    expect(passthrough).toEqual([])
    expect(requests).toHaveLength(0)
  })

  it('fetches nothing at all when live model discovery is disabled', async () => {
    const requests = stubFetch([() => new Response(JSON.stringify({ data: [{ id: 'grok-4.5' }] }), { status: 200 })])

    const models = await liveModelRequest(
      { provider: 'xai', apiKey: GROK_OAUTH_TOKEN },
      { liveModelDiscoveryEnabled: false },
    )

    expect(models).toEqual([])
    expect(requests).toHaveLength(0)
  })

  it('rejects an unreasonable cache TTL at plugin load', () => {
    expect(() => Config({ liveModelDiscoveryCacheTtlMs: 0 })).toThrow()
    expect(() => Config({ liveModelDiscoveryCacheTtlMs: -1 })).toThrow()
  })
})

describe('createAsyncCache', () => {
  it('serves the cached value until the TTL elapses, then refreshes', async () => {
    vi.useFakeTimers()
    try {
      const cache = createAsyncCache<number>(1_000)
      const fetcher = vi.fn(async () => 1)

      expect(await cache.get('k', fetcher)).toBe(1)
      expect(await cache.get('k', fetcher)).toBe(1)
      expect(fetcher).toHaveBeenCalledOnce()

      vi.advanceTimersByTime(1_001)
      fetcher.mockResolvedValueOnce(2)
      expect(await cache.get('k', fetcher)).toBe(2)
      expect(fetcher).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the stale value when a refresh reports null', async () => {
    const cache = createAsyncCache<number>(0)

    expect(await cache.get('k', () => Promise.resolve(1))).toBe(1)
    expect(await cache.get('k', () => Promise.resolve(null))).toBe(1)
  })

  it('has no stale value to fall back to before any fetch has succeeded', async () => {
    const cache = createAsyncCache<number>(1_000)

    expect(await cache.get('k', () => Promise.resolve(null))).toBeUndefined()
  })
})
