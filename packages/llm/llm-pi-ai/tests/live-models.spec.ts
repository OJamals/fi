import { describe, expect, it, vi } from 'vitest'
import type { Credential } from '@earendil-works/pi-ai'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import type { PiAiLiveModelsContext } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

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

describe('live model discovery', () => {
  it('leaves the installed catalog untouched and never calls the hook for a curated models list', async () => {
    const resolveLiveModels = vi.fn(() => Promise.resolve([{ id: 'grok-9-preview' }]))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: { models: [{ id: 'grok-4.3' }] } }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
      resolveLiveModels,
    })

    const models = await adapter.listModels('xai')

    expect(models.map(model => model.id)).toEqual(['grok-4.3'])
    expect(resolveLiveModels).not.toHaveBeenCalled()
  })

  it('never calls the hook for stored API-key auth', async () => {
    const resolveLiveModels = vi.fn(() => Promise.resolve([{ id: 'grok-9-preview' }]))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: { type: 'api_key', key: 'ordinary-api-key' } }),
      resolveLiveModels,
    })

    await adapter.listModels('xai')

    expect(resolveLiveModels).not.toHaveBeenCalled()
  })

  it('never calls the hook for a route pi-ai does not mark as a subscription', async () => {
    const resolveLiveModels = vi.fn(() => Promise.resolve([{ id: 'gpt-9-preview' }]))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ openai: { apiKeyEnv: 'PI_TEST_KEY_OPENAI' } }),
      resolveApiKey: () => Promise.resolve('test-key'),
      // A raw OAuth-shaped record is harmless here: this route's installed
      // provider declares no `auth.oauth` at all, so the adapter never asks.
      auth: memoryAuth({ openai: OAUTH_GRANT }),
      resolveLiveModels,
    })

    await adapter.listModels('openai')

    expect(resolveLiveModels).not.toHaveBeenCalled()
  })

  it('merges a live-only id into listModels beyond the installed catalog', async () => {
    const installed = getBuiltinModels('xai').map(model => model.id)
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
      resolveLiveModels: () => Promise.resolve([{ id: 'grok-9-preview', name: 'Grok 9 Preview' }]),
    })

    const models = await adapter.listModels('xai')

    expect(models.map(model => model.id)).toEqual([...installed, 'grok-9-preview'])
    expect(models.find(model => model.id === 'grok-9-preview')?.name).toBe('Grok 9 Preview')
  })

  it('does not duplicate a live id the installed catalog already lists', async () => {
    const [firstInstalled] = getBuiltinModels('xai')
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
      resolveLiveModels: () => Promise.resolve([{ id: firstInstalled?.id ?? '' }]),
    })

    const models = await adapter.listModels('xai')

    expect(models.filter(model => model.id === firstInstalled?.id)).toHaveLength(1)
  })

  it('shows a newly live-discovered id the moment a later call reports it', async () => {
    let live: readonly { id: string }[] = []
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
      resolveLiveModels: () => Promise.resolve(live),
    })

    expect((await adapter.listModels('xai')).map(model => model.id)).not.toContain('grok-9-preview')

    live = [{ id: 'grok-9-preview' }]
    expect((await adapter.listModels('xai')).map(model => model.id)).toContain('grok-9-preview')
  })

  it('swallows a hook failure and keeps serving the installed catalog', async () => {
    const installed = getBuiltinModels('xai').map(model => model.id)
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
      resolveLiveModels: () => Promise.reject(new Error('network down')),
    })

    const models = await adapter.listModels('xai')

    expect(models.map(model => model.id)).toEqual(installed)
  })

  it('passes the resolved OAuth token and provider to the hook, never a raw credential read', async () => {
    const resolveLiveModels = vi.fn((_request: PiAiLiveModelsContext) => Promise.resolve([]))
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
      resolveLiveModels,
    })

    await adapter.listModels('xai')

    expect(resolveLiveModels).toHaveBeenCalledWith(expect.objectContaining({ provider: 'xai', apiKey: OAUTH_GRANT.access }))
  })

  it('resolves a live-only model id by cloning its closest catalog template', async () => {
    const resolved = await new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
      resolveLiveModels: () => Promise.resolve([{ id: 'grok-9-preview' }]),
    }).resolveModel('xai', 'grok-9-preview')

    expect(resolved.id).toBe('grok-9-preview')
    // A cloned model keeps the template's capacities rather than reporting nothing.
    expect(resolved.context?.contextWindow).toBeGreaterThan(0)
  })

  it('rejects a model id neither the catalog nor a live listing names', async () => {
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
      resolveLiveModels: () => Promise.resolve([]),
    })

    await expect(adapter.resolveModel('xai', 'not-a-real-model')).rejects.toThrow(/no configured model/)
  })

  it('streams a live-only id via its cloned template, through the same endpoint', async () => {
    // xai's installed catalog speaks the Responses protocol, so the clone
    // (which inherits its template's api/baseUrl) is exercised through the
    // same event shape a real grok-4.3 request would receive.
    const responsesEvents = [
      '{"type":"response.created","response":{"id":"resp_1"}}',
      '{"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant"}}',
      '{"type":"response.output_text.delta","output_index":0,"delta":"hello"}',
      '{"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],'
      + '"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}',
    ]
    const server = await mockServer([{ events: responsesEvents }])
    try {
      const adapter = new PiAiAdapter({
        profiles: () => resolveProfiles({ xai: { baseURL: server.url } }),
        resolveApiKey: () => Promise.resolve(undefined),
        auth: memoryAuth({ xai: OAUTH_GRANT }),
        resolveLiveModels: () => Promise.resolve([{ id: 'grok-9-preview' }]),
      })

      const chunks = await drainRequest(adapter, 'xai', 'grok-9-preview')

      expect(server.paths).toHaveLength(1)
      const finish = chunks.find(chunk => chunk.type === 'finish')
      expect(finish?.type === 'finish' && finish.reason.kind).toBe('stop')
    } finally {
      await closeMockServers()
    }
  })

  it('offers no live models at all when no hook is configured', async () => {
    const installed = getBuiltinModels('xai').map(model => model.id)
    const adapter = new PiAiAdapter({
      profiles: () => resolveProfiles({ xai: {} }),
      resolveApiKey: () => Promise.resolve(undefined),
      auth: memoryAuth({ xai: OAUTH_GRANT }),
    })

    const models = await adapter.listModels('xai')

    expect(models.map(model => model.id)).toEqual(installed)
    expect(await adapter.liveModelIds('xai')).toEqual([])
  })
})
