/** Direct providers validate response JSON and retain request cancellation. */
import { afterEach, expect, it, vi } from 'vitest'
import { createFiDirectSearchProvider, type FiDirectSearchProviderId } from '../src/direct-provider.ts'

const provider = (id: FiDirectSearchProviderId = 'parallel') => createFiDirectSearchProvider({
  provider: id, baseURL: 'https://search.test', apiKey: 'fixture', parallelMode: 'fast',
})
afterEach(() => { vi.unstubAllGlobals() })

it.each(['offline', 'abort', 'other-dom'] as const)('classifies a %s request failure', async (kind) => {
  const error = kind === 'offline' ? new Error('offline') : new DOMException('failure', kind === 'abort' ? 'AbortError' : 'NetworkError')
  vi.stubGlobal('fetch', vi.fn(async () => { throw error }))
  await expect(provider().search({ query: 'query' })).rejects.toMatchObject({ code: kind === 'abort' ? 'WEB_ABORTED' : 'WEB_PROVIDER_ERROR' })
})

it('honors cancellation after fetch resolves', async () => {
  const controller = new AbortController()
  vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(new Error('cancelled')); return Response.json({ results: [] }) }))
  await expect(provider().search({ query: 'query' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
})

it.each([false, true])('classifies response-read cancellation with caller signal=%s', async (withSignal) => {
  const controller = new AbortController()
  const response = new Response(new ReadableStream({ start(stream) {
    stream.error(new DOMException('cancelled', 'AbortError'))
  } }))
  if (withSignal) {
    vi.spyOn(response, 'json').mockImplementation(async () => {
      controller.abort(new Error('cancelled'))
      throw new Error('body cancelled')
    })
  }
  vi.stubGlobal('fetch', vi.fn(async () => response))
  await expect(provider().search({ query: 'query' }, withSignal ? controller.signal : undefined))
    .rejects.toMatchObject({ code: 'WEB_ABORTED' })
})

it('preserves HTTP failure if body cancellation rejects', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
    cancel() { throw new Error('cancel failed') },
  }), { status: 503 })))
  await expect(provider().search({ query: 'query' })).rejects.toThrow('HTTP 503')
})

it.each([null, [], { results: null }, { results: [null] }, { results: [{ url: '' }] },
  { results: [{ url: 'file:///secret' }] }, { results: [{ url: 'https://source.test', title: 1 }] },
  { results: [{ url: 'https://source.test', excerpts: [1] }] },
])('refuses malformed source data %j', async (body) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
  await expect(provider().search({ query: 'query' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
})

it.each(['parallel', 'tavily', 'serper', 'brave'] as const)('accepts optional %s result metadata and omits an absent request limit', async (id) => {
  const source = { url: 'https://source.test', link: 'https://source.test', title: '', excerpts: null, description: null, content: null }
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
    results: [source], organic: [source], web: { results: [source] },
  }))
  vi.stubGlobal('fetch', fetch)
  await expect(provider(id).search({ query: 'query' })).resolves.toEqual({ sources: [{ url: 'https://source.test' }], truncated: false })
  if (id === 'parallel') {
    const body = fetch.mock.calls[0]?.[1]?.body
    expect(typeof body).toBe('string')
    if (typeof body !== 'string') throw new Error('Expected JSON request body')
    expect(JSON.parse(body)).toMatchObject({ mode: 'fast' })
  }
})

it.each(['serper', 'brave'] as const)('accepts an empty %s result container', async (id) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
  await expect(provider(id).search({ query: 'query' })).resolves.toEqual({ sources: [], truncated: false })
})

it('reports malformed configured endpoints as unavailable', async () => {
  const selected = createFiDirectSearchProvider({ provider: 'parallel', baseURL: 'not a URL', apiKey: 'fixture' })
  expect(selected.available()).toBe(false)
  await expect(selected.search({ query: 'query' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' })
})

it('forwards cancellation to Brave requests', async () => {
  const signal = new AbortController().signal
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({}))
  vi.stubGlobal('fetch', fetch)
  await provider('brave').search({ query: 'query' }, signal)
  expect(fetch.mock.calls[0]?.[1]?.signal).toBe(signal)
})
