import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import WebRuntime from '@deepseek-ai/dsh-web'
import { ExaSearchProvider, EXA_PROVIDER_ID } from '@deepseek-ai/dsh-web-search-exa'
import * as exaPlugin from '@deepseek-ai/dsh-web-search-exa'
import { mapExaResponse, mapExaResult } from '../src/provider.ts'

/** Construct the provider over a fixed options value; production passes a live thunk. */
import type { ExaSearchProviderOptions } from '@deepseek-ai/dsh-web-search-exa'

const searchProvider = (options: ExaSearchProviderOptions): ExaSearchProvider =>
  new ExaSearchProvider(() => options)

const options = { apiKey: 'exa-key', baseURL: 'https://api.exa.test', searchType: 'auto' as const, highlightsPerResult: 1 }

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Exa result mapping', () => {
  it('maps a full result entry', () => {
    expect(mapExaResult({
      url: 'https://a.test',
      title: 'A',
      publishedDate: '2026-01-01',
      highlights: ['salient sentence', 'second'],
    })).toEqual({ url: 'https://a.test', title: 'A', snippet: 'salient sentence', publishedAt: '2026-01-01' })
  })

  it('drops a result with no usable highlight', () => {
    expect(mapExaResult({ url: 'https://a.test', highlights: [] })).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test' })).toBeUndefined()
    expect(mapExaResult({ url: 'https://a.test', highlights: ['  '] })).toBeUndefined()
  })

  it('omits null/empty optional fields rather than emitting them', () => {
    expect(mapExaResult({ url: 'https://a.test', title: null, publishedDate: null, highlights: ['hi'] }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
    expect(mapExaResult({ url: 'https://a.test', title: '', publishedDate: '', highlights: ['hi'] }))
      .toEqual({ url: 'https://a.test', snippet: 'hi' })
  })

  it('maps a response to a result with no content and filtered sources', () => {
    const result = mapExaResponse({
      results: [
        { url: 'https://a.test', highlights: ['one'] },
        { url: 'https://b.test' },
        { url: 'https://c.test', title: 'C', highlights: ['three'] },
      ],
    })
    expect(result).toEqual({
      sources: [
        { url: 'https://a.test', snippet: 'one' },
        { url: 'https://c.test', title: 'C', snippet: 'three' },
      ],
      truncated: false,
    })
    expect(result.content).toBeUndefined()
  })

  it('tolerates a missing results array', () => {
    expect(mapExaResponse({}).sources).toEqual([])
  })

})

describe('ExaSearchProvider availability', () => {
  it('is unavailable without a key', () => {
    expect(searchProvider({ ...options, apiKey: '' }).available()).toBe(false)
  })

  it('is available with a key', () => {
    expect(searchProvider(options).available()).toBe(true)
  })

  it('is misconfigured when the base URL is unparseable', () => {
    expect(searchProvider({ ...options, baseURL: 'not a url' }).available()).toBe(false)
  })

  it('is misconfigured when highlightsPerResult is not a positive integer', () => {
    expect(searchProvider({ ...options, highlightsPerResult: 0 }).available()).toBe(false)
    expect(searchProvider({ ...options, highlightsPerResult: 1.5 }).available()).toBe(false)
  })

  it('is misconfigured when numResults is set but not a positive integer', () => {
    expect(searchProvider({ ...options, numResults: -1 }).available()).toBe(false)
  })
})

describe('ExaSearchProvider request mapping', () => {
  it('sends query, type, highlights, numResults and bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [{ url: 'https://a.test', highlights: ['hi'] }] }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = searchProvider({ ...options, searchType: 'neural', highlightsPerResult: 3 })
    await provider.search({ query: 'hello', maxResults: 5 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.exa.test/search')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer exa-key')
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'hello',
      type: 'neural',
      contents: { highlights: { highlightsPerUrl: 3 } },
      numResults: 5,
    })
  })

  it('falls back to the configured numResults when a request omits maxResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, numResults: 7 }).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ numResults: 7 })
  })

  it('lets a request maxResults win over the configured numResults', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider({ ...options, numResults: 7 }).search({ query: 'q', maxResults: 2 })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ numResults: 2 })
  })

  it('omits numResults when neither maxResults nor a configured default is set', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await searchProvider(options).search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).not.toHaveProperty('numResults')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await searchProvider(options).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })
})

describe('ExaSearchProvider settings changes mid-search', () => {
  it('serves one search from one section even when settings land during credential resolution', async () => {
    // The section the search starts on, and the one a user commits while the
    // credential is still resolving.
    const before = { ...options, apiKey: '', baseURL: 'https://before.test', highlightsPerResult: 2 }
    const after = { ...options, apiKey: '', baseURL: 'https://after.test', highlightsPerResult: 9 }
    let current = before
    let commitSettings = () => {}
    const resolveApiKey = () => new Promise<string>((resolve) => {
      commitSettings = () => { current = after; resolve('key-from-before') }
    })
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const provider = new ExaSearchProvider(() => ({ ...current, resolveApiKey }))
    const search = provider.search({ query: 'q' })
    await vi.waitFor(() => { expect(typeof commitSettings).toBe('function') })
    commitSettings()
    await search

    const [endpoint, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }]
    // The key resolved from `before` must never reach `after`'s origin.
    expect(endpoint).toBe('https://before.test/search')
    expect(init.headers['authorization']).toBe('Bearer key-from-before')
    expect(JSON.parse(init.body)).toMatchObject({ contents: { highlights: { highlightsPerUrl: 2 } } })
  })
})

describe('ExaSearchProvider error handling', () => {
  it('does not start credential resolution or dispatch for a pre-aborted call', async () => {
    const resolveApiKey = vi.fn(async () => 'late-key')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(searchProvider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts while an uncooperative credential resolver remains pending', async () => {
    const resolveApiKey = vi.fn(() => new Promise<string>(() => {}))
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const search = searchProvider({ ...options, apiKey: '', resolveApiKey }).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('deadline'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(resolveApiKey).toHaveBeenCalledOnce()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resolves credentials under an active cancellation signal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await expect(searchProvider({ ...options, apiKey: '', resolveApiKey: async () => 'resolved-key' })
      .search({ query: 'q' }, controller.signal)).resolves.toMatchObject({ truncated: false })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer resolved-key')
  })

  it('maps a credential resolver rejection under an active signal to WEB_PROVIDER_ERROR', async () => {
    const controller = new AbortController()
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({
        code: 'WEB_PROVIDER_ERROR',
        message: 'Exa search credential resolution failed: Error: credential backend failed',
      }))
  })

  it('uses the default credential reference when no resolver is configured', async () => {
    await expect(searchProvider({ ...options, apiKey: '' }).search({ query: 'q' }))
      .rejects.toThrow('Exa search has no API key for "EXA_API_KEY"')
  })

  it('observes cancellation triggered synchronously by credential resolution', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(searchProvider({
      ...options,
      apiKey: '',
      resolveApiKey: () => {
        controller.abort(new Error('resolver cancelled caller'))
        return Promise.resolve('unused-key')
      },
    }).search({ query: 'q' }, controller.signal))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps a custom abort reason to WEB_ABORTED', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => { reject(new Error('custom abort reason')) }, { once: true })
      })))
    const search = searchProvider(options).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('timeout reason'))
    await expect(search).rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an HTTP error to WEB_PROVIDER_ERROR with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'bad key' }, { status: 401 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'bad key' }))
  })

  it('keeps a status-line message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway down', { status: 502 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR', message: 'Exa API error (HTTP 502)' }))
  })

  it('keeps the status-line message when the JSON error body carries no detail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, { status: 500 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'Exa API error (HTTP 500)' }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('connection refused'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps an abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('maps an unparseable success body to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a well-formed body of the wrong shape to WEB_PROVIDER_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: {} }, { status: 200 })))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('surfaces an abort during success-body parse as WEB_ABORTED, not provider error', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: true, status: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })

  it('surfaces an abort during error-body parse as WEB_ABORTED', async () => {
    const body = { json: () => Promise.reject(new DOMException('aborted', 'AbortError')), ok: false, status: 500 }
    vi.stubGlobal('fetch', vi.fn(async () => body as unknown as Response))
    await expect(searchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_ABORTED' }))
  })
})

describe('web-search-exa plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ results: [] })))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    const fiber = await ctx.plugin(exaPlugin, { apiKey: 'exa-key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({ sources: [], truncated: false })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in exaPlugin).toBe(false)
  })

  it('threads searchType, highlightsPerResult and numResults config into the request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
    const fiber = await ctx.plugin(exaPlugin, { apiKey: 'exa-key', searchType: 'keyword', highlightsPerResult: 2, numResults: 9 })
    await ctx.web.search({ query: 'q' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchObject({ type: 'keyword', contents: { highlights: { highlightsPerUrl: 2 } }, numResults: 9 })
    await fiber.dispose()
  })

  it('falls back to $EXA_API_KEY and the default base URL when config omits them', async () => {
    const prev = process.env.EXA_API_KEY
    process.env.EXA_API_KEY = 'env-key'
    try {
      const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
      vi.stubGlobal('fetch', fetchMock)
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      const fiber = await ctx.plugin(exaPlugin, {})
      await ctx.web.search({ query: 'q' })
      const [url] = fetchMock.mock.calls[0] as unknown as [string]
      expect(url).toBe('https://api.exa.ai/search')
      await fiber.dispose()
    } finally {
      if (prev === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = prev
    }
  })

  it('reports an actionable credential error when neither config nor env supplies a key', async () => {
    const prev = process.env.EXA_API_KEY
    delete process.env.EXA_API_KEY
    try {
      const ctx = new Context()
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      await ctx.plugin(exaPlugin, {})
      let caught: unknown
      try {
        await ctx.web.search({ query: 'q' })
      } catch (error: unknown) {
        caught = error
      }
      expect(caught).toMatchObject({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' })
      if (!(caught instanceof Error)) throw new Error('search did not throw an Error')
      expect(caught.message).toMatch(/store it through the credentials service.*Models page/s)
    } finally {
      if (prev !== undefined) process.env.EXA_API_KEY = prev
    }
  })

  it('resolves the credential for each search so a stored or rotated key needs no restart', async () => {
    const previous = process.env.EXA_API_KEY
    delete process.env.EXA_API_KEY
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web-search-credentials-'))
    const fetchMock = vi.fn(async () => jsonResponse({ results: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    try {
      await ctx.plugin(WebRuntime, { searchProvider: EXA_PROVIDER_ID })
      await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
      await ctx.plugin(exaPlugin, { baseURL: 'https://api.exa.test' })

      await expect(ctx.web.search({ query: 'missing' }))
        .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))

      const ref = credentialRef('EXA_API_KEY')
      await ctx.credentials.set(ref, 'stored-key')
      await ctx.web.search({ query: 'stored' })
      await ctx.credentials.set(ref, 'rotated-key')
      await ctx.web.search({ query: 'rotated' })

      const headers = (fetchMock.mock.calls as unknown as [string, RequestInit][])
        .map(([, init]) => init.headers as Record<string, string>)
      expect(headers.map(value => value['authorization'])).toEqual(['Bearer stored-key', 'Bearer rotated-key'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
      if (previous === undefined) delete process.env.EXA_API_KEY
      else process.env.EXA_API_KEY = previous
    }
  })
})
