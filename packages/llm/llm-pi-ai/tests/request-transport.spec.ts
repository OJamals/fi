import { describe, expect, it, vi } from 'vitest'
import type { Credential } from '@earendil-works/pi-ai'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import type { PiAiRequestTransportContext } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const OAUTH_GRANT: Credential = {
  type: 'oauth',
  access: 'header.eyJzdWIiOiJ0ZXN0LXVzZXIifQ.signature',
  refresh: 'test-refresh-placeholder',
  expires: Date.now() + 60 * 60_000,
}

async function drainRequest(adapter: PiAiAdapter, provider: string, model: string): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider,
    model,
    messages: [],
    sessionId: 'test-session' as never,
  })) chunks.push(chunk)
  return chunks
}

async function drain(adapter: PiAiAdapter): Promise<StreamChunk[]> {
  return drainRequest(adapter, 'xai', 'grok-4.3')
}

describe('pi-ai authenticated request transport', () => {
  it('applies transport-only additions to subscription OAuth requests', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('denied', { status: 401 })))
    const transformHeaders = vi.fn((headers: Record<string, string | null>) => ({
      ...headers,
      'x-test-subscription': 'yes',
    }))
    const resolveRequestTransport = vi.fn((_request: PiAiRequestTransportContext) => Promise.resolve({ fetch, transformHeaders }))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
      resolveRequestTransport,
    })

    await drain(adapter)

    const request = resolveRequestTransport.mock.calls[0]?.[0]
    expect(request).toEqual({
      provider: 'xai',
      model: 'grok-4.3',
      sessionId: 'test-session',
      timeoutMs: 600_000,
      harnessUserAgent: request?.harnessUserAgent,
    })
    expect(request?.harnessUserAgent).toMatch(/^deepseek-harness\//)
    expect(transformHeaders).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not apply transport additions when a profile supplies an API key', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('unexpected', { status: 500 })))
    const resolveRequestTransport = vi.fn(() => Promise.resolve({ fetch }))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: { baseURL: 'http://127.0.0.1:9/v1' } }),
      resolveApiKey: () => Promise.resolve('ordinary-api-key'),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
      resolveRequestTransport,
    })

    await drain(adapter)

    expect(resolveRequestTransport).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['absent resolver', undefined],
    ['undefined candidate', () => Promise.resolve(undefined)],
  ] as const)('keeps one SDK auth read for an %s', async (_case, resolveRequestTransport) => {
    const auth = memoryAuth({ xai: OAUTH_GRANT })
    const read = vi.spyOn(auth.credentials, 'read')
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
      ...(resolveRequestTransport === undefined ? {} : { resolveRequestTransport }),
    })

    await drain(adapter)

    expect(read).toHaveBeenCalledOnce()
  })

  it('does not apply transport additions to stored API-key auth', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('unexpected', { status: 500 })))
    const resolveRequestTransport = vi.fn(() => Promise.resolve({ fetch }))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: { baseURL: 'http://127.0.0.1:9/v1' } }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: { type: 'api_key', key: 'ordinary-api-key' } }),
      resolveRequestTransport,
    })

    await drain(adapter)

    expect(resolveRequestTransport).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('freezes resolved OAuth when the stored credential becomes an API key before SDK auth', async () => {
    const auth = memoryAuth({ xai: OAUTH_GRANT })
    auth.credentials.read = async (provider, options) => {
      options?.signal?.throwIfAborted()
      const credential = auth.stored.get(provider)
      auth.stored.set('xai', { type: 'api_key', key: 'replacement-api-key' })
      return credential
    }
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${OAUTH_GRANT.access}`)
      return Promise.resolve(new Response('denied', { status: 401 }))
    })
    const resolveRequestTransport = vi.fn(() => Promise.resolve({ fetch }))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth,
      resolveRequestTransport,
    })

    await drain(adapter)

    expect(resolveRequestTransport).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('fails closed when a transport transform replaces the resolved OAuth authorization', async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response('unexpected', { status: 500 })))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
      resolveRequestTransport: () => Promise.resolve({
        fetch,
        transformHeaders: headers => ({ ...headers, Authorization: 'Bearer replacement-api-key' }),
      }),
    })

    const chunks = await drain(adapter)

    expect(fetch).not.toHaveBeenCalled()
    const finish = chunks.find(chunk => chunk.type === 'finish')
    expect(finish?.type).toBe('finish')
    if (finish?.type === 'finish') expect(finish.reason.kind).toBe('error')
  })
})
