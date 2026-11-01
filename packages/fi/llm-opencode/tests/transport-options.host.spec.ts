/** SDK dispatch cannot widen the endpoint authorized by the authenticated catalog. */
import { afterEach, expect, it, vi } from 'vitest'
import type { SimpleStreamOptions } from '@earendil-works/pi-ai'
import { OpenCodeAdapter } from '../src/adapter.ts'
import type { ConsoleOptions } from '../src/protocol.ts'

const captured = vi.hoisted(() => ({ options: undefined as SimpleStreamOptions | undefined }))
vi.mock('@deepseek-ai/dsh-llm-pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-llm-pi-ai')>()
  return { ...actual, createModels: (...args: Parameters<typeof actual.createModels>) => {
    const models = actual.createModels(...args)
    vi.spyOn(models, 'streamSimple').mockImplementation((_model, _context, options) => {
      captured.options = options
      throw new Error('SDK options captured')
    })
    return models
  } }
})

afterEach(() => { captured.options = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals() })

const config: ConsoleOptions = { server: 'https://opencode.ai/console', clientId: 'test-client', userAgent: 'test-agent',
  catalogRetryCount: 1, catalogRetryDelayMs: 250, catalogCacheMs: 0, registryCacheMs: 300_000, registryStaleMs: 86_400_000,
  requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, refreshMarginMs: 1000, defaultContextWindow: 1000, defaultMaxTokens: 100 }

/** Capture the SDK options of one dispatch against a catalog routed through the given Console package. */
async function dispatch(packageName: string) {
  const fetch = vi.fn(async () => Response.json({ providers: { opencode: {
    package: packageName, settings: { baseURL: 'https://opencode.ai/zen/v1' }, models: { fixture: {} },
  } } }))
  vi.stubGlobal('fetch', fetch)
  const adapter = new OpenCodeAdapter(() => config, async () => ({ type: 'oauth', server: config.server,
    access: 'access', refresh: 'refresh', expires: Date.now() + 60_000, email: '', accountId: 'account' }))
  const drain = async () => {
    for await (const _chunk of adapter.stream({ provider: 'opencode-console', model: 'fixture', messages: [] })) { /* drain */ }
  }
  await expect(drain()).rejects.toThrow('SDK options captured')
  fetch.mockClear()
  return fetch
}

it.each(['@ai-sdk/openai-compatible', '@ai-sdk/google'])('rejects an altered SDK endpoint path or query for %s before sending credentials', async (packageName) => {
  const fetch = await dispatch(packageName)
  for (const url of ['https://opencode.ai/other', 'https://opencode.ai/zen/v1/chat/completions?changed=true']) {
    await expect(captured.options!.fetch!(url)).rejects.toThrow('changed the advertised endpoint')
  }
  expect(fetch).not.toHaveBeenCalled()
})

it('sends a Google route only to the Gemini path of its advertised endpoint, rejecting redirects', async () => {
  const fetch = await dispatch('@ai-sdk/google')
  fetch.mockImplementation(async () => new Response('data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n',
    { headers: { 'content-type': 'text/event-stream' } }))
  const response = await captured.options!.fetch!('https://opencode.ai/zen/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: 'wire', messages: [{ role: 'user', content: 'hi' }] }),
  })
  expect(response.ok).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(1)
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
  // The path comes from the catalog entry, not from the SDK body.
  expect(url).toBe('https://opencode.ai/zen/v1/models/fixture:streamGenerateContent?alt=sse')
  expect(init.redirect).toBe('error')
})
