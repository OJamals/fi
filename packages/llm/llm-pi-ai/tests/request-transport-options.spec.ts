/** Authorization checks on the transport callbacks passed to the SDK. */
import { afterEach, expect, it, vi } from 'vitest'
import type { SimpleStreamOptions } from '@earendil-works/pi-ai'
import { PiAiAdapter } from '../src/adapter.ts'
import { resolveProfiles } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

const { captured } = vi.hoisted(() => ({ captured: { options: undefined as SimpleStreamOptions | undefined } }))
vi.mock('../src/models.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/models.ts')>()
  return { ...actual, createModels: (...args: Parameters<typeof actual.createModels>) => {
    const models = actual.createModels(...args)
    vi.spyOn(models, 'streamSimple').mockImplementation((_model, _context, options) => {
      captured.options = options
      throw new Error('SDK dispatch captured')
    })
    return models
  } }
})

afterEach(() => { captured.options = undefined; vi.restoreAllMocks() })

it('accepts Request authorization and rejects an altered WebSocket handshake before delegation', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
  const connect = vi.fn(() => { throw new Error('unexpected WebSocket delegation') })
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ xai: {} }),
    resolveApiKey: () => Promise.resolve(undefined),
    auth: memoryAuth({ xai: { type: 'oauth', access: 'fixture-token', refresh: 'fixture-refresh', expires: Date.now() + 3600000 } }),
    resolveRequestTransport: () => Promise.resolve({ fetch: fetcher, websocketFactory: connect }),
  })
  const dispatch = async () => { for await (const _chunk of adapter.stream({ provider: 'xai', model: 'grok-4.3', messages: [] })) { /* drain */ } }
  await expect(dispatch()).rejects.toThrow('SDK dispatch captured')
  const request = new Request('https://fixture.invalid/v1', { headers: { Authorization: 'Bearer fixture-token' } })
  await expect(captured.options!.fetch!(request)).resolves.toMatchObject({ status: 204 })
  expect(fetcher).toHaveBeenCalledWith(request, undefined)
  expect(() => captured.options!.websocketFactory!('wss://fixture.invalid/v1', { Authorization: 'Bearer changed' }, {}))
    .toThrow('WebSocket authorization changed')
  expect(connect).not.toHaveBeenCalled()
})
