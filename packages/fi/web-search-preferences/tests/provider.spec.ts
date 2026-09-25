import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WebSearchProvider, WebSearchResult } from '@deepseek-ai/dsh-web'
import {
  createFiDirectSearchProvider,
  FI_PREFERRED_SEARCH_PROVIDER_ID,
  PreferredSearchProvider,
  resolveSelectedProvider,
  type Config,
} from '../src/index.ts'

function result(content: string): WebSearchResult {
  return { content, sources: [], truncated: false }
}

function provider(id: string, search: WebSearchProvider['search']): WebSearchProvider {
  return { id, available: () => true, search }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('preferred search provider', () => {
  function credentialContext(ref: string, value: string): Context {
    return {
      get: (service: string) => service === 'credentials'
        ? { resolve: vi.fn(async (candidate: string) => candidate === ref ? { value } : undefined) }
        : undefined,
    } as unknown as Context
  }

  it('maps Parallel Search API results through the provider-neutral web seam', async () => {
    const fetch = vi.fn(async () => Response.json({
      search_id: 'search-1',
      session_id: 'session-1',
      results: [{
        url: 'https://source.test/parallel',
        title: 'Parallel source',
        publish_date: '2026-09-13',
        excerpts: ['Parallel excerpt'],
      }],
    }))
    vi.stubGlobal('fetch', fetch)
    const selected = await resolveSelectedProvider(
      credentialContext('PARALLEL_API_KEY', 'parallel-secret'),
      { provider: 'parallel', parallelBaseURL: 'https://parallel.test' },
      new AbortController().signal,
    )

    await expect(selected.search({ query: 'current facts', maxResults: 3 })).resolves.toEqual({
      sources: [{
        url: 'https://source.test/parallel',
        title: 'Parallel source',
        snippet: 'Parallel excerpt',
        publishedAt: '2026-09-13',
      }],
      truncated: false,
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(url).toBe('https://parallel.test/v1/search')
    expect(headers['x-api-key']).toBe('parallel-secret')
    expect(JSON.parse(init.body as string)).toEqual({
      objective: 'current facts',
      search_queries: ['current facts'],
    })
  })

  it('maps Tavily Search API results and forwards the per-request result limit', async () => {
    const fetch = vi.fn(async () => Response.json({
      results: [{
        url: 'https://source.test/tavily',
        title: 'Tavily source',
        content: 'Tavily excerpt',
        published_date: '2026-09-12',
      }],
    }))
    vi.stubGlobal('fetch', fetch)
    const selected = await resolveSelectedProvider(
      credentialContext('TAVILY_API_KEY', 'tavily-secret'),
      { provider: 'tavily', tavilyBaseURL: 'https://tavily.test' },
      new AbortController().signal,
    )

    await expect(selected.search({ query: 'current facts', maxResults: 4 })).resolves.toMatchObject({
      sources: [{ url: 'https://source.test/tavily', snippet: 'Tavily excerpt' }],
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(url).toBe('https://tavily.test/search')
    expect(headers.authorization).toBe('Bearer tavily-secret')
    expect(JSON.parse(init.body as string)).toEqual({ query: 'current facts', max_results: 4 })
  })

  it('maps Serper organic results and sends its configured key header', async () => {
    const fetch = vi.fn(async () => Response.json({
      organic: [{
        link: 'https://source.test/serper',
        title: 'Serper source',
        snippet: 'Serper excerpt',
        date: 'Sep 13, 2026',
      }],
    }))
    vi.stubGlobal('fetch', fetch)
    const selected = await resolveSelectedProvider(
      credentialContext('SERPER_API_KEY', 'serper-secret'),
      { provider: 'serper', serperBaseURL: 'https://serper.test' },
      new AbortController().signal,
    )

    await expect(selected.search({ query: 'current facts', maxResults: 5 })).resolves.toMatchObject({
      sources: [{ url: 'https://source.test/serper', snippet: 'Serper excerpt' }],
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(url).toBe('https://serper.test/search')
    expect(headers['x-api-key']).toBe('serper-secret')
    expect(JSON.parse(init.body as string)).toEqual({ q: 'current facts', num: 5 })
  })

  it('maps Brave web results and sends its subscription token without redirects', async () => {
    const fetch = vi.fn(async () => Response.json({
      web: { results: [{
        url: 'https://source.test/brave',
        title: 'Brave source',
        description: 'Brave excerpt',
        page_age: '2026-09-11',
      }] },
    }))
    vi.stubGlobal('fetch', fetch)
    const selected = await resolveSelectedProvider(
      credentialContext('BRAVE_SEARCH_API_KEY', 'brave-secret'),
      { provider: 'brave', braveBaseURL: 'https://brave.test/res' },
      new AbortController().signal,
    )

    await expect(selected.search({ query: 'current facts', maxResults: 6 })).resolves.toMatchObject({
      sources: [{ url: 'https://source.test/brave', snippet: 'Brave excerpt' }],
    })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(url).toBe('https://brave.test/res/v1/web/search?q=current+facts&count=6')
    expect(headers['x-subscription-token']).toBe('brave-secret')
    expect(init.redirect).toBe('error')
  })

  it('keeps DeepSeek request logging before dispatch while delegating to its provider', async () => {
    const append = vi.fn()
    const credentials = { resolve: vi.fn(async () => ({ value: 'ds-key' })) }
    const ctx = {
      get: (service: string) => {
        if (service === 'credentials') return credentials
        if (service === 'agents') return {
          currentInitiator: () => ({ session: { append } }),
        }
        return undefined
      },
    } as unknown as Context
    const fetch = vi.fn(async () => Response.json({
      content: [
        { type: 'text', text: 'found' },
        {
          type: 'web_search_tool_result',
          content: [{ type: 'web_search_result', url: 'https://source.test', title: 'Source' }],
        },
      ],
    }))
    vi.stubGlobal('fetch', fetch)

    const selected = await resolveSelectedProvider(ctx, {
      provider: 'deepseek-official',
      baseURL: 'https://deepseek.test/anthropic/v1',
    }, new AbortController().signal)

    await expect(selected.search({ query: 'current facts' })).resolves.toEqual({
      sources: [{ url: 'https://source.test', title: 'Source' }],
      truncated: false,
    })
    expect(append).toHaveBeenCalledWith(
      'web/deepseek-search-llm-request',
      expect.objectContaining({ endpoint: 'https://deepseek.test/anthropic/v1/messages' }),
    )
    expect(append.mock.invocationCallOrder[0]).toBeLessThan(
      fetch.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    )
  })

  it('preserves upstream DeepSeek field names and literal-key precedence', async () => {
    const resolve = vi.fn(async () => { throw new Error('credential lookup must not run') })
    const append = vi.fn()
    const ctx = {
      get: (service: string) => {
        if (service === 'credentials') return { resolve }
        if (service === 'agents') return { currentInitiator: () => ({ session: { append } }) }
        return undefined
      },
    } as unknown as Context
    const fetch = vi.fn(async () => Response.json({
      content: [{
        type: 'web_search_tool_result',
        content: [{ type: 'web_search_result', url: 'https://source.test', title: 'Source' }],
      }],
    }))
    vi.stubGlobal('fetch', fetch)

    const selected = await resolveSelectedProvider(ctx, {
      provider: 'deepseek-official',
      apiKey: 'legacy-literal',
      apiKeyEnv: 'LEGACY_DEEPSEEK_KEY',
      baseURL: 'https://legacy.test/anthropic/v1',
      model: 'legacy-model',
      apiVersion: 'legacy-version',
      maxTokens: 321,
      maxUses: 2,
    }, new AbortController().signal)
    await selected.search({ query: 'legacy settings' })

    expect(resolve).not.toHaveBeenCalled()
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(url).toBe('https://legacy.test/anthropic/v1/messages')
    expect(headers['x-api-key']).toBe('legacy-literal')
    expect(headers['anthropic-version']).toBe('legacy-version')
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'legacy-model', max_tokens: 321 })
    expect(JSON.stringify(append.mock.calls)).not.toContain('legacy-literal')
  })

  it('rejects malformed direct-provider responses at the HTTP boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ results: [{ title: 'missing URL' }] })))
    const selected = await resolveSelectedProvider(
      credentialContext('TAVILY_API_KEY', 'tavily-secret'),
      { provider: 'tavily', tavilyBaseURL: 'https://tavily.test' },
      new AbortController().signal,
    )

    await expect(selected.search({ query: 'invalid result' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
    })
  })

  it('maps a fetch rejection caused by a non-DOM abort reason to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      signal.addEventListener('abort', () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
      }, { once: true })
    })))
    const selected = await resolveSelectedProvider(
      credentialContext('TAVILY_API_KEY', 'tavily-secret'),
      { provider: 'tavily', tavilyBaseURL: 'https://tavily.test' },
      new AbortController().signal,
    )
    const controller = new AbortController()
    const operation = selected.search({ query: 'cancel' }, controller.signal)
    controller.abort(new Error('plugin disposed'))

    await expect(operation).rejects.toMatchObject({ code: 'WEB_ABORTED' })
  })

  it('refuses a cleartext custom endpoint before sending its credential', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const selected = createFiDirectSearchProvider({
      provider: 'tavily',
      apiKey: 'tavily-secret',
      baseURL: 'http://tavily.test',
    })

    await expect(selected.search({ query: 'unsafe' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['deepseek-official', { baseURL: 'http://deepseek.test' }],
    ['exa', { exaBaseURL: 'http://exa.test' }],
    ['perplexity', { perplexityBaseURL: 'http://perplexity.test' }],
    ['parallel', { parallelBaseURL: 'http://parallel.test' }],
    ['tavily', { tavilyBaseURL: 'http://tavily.test' }],
    ['serper', { serperBaseURL: 'http://serper.test' }],
    ['brave', { braveBaseURL: 'http://brave.test' }],
  ] as const)('refuses a cleartext %s endpoint before resolving its credential', async (providerId, options) => {
    const resolve = vi.fn(async () => ({ value: 'secret' }))
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const ctx = {
      get: (service: string) => service === 'credentials' ? { resolve } : undefined,
    } as unknown as Context

    await expect(resolveSelectedProvider(
      ctx,
      { provider: providerId, ...options },
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' })
    expect(resolve).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not surface an endpoint error body that could echo a credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: 'tavily-secret' },
      { status: 401 },
    )))
    const selected = createFiDirectSearchProvider({
      provider: 'tavily',
      apiKey: 'tavily-secret',
      baseURL: 'https://tavily.test',
    })

    const error = await selected.search({ query: 'safe failure' }).catch((cause: unknown) => cause)
    expect(error).toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(String(error)).toContain('Tavily API error (HTTP 401)')
    expect(String(error)).not.toContain('tavily-secret')
  })

  it('cancels a failed endpoint response body before reporting the status', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 503 })))
    const selected = createFiDirectSearchProvider({
      provider: 'tavily',
      apiKey: 'tavily-secret',
      baseURL: 'https://tavily.test',
    })

    await expect(selected.search({ query: 'safe failure' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('snapshots preference once per call and keeps the upstream provider id', async () => {
    let config = { provider: 'exa' } as Config
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    const exa = provider('exa', vi.fn(async () => {
      await held
      return result('exa')
    }))
    const perplexity = provider('perplexity', vi.fn(async () => result('perplexity')))
    const resolveProvider = vi.fn(async (snapshot: Config) => snapshot.provider === 'exa' ? exa : perplexity)
    const preferred = new PreferredSearchProvider({
      resolveConfig: () => config,
      resolveProvider,
    })

    const first = preferred.search({ query: 'first' })
    config = { provider: 'perplexity' }
    release()

    await expect(first).resolves.toEqual(result('exa'))
    await expect(preferred.search({ query: 'second' })).resolves.toEqual(result('perplexity'))
    expect(preferred.id).toBe(FI_PREFERRED_SEARCH_PROVIDER_ID)
    expect(resolveProvider.mock.calls.map(([snapshot]) => snapshot.provider))
      .toEqual(['exa', 'perplexity'])
  })

  it('propagates selected-provider failure without fallback', async () => {
    const failure = new Error('selected provider unavailable')
    const resolveProvider = vi.fn(async () => { throw failure })
    const preferred = new PreferredSearchProvider({
      resolveConfig: () => ({ provider: 'exa' }),
      resolveProvider,
    })

    await expect(preferred.search({ query: 'no fallback' })).rejects.toBe(failure)
    expect(resolveProvider).toHaveBeenCalledOnce()
  })

  it('combines caller cancellation with the operation signal', async () => {
    const caller = new AbortController()
    const search = vi.fn(async (_request, signal?: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(signal.reason instanceof Error ? signal.reason : new Error('search aborted'))
        }, { once: true })
      })
      return result('unreachable')
    })
    const preferred = new PreferredSearchProvider({
      resolveConfig: () => ({ provider: 'exa' }),
      resolveProvider: async () => provider('exa', search),
    })

    const operation = preferred.search({ query: 'cancel' }, caller.signal)
    await vi.waitFor(() => { expect(search).toHaveBeenCalledOnce() })
    const reason = new Error('caller cancelled')
    caller.abort(reason)

    await expect(operation).rejects.toBe(reason)
    expect(search).toHaveBeenCalledOnce()
  })

  it('aborts and awaits in-flight work during disposal', async () => {
    let observedAbort = false
    let releaseCleanup!: () => void
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const dispose = vi.fn(async () => { await cleanup })
    const search = vi.fn(async (_request, signal?: AbortSignal) => {
      await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          observedAbort = true
          reject(signal.reason instanceof Error ? signal.reason : new Error('search aborted'))
        }, { once: true })
      })
      return result('unreachable')
    })
    const preferred = new PreferredSearchProvider({
      resolveConfig: () => ({ provider: 'exa' }),
      resolveProvider: async () => ({ ...provider('exa', search), dispose }),
    })

    const operation = preferred.search({ query: 'dispose' })
    await vi.waitFor(() => { expect(search).toHaveBeenCalledOnce() })
    const disposing = preferred.dispose()
    expect(preferred.dispose()).toBe(disposing)
    await vi.waitFor(() => { expect(observedAbort).toBe(true) })
    let disposalFinished = false
    void disposing.then(() => { disposalFinished = true })
    await Promise.resolve()
    expect(disposalFinished).toBe(false)
    releaseCleanup()

    await expect(operation).rejects.toThrow('preferred search provider disposed')
    await disposing
    expect(dispose).toHaveBeenCalledOnce()
  })
})
