/** Keyless RSS search normalization, bounded reads, and cancellation. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BingRssSearchProvider } from '../src/bing-provider.ts'

const xml = '<rss><channel><item><title>Types &amp; tools</title><link>https://source.test/one</link><description>你好</description><pubDate>Unreliable date</pubDate></item><item><link>https://source.test/two</link></item></channel></rss>'
const provider = (maxBytes = 4096) => new BingRssSearchProvider('https://bing.test', maxBytes)
afterEach(() => { vi.unstubAllGlobals() })

describe('Bing RSS search', () => {
  it('normalizes RSS text and limits sources without a credential', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(xml))
    vi.stubGlobal('fetch', fetch)
    expect(provider().available()).toBe(true)
    await expect(provider().search({ query: 'types & tools', maxResults: 1 })).resolves.toEqual({
      sources: [{ url: 'https://source.test/one', title: 'Types & tools', snippet: '你好' }], truncated: true,
    })
    const request = new Request(...fetch.mock.calls[0]!)
    expect(request.url).toBe('https://bing.test/search?q=types+%26+tools&format=rss')
    expect(request.headers.has('authorization')).toBe(false)
    expect(request.redirect).toBe('error')
  })

  it('accepts an empty channel and a single source', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('<rss><channel><title>Empty</title></channel></rss>'))
      .mockResolvedValueOnce(new Response('<rss><channel><item><link>https://source.test</link></item></channel></rss>'))
    vi.stubGlobal('fetch', fetch)
    await expect(provider().search({ query: 'empty' })).resolves.toEqual({ sources: [], truncated: false })
    await expect(provider().search({ query: 'one' })).resolves.toEqual({ sources: [{ url: 'https://source.test' }], truncated: false })
  })

  it.each([
    '<html>challenge</html>', '<rss><channel>',
    '<!DOCTYPE rss [<!ENTITY x "secret">]><rss><channel/></rss>',
    '<rss><channel><item><link>javascript:alert(1)</link></item></channel></rss>',
    '<rss><channel><item><link>https://source.test</link><title><nested>Title</nested></title></item></channel></rss>',
  ])('rejects malformed or unsafe RSS: %s', async (body) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await expect(provider().search({ query: 'invalid' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('cancels failed responses and reports HTTP status without the body', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { status: 429 })))
    await expect(provider().search({ query: 'rate limit' })).rejects.toThrow('Bing RSS search failed with HTTP 429')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('rejects advertised oversized bodies before reading', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '20' } })))
    await expect(provider(10).search({ query: 'bounded' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_RESPONSE_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('counts streamed UTF-8 bytes and preserves the limit error if cleanup fails', async () => {
    const bytes = new TextEncoder().encode(xml)
    const cancel = vi.fn(async () => { throw new Error('cleanup failed') })
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes) }, cancel,
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await expect(provider(bytes.length - 1).search({ query: 'bounded' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_RESPONSE_TOO_LARGE' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('decodes split UTF-8 chunks at the exact byte limit', async () => {
    const bytes = new TextEncoder().encode(xml)
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte))
      controller.close()
    } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)))
    await expect(provider(bytes.length).search({ query: 'exact' })).resolves.toMatchObject({ sources: [{ snippet: '你好' }, {}] })
  })

  it('cancels a pending body read when the caller aborts', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const response = new Response(body)
    vi.stubGlobal('fetch', vi.fn(async () => response))
    const controller = new AbortController()
    const operation = provider().search({ query: 'cancel' }, controller.signal)
    await vi.waitFor(() => { expect(body.locked).toBe(true) })
    controller.abort(new Error('caller cancelled'))
    await expect(operation).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(cancel).toHaveBeenCalledOnce()
    expect(body.locked).toBe(false)
  })

  it('rejects a pre-aborted request before dispatch and maps network errors', async () => {
    const fetch = vi.fn(async () => { throw new Error('offline') })
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    controller.abort()
    await expect(provider().search({ query: 'cancel' }, controller.signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetch).not.toHaveBeenCalled()
    await expect(provider().search({ query: 'offline' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })
})
