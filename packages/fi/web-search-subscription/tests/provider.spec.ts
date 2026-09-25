import { describe, expect, it, vi } from 'vitest'
import type { AuthResult } from '@earendil-works/pi-ai'
import {
  SubscriptionSearchProvider,
  type SubscriptionSearchProviderOptions,
} from '../src/provider.ts'

function jwt(payload: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`
}

const oauthTokens = {
  codex: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-fixture' } }),
  grok: jwt({ sub: 'user-fixture' }),
  claude: 'sk-ant-oat01-fixture',
} as const

function responsesSse(searchType = 'web_search_call'): string {
  const events = [
    {
      type: 'response.output_item.done',
      item: { id: 'search-1', type: searchType, status: 'completed', action: { type: 'search', query: 'weather' } },
    },
    {
      type: 'response.output_item.done',
      item: {
        id: 'message-1',
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'The cited weather fact.',
          annotations: [{
            type: 'url_citation',
            url: 'https://weather.example/forecast',
            title: 'Weather source',
            start_index: 4,
            end_index: 9,
          }],
        }],
      },
    },
    { type: 'response.completed', response: { status: 'completed' } },
  ]
  return `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`
}

function claudeResponse(): Record<string, unknown> {
  return {
    content: [
      { type: 'server_tool_use', id: 'search-1', name: 'web_search', input: { query: 'weather' } },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'search-1',
        content: [{
          type: 'web_search_result',
          url: 'https://weather.example/forecast',
          title: 'Weather source',
          encrypted_content: 'opaque-result',
        }],
      },
      {
        type: 'text',
        text: 'The cited weather fact.',
        citations: [{
          type: 'web_search_result_location',
          url: 'https://weather.example/forecast',
          cited_text: 'weather fact',
          encrypted_index: 'opaque-index',
        }],
      },
    ],
    stop_reason: 'end_turn',
    usage: { server_tool_use: { web_search_requests: 1 } },
  }
}

function antigravityResponse(queryCount = 1): Record<string, unknown> {
  return {
    candidates: [{
      content: { role: 'model', parts: [{ text: 'The cited weather fact.' }] },
      finishReason: 'STOP',
      groundingMetadata: {
        webSearchQueries: Array.from({ length: queryCount }, (_, index) => `weather ${index}`),
        searchEntryPoint: { renderedContent: '<div>Search</div>' },
        groundingChunks: [{ web: { uri: 'https://weather.example/forecast', title: 'Weather source' } }],
        groundingSupports: [{
          segment: { startIndex: 4, endIndex: 16, text: 'cited weather' },
          groundingChunkIndices: [0],
        }],
      },
    }],
  }
}

function options(
  provider: SubscriptionSearchProviderOptions['provider'],
  overrides: Partial<SubscriptionSearchProviderOptions> = {},
): SubscriptionSearchProviderOptions {
  const apiKey = provider === 'antigravity' ? undefined : oauthTokens[provider]
  return {
    provider,
    model: provider === 'claude' ? 'claude-haiku-4-5-20251001' : `${provider}-model`,
    timeoutMs: 10_000,
    maxResponseBytes: 64_000,
    maxUses: 2,
    maxOutputTokens: 256,
    resolveOAuth: async () => ({ auth: { apiKey }, source: 'OAuth' }) as AuthResult,
    resolveAntigravityGrant: async () => ({ accessToken: 'antigravity-fixture', projectId: 'project-fixture' }),
    callAntigravity: async () => Response.json(antigravityResponse()),
    sessionId: () => 'session-fixture',
    ...overrides,
  }
}

describe('subscription native request contracts', () => {
  it.each([
    ['codex', 'https://chatgpt.com/backend-api/codex/responses', 'web_search'],
    ['grok', 'https://cli-chat-proxy.grok.com/v1/responses', 'web_search'],
  ] as const)('sends %s to its captured Responses endpoint', async (providerId, endpoint, toolType) => {
    const fetch = vi.fn(async () => new Response(responsesSse(), {
      headers: { 'content-type': 'text/event-stream' },
    }))
    const provider = new SubscriptionSearchProvider(options(providerId, { fetch }))

    await expect(provider.search({ query: 'weather' })).resolves.toMatchObject({
      content: 'The cited weather fact.',
      sources: [{ url: 'https://weather.example/forecast', title: 'Weather source' }],
      truncated: false,
    })

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(endpoint)
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    if (providerId === 'codex') {
      expect(body).toEqual({
        model: 'codex-model',
        instructions: '',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'weather' }] }],
        tools: [{ type: toolType }],
        stream: true,
        store: false,
      })
    } else {
      expect(body).toEqual({
        model: 'grok-model',
        input: [{ role: 'user', content: 'weather' }],
        tools: [{ type: toolType }],
        max_output_tokens: 256,
        stream: true,
        store: false,
      })
    }
  })

  it('sends Claude native web_search with the configured use bound and preserves only cited URLs', async () => {
    const fetch = vi.fn(async () => Response.json(claudeResponse()))
    const provider = new SubscriptionSearchProvider(options('claude', { fetch, maxUses: 1 }))

    await expect(provider.search({ query: 'weather' })).resolves.toMatchObject({
      content: 'The cited weather fact.',
      sources: [{
        url: 'https://weather.example/forecast',
        title: 'Weather source',
        snippet: 'weather fact',
      }],
    })

    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.anthropic.com/v1/messages?beta=true')
    expect(init.redirect).toBe('error')
    const body = JSON.parse(init.body as string) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'weather' }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
    })
  })

  it('delegates Antigravity auth refresh and native Gemini transport without copying token ownership', async () => {
    const resolveAntigravityGrant = vi.fn(async () => ({
      accessToken: 'antigravity-fixture',
      projectId: 'project-fixture',
    }))
    const callAntigravity = vi.fn(async () => Response.json(antigravityResponse()))
    const provider = new SubscriptionSearchProvider(options('antigravity', {
      resolveAntigravityGrant,
      callAntigravity,
    }))

    await expect(provider.search({ query: 'weather' })).resolves.toMatchObject({
      content: 'The cited weather fact.',
      sources: [{
        url: 'https://weather.example/forecast',
        title: 'Weather source',
        snippet: 'cited weather',
      }],
    })
    expect(resolveAntigravityGrant).toHaveBeenCalledTimes(1)
    expect(callAntigravity).toHaveBeenCalledWith(expect.objectContaining({
      action: 'generateContent',
      model: 'antigravity-model',
      account: { token: { accessToken: 'antigravity-fixture', antigravityProjectId: 'project-fixture' } },
      body: {
        contents: [{ role: 'user', parts: [{ text: 'weather' }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { maxOutputTokens: 256 },
      },
    }))
  })

  it.each(['codex', 'grok', 'claude'] as const)('rejects non-OAuth %s auth before dispatch', async (providerId) => {
    const fetch = vi.fn()
    const provider = new SubscriptionSearchProvider(options(providerId, {
      fetch,
      resolveOAuth: async () => ({ auth: { apiKey: 'ambient-api-key' }, source: 'stored credential' }),
    }))

    await expect(provider.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_SUBSCRIPTION_OAUTH_REQUIRED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reads OAuth once and freezes the selected identity for the direct request', async () => {
    const first = oauthTokens.codex
    const second = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'different-account' } })
    const resolveOAuth = vi.fn()
      .mockResolvedValueOnce({ auth: { apiKey: first }, source: 'OAuth' })
      .mockResolvedValueOnce({ auth: { apiKey: second }, source: 'OAuth' })
    const fetch = vi.fn(async () => new Response(responsesSse(), {
      headers: { 'content-type': 'text/event-stream' },
    }))
    const provider = new SubscriptionSearchProvider(options('codex', { resolveOAuth, fetch }))

    await provider.search({ query: 'weather' })

    expect(resolveOAuth).toHaveBeenCalledTimes(1)
    const headers = new Headers((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers)
    expect(headers.get('chatgpt-account-id')).toBe('account-fixture')
    expect(headers.get('authorization')).toBe(`Bearer ${first}`)
  })

  it('honors request.maxResults and marks direct provider truncation', async () => {
    const response = responsesSse().replace(
      'data: [DONE]',
      `data: ${JSON.stringify({
        type: 'response.output_item.done',
        item: {
          id: 'message-2',
          type: 'message',
          content: [{
            type: 'output_text',
            text: '',
            annotations: [{ type: 'url_citation', url: 'https://weather.example/second', title: 'Second' }],
          }],
        },
      })}\n\ndata: [DONE]`,
    )
    const provider = new SubscriptionSearchProvider(options('codex', {
      fetch: async () => new Response(response, { headers: { 'content-type': 'text/event-stream' } }),
    }))

    await expect(provider.search({ query: 'weather', maxResults: 1 })).resolves.toMatchObject({
      sources: [{ url: 'https://weather.example/forecast' }],
      truncated: true,
    })
  })
})

describe('subscription native response safety', () => {
  it('preserves upstream status without returning its unauthenticated body as search content', async () => {
    const provider = new SubscriptionSearchProvider(options('claude', {
      fetch: async () => Response.json({ error: { message: 'rate limited' } }, { status: 429 }),
    }))

    await expect(provider.search({ query: 'weather' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_UPSTREAM_ERROR',
      status: 429,
    })
  })

  it('rejects generated text when the native response has no search evidence', async () => {
    const provider = new SubscriptionSearchProvider(options('claude', {
      fetch: async () => Response.json({
        content: [{ type: 'text', text: 'Unsearched answer', citations: [] }],
        stop_reason: 'end_turn',
        usage: { server_tool_use: { web_search_requests: 0 } },
      }),
    }))

    await expect(provider.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_NO_SEARCH_EVIDENCE' })
  })

  it('rejects search evidence without a native citation URL', async () => {
    const response = claudeResponse()
    response.content = (response.content as Array<Record<string, unknown>>).map(block =>
      block.type === 'text' ? { ...block, citations: [] } : block)
    const provider = new SubscriptionSearchProvider(options('claude', {
      fetch: async () => Response.json(response),
    }))

    await expect(provider.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_NO_CITATIONS' })
  })

  it('rejects a response that exceeds maxResponseBytes while reading its stream', async () => {
    const provider = new SubscriptionSearchProvider(options('claude', {
      maxResponseBytes: 16,
      fetch: async () => Response.json(claudeResponse()),
    }))

    await expect(provider.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_RESPONSE_TOO_LARGE' })
  })

  it('rejects native search actions beyond maxUses where the request protocol has no use knob', async () => {
    const provider = new SubscriptionSearchProvider(options('antigravity', {
      maxUses: 1,
      callAntigravity: async () => Response.json(antigravityResponse(2)),
    }))

    await expect(provider.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_USE_LIMIT_EXCEEDED' })
  })

  it('rejects Responses SSE that closes after evidence but before a completed terminal', async () => {
    const partial = responsesSse().replace(/data: \{"type":"response.completed"[^\n]+\n\ndata: \[DONE\]\n\n$/, '')
    const provider = new SubscriptionSearchProvider(options('codex', {
      fetch: async () => new Response(partial, { headers: { 'content-type': 'text/event-stream' } }),
    }))

    await expect(provider.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_INCOMPLETE_RESPONSE' })
  })

  it('rejects a Responses incomplete terminal', async () => {
    const incomplete = responsesSse().replace(
      /data: \{"type":"response.completed"[^\n]+/,
      `data: ${JSON.stringify({ type: 'response.incomplete', response: { status: 'incomplete' } })}`,
    )
    const provider = new SubscriptionSearchProvider(options('grok', {
      fetch: async () => new Response(incomplete, { headers: { 'content-type': 'text/event-stream' } }),
    }))

    await expect(provider.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_INCOMPLETE_RESPONSE' })
  })

  it('rejects Claude max_tokens termination', async () => {
    const response = claudeResponse()
    response.stop_reason = 'max_tokens'
    const provider = new SubscriptionSearchProvider(options('claude', {
      fetch: async () => Response.json(response),
    }))

    await expect(provider.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_INCOMPLETE_RESPONSE' })
  })

  it('rejects Antigravity MAX_TOKENS termination', async () => {
    const response = antigravityResponse()
    ;(response.candidates as Array<Record<string, unknown>>)[0]!.finishReason = 'MAX_TOKENS'
    const provider = new SubscriptionSearchProvider(options('antigravity', {
      callAntigravity: async () => Response.json(response),
    }))

    await expect(provider.search({ query: 'weather' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_INCOMPLETE_RESPONSE' })
  })

  it('lets caller cancellation win after a complete-looking response arrives before EOF', async () => {
    const controller = new AbortController()
    const complete = JSON.stringify(claudeResponse())
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode(complete))
      },
    })
    const provider = new SubscriptionSearchProvider(options('claude', {
      fetch: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
    }))
    const search = provider.search({ query: 'weather' }, controller.signal)
    await Promise.resolve()

    controller.abort(new Error('caller abort'))

    await expect(search).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('shares one drain across concurrent disposal calls', async () => {
    let release!: (response: Response) => void
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { release = resolve }))
    const provider = new SubscriptionSearchProvider(options('claude', { fetch }))
    const search = provider.search({ query: 'weather' })
    await vi.waitFor(() => { expect(fetch).toHaveBeenCalledOnce() })

    const disposing = provider.dispose()
    expect(provider.dispose()).toBe(disposing)
    release(Response.json(claudeResponse()))

    await expect(search).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    await disposing
  })
})
