/** Settings discovery uses the draft endpoint and preserves advertised model metadata. */
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { afterEach, expect, it, vi } from 'vitest'
import * as ApiKey from '../src/index.ts'
import { discoverDeepSeekModels } from '../src/discovery.ts'

const limits = { timeoutMs: 10000, maxBytes: 4096 }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

it('fetches live candidates with a draft key, deduplicates IDs, and withdraws discovery on disposal', async () => {
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ data: [
    { id: 'fresh', name: 'Fresh', context_window: 1000000, max_output_tokens: 64000, input_modalities: ['text', 'image'] },
    { id: 'fresh' },
  ] })))
  vi.stubGlobal('fetch', fetcher)
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    const fiber = await ctx.plugin(ApiKey, { enabled: false })
    const result = await ctx.llm.discoverModels(ApiKey.name, {
      provider: 'deepseek-official', baseURL: 'https://gateway.example/prefix/anthropic/v1/', apiKey: 'draft-key',
    })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://gateway.example/prefix/models'))
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
      headers: { Authorization: 'Bearer draft-key' }, redirect: 'error',
    }))
    expect(result).toEqual([{ id: 'fresh', name: 'Fresh', contextWindow: 1000000, maxTokens: 64000, inputModalities: ['text', 'image'] }])
    await fiber.dispose()
    await expect(ctx.llm.discoverModels(ApiKey.name, { provider: 'deepseek-official' })).rejects.toMatchObject({ code: 'NO_DISCOVERY' })
  } finally { await ctx.fiber.dispose() }
})

it('uses the stored credential and configured endpoint when the draft omits them', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'stored-key')
  const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ data: [{ id: 'stored' }] })))
  vi.stubGlobal('fetch', fetcher)
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(ApiKey, { baseURL: 'https://private.example/anthropic' })
    expect(await ctx.llm.discoverModels(ApiKey.name, { provider: 'deepseek-official' })).toEqual([{ id: 'stored' }])
    expect(fetcher).toHaveBeenCalledWith(new URL('https://private.example/models'), expect.objectContaining({ headers: { Authorization: 'Bearer stored-key' } }))
  } finally { await ctx.fiber.dispose() }
})

it.each([
  { data: [{ id: '' }] },
  { data: [{ id: 'bad', context_window: -1 }] },
  { data: [{ id: 'bad', input_modalities: ['invalid'] }] },
  { data: [{ id: 'bad', input_modalities: [] }] },
  { data: [{ id: 'bad', name: 42 }] },
  { data: [], has_more: true },
  { models: [] },
])('rejects malformed or incomplete directories: %j', async (body) => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json(body))))
  await expect(discoverDeepSeekModels('https://api.deepseek.com/anthropic', 'key', limits)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
})

it.each(['ftp://api.deepseek.com', 'https://user:key@api.deepseek.com', 'https://api.deepseek.com?key=x', 'https://api.deepseek.com#fragment'])('rejects unsafe directory URL %s', async (url) => {
  await expect(discoverDeepSeekModels(url, 'key', limits)).rejects.toMatchObject({ code: 'INVALID_DISCOVERY' })
})

it.each([200, 401])('rejects an empty HTTP %s response', async (status) => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status }))))
  await expect(discoverDeepSeekModels('https://api.deepseek.com', 'key', limits)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
})

it('reports authentication failures without echoing the response body', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('private detail', { status: 401 }))))
  await expect(discoverDeepSeekModels('https://api.deepseek.com/anthropic', 'key', limits)).rejects.toThrow('DeepSeek model discovery failed (HTTP 401)')
})

it('bounds the actual directory bytes', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({ data: [{ id: 'long-directory-entry' }] }))))
  await expect(discoverDeepSeekModels('https://api.deepseek.com/anthropic', 'key', { ...limits, maxBytes: 8 })).rejects.toThrow('modelDiscoveryMaxBytes')
})

it('accepts the exact UTF-8 byte limit and rejects one byte less', async () => {
  const body = JSON.stringify({ data: [{ id: 'model', name: '模型' }] })
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(body))))
  const bytes = Buffer.byteLength(body)
  expect(await discoverDeepSeekModels('https://api.deepseek.com', 'key', { ...limits, maxBytes: bytes }))
    .toEqual([{ id: 'model', name: '模型' }])
  await expect(discoverDeepSeekModels('https://api.deepseek.com', 'key', { ...limits, maxBytes: bytes - 1 }))
    .rejects.toThrow('modelDiscoveryMaxBytes')
})

it('does not expose malformed response text', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('private invalid json'))))
  await expect(discoverDeepSeekModels('https://api.deepseek.com', 'key', limits))
    .rejects.toThrow('DeepSeek returned an invalid model directory')
})

it('passes caller cancellation to the request', async () => {
  const abort = new AbortController()
  abort.abort()
  const fetcher = vi.fn((_url: URL, options: RequestInit) => {
    options.signal?.throwIfAborted()
    return Promise.resolve(Response.json({ data: [] }))
  })
  vi.stubGlobal('fetch', fetcher)
  await expect(discoverDeepSeekModels('https://api.deepseek.com', 'key', limits, abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
