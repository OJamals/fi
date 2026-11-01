import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CatalogCache, loadCatalog, projectCatalog } from '../src/catalog.ts'
import type { ConsoleModel } from '../src/catalog.ts'
import type { ConsoleGrant, ConsoleOptions } from '../src/protocol.ts'
import { ModelRegistry, REGISTRY_URL } from '../src/registry.ts'

const config: ConsoleOptions = {
  server: 'https://opencode.ai/console', clientId: 'opencode-cli', userAgent: 'opencode/latest/2.2.5/cli',
  requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, refreshMarginMs: 120_000,
  catalogRetryCount: 0, catalogRetryDelayMs: 250, catalogCacheMs: 60_000, registryCacheMs: 60_000, registryStaleMs: 3_600_000,
  defaultContextWindow: 128_000, defaultMaxTokens: 8192,
}
const grant: ConsoleGrant = {
  type: 'oauth', server: config.server, access: 'access-a', refresh: 'refresh-a',
  expires: Date.now() + 3_600_000, email: 'a@example.test', accountId: 'account-a', orgId: 'org-a', orgName: 'A',
}
const inference = 'https://opencode.ai/inference/openai/v1'
const registryDocument = {
  opencode: {
    npm: '@ai-sdk/openai-compatible', api: inference,
    models: {
      'big-pickle': {
        id: 'big-pickle', modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 200_000, output: 32_000 },
        reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high'] }], cost: { input: 0, output: 0 },
      },
      paid: { id: 'paid', modalities: { output: ['text'] }, limit: { context: 0, output: 'many' } },
      gpt: { id: 'gpt', reasoning: false, provider: { npm: '@ai-sdk/openai', api: inference } },
      claude: { id: 'claude', reasoning: true, provider: { npm: '@ai-sdk/anthropic', api: 'https://opencode.ai/inference/anthropic/v1' } },
      gemini: { id: 'gemini', provider: { npm: '@ai-sdk/google', api: 'https://opencode.ai/inference/google/v1' } },
      dead: { id: 'dead', status: 'deprecated' },
      image: { id: 'image', modalities: { input: ['text'], output: ['image'] } },
      textless: { id: 'textless', modalities: { input: ['image'], output: ['text'] } },
      untrusted: { id: 'untrusted', provider: { api: 'https://example.com/v1' } },
      unsupported: { id: 'unsupported', provider: { npm: '@ai-sdk/mistral' } },
      malformed: 7,
      lenient: { id: 5, reasoning: 'yes', reasoning_options: 'effort', limit: 'big', modalities: [], provider: 'x' },
    },
  },
  'opencode-go': { npm: '@ai-sdk/openai-compatible', api: 'https://opencode.ai/inference/go/openai/v1', models: { chat: {} } },
  'no-endpoint': { npm: '@ai-sdk/openai-compatible', models: { orphan: {} } },
  foreign: 'not a provider',
}
const overlay = (models: Record<string, unknown> = { paid: { disabled: true } }, extra: Record<string, unknown> = {}) => ({
  providers: { opencode: { name: 'Default / OpenCode', headers: { 'x-opencode-org-id': 'org-a', 'x-safe': 'yes' }, models, ...extra } },
})
const json = (value: unknown, init?: ResponseInit): Response => Response.json(value, init)

interface Calls { catalogs: Request[]; registries: Request[] }

/** Serve the Console config and registry from handlers, recording both. */
function serve(
  console: (request: Request) => Response | Promise<Response>,
  registry: (request: Request) => Response | Promise<Response> = () => json(registryDocument),
): Calls {
  const calls: Calls = { catalogs: [], registries: [] }
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.url === REGISTRY_URL) {
      calls.registries.push(request)
      return registry(request)
    }
    calls.catalogs.push(request)
    return console(request)
  }))
  return calls
}
const ids = (models: ConsoleModel[]) => models.map(model => model.model.id)
const byId = (models: ConsoleModel[], id: string) => {
  const model = models.find(candidate => candidate.model.id === id)
  if (model === undefined) throw new Error(`missing model ${id}`)
  return model
}

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }) })
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('OpenCode catalog completion from the public registry', () => {
  it('overlays the Console workspace on registry models without reviving excluded routes', async () => {
    const calls = serve(() => json(overlay()))
    const models = await loadCatalog(config, grant, 'opencode-console')
    expect(ids(models)).toEqual(['big-pickle', 'gpt', 'claude', 'gemini', 'lenient'])
    expect(models.map(model => model.protocol)).toEqual(['openai-completions', 'openai-responses', 'anthropic-messages', 'google-generative-ai', 'openai-completions'])
    // pi-ai builds Google requests as OpenAI Chat; the Gemini transport translates them.
    expect(byId(models, 'gemini').model.api).toBe('openai-completions')
    expect(byId(models, 'gemini').model.baseUrl).toBe('https://opencode.ai/inference/google/v1')
    expect(byId(models, 'big-pickle')).toMatchObject({
      wireId: 'big-pickle', headers: { 'x-safe': 'yes' },
      reasoning: { supported: true, effort: ['low', 'high'] },
      model: { name: 'big-pickle', contextWindow: 200_000, maxTokens: 32_000, input: ['text'] },
    })
    expect(byId(models, 'gpt').reasoning).toEqual({ supported: false })
    expect(byId(models, 'claude').reasoning).toEqual({ supported: true })
    expect(byId(models, 'gemini')).not.toHaveProperty('reasoning')
    // Malformed registry fields degrade to unknown metadata instead of discarding the model.
    expect(byId(models, 'lenient')).toMatchObject({ wireId: 'lenient', model: { contextWindow: config.defaultContextWindow } })
    expect(byId(models, 'lenient')).not.toHaveProperty('reasoning')
    expect(calls.registries).toHaveLength(1)
    const request = calls.registries[0]!
    for (const name of ['authorization', 'x-api-key', 'x-org-id', 'x-opencode-org-id', 'cookie']) expect(request.headers.has(name)).toBe(false)
    expect(request.redirect).toBe('error')
    expect(calls.catalogs[0]?.headers.get('x-org-id')).toBe('org-a')
  })

  it('lets Console fields override the registry and keeps aliases on their source model', async () => {
    serve(() => json(overlay({
      alias: { modelID: 'gpt', name: 'Alias', body: { temperature: 0.2, tools: ['hidden'] } },
      gpt: { package: 'aisdk:@ai-sdk/openai-compatible', settings: { baseURL: 'https://opencode.ai/zen/v1' } },
      dead: { status: 'active', limit: { context: 4096 } },
      'big-pickle': { capabilities: { input: ['text'], output: ['text'], reasoning: { supported: false } } },
      claude: { capabilities: { reasoning: 'broken' } },
      paid: { disabled: true },
      custom: { name: 'Custom' },
    })))
    const models = await loadCatalog(config, grant, 'opencode-console')
    expect(byId(models, 'alias')).toMatchObject({ wireId: 'gpt', body: { temperature: 0.2 }, model: { name: 'Alias', api: 'openai-responses', baseUrl: inference } })
    expect(byId(models, 'gpt').model).toMatchObject({ api: 'openai-completions', baseUrl: 'https://opencode.ai/zen/v1' })
    expect(byId(models, 'dead').model.contextWindow).toBe(4096)
    expect(byId(models, 'big-pickle').reasoning).toEqual({ supported: false })
    expect(byId(models, 'claude')).not.toHaveProperty('reasoning')
    expect(byId(models, 'custom')).toMatchObject({ wireId: 'custom', model: { api: 'openai-completions', baseUrl: inference } })
    expect(ids(models)).not.toContain('paid')
  })

  it('applies provider-level Console routes to registry models and honors registry aliases', async () => {
    serve(() => json({ providers: { team: { canonical: 'opencode', package: '@ai-sdk/openai', models: {} } } }))
    const models = await loadCatalog(config, grant, 'opencode-console')
    expect(ids(models)).toEqual(['team/big-pickle', 'team/paid', 'team/gpt', 'team/claude', 'team/gemini', 'team/unsupported', 'team/lenient'])
    expect(models.map(model => model.protocol)).toEqual(Array.from({ length: models.length }, () => 'openai-responses'))
    expect(byId(models, 'team/claude').model.baseUrl).toBe('https://opencode.ai/inference/anthropic/v1')
  })

  it('refuses an unsafe endpoint named by the Console itself', async () => {
    serve(() => json(overlay({ risky: { settings: { baseURL: 'https://evil.example/v1' } } })))
    await expect(loadCatalog(config, grant, 'opencode-console')).rejects.toThrow('HTTPS opencode.ai URL')
  })

  it('omits providers the registry lacks without discarding the others, warning once', async () => {
    serve(() => json({ providers: {
      ...overlay().providers, unknown: { models: {} }, 'no-endpoint': { models: { orphan: {} } },
      complete: { package: '@ai-sdk/openai-compatible', settings: { baseURL: inference }, models: { explicit: {} } },
      off: { disabled: true, models: {} },
    } }))
    const warn = vi.fn()
    const cache = new CatalogCache(warn)
    const models = await cache.models(config, grant, 'opencode-console')
    await cache.models(config, grant, 'opencode-console', undefined, true)
    expect(ids(models)).toEqual(['big-pickle', 'gpt', 'claude', 'gemini', 'lenient', 'complete/explicit'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith('OpenCode model registry has no metadata for provider "unknown"; its models are omitted')
  })

  it('does not fetch the registry for a complete or disabled Console catalog', async () => {
    const complete = { package: '@ai-sdk/openai-compatible', settings: { baseURL: inference }, models: { explicit: {} } }
    const calls = serve(() => json({ providers: { opencode: complete, off: { disabled: true, models: {} } } }))
    expect(ids(await loadCatalog(config, grant, 'opencode-console'))).toEqual(['explicit'])
    expect(calls.registries).toHaveLength(0)
  })

  it.each([
    ['a model without a package', { package: '@ai-sdk/openai-compatible', settings: { baseURL: inference }, models: { a: { package: undefined }, b: {} } }, false],
    ['a provider without a package', { settings: { baseURL: inference }, models: { a: {} } }, true],
    ['a provider without an endpoint', { package: '@ai-sdk/openai-compatible', models: { a: {} } }, true],
    ['a model without an endpoint', { package: '@ai-sdk/openai-compatible', settings: {}, models: { a: { settings: { baseURL: inference } }, b: {} } }, true],
    ['no models', { package: '@ai-sdk/openai-compatible', settings: { baseURL: inference }, models: {} }, false],
  ])('decides whether %s needs the registry', async (_name, provider, needs) => {
    const calls = serve(() => json({ providers: { opencode: provider } }))
    await loadCatalog(config, grant, 'opencode-console')
    expect(calls.registries).toHaveLength(needs ? 1 : 0)
  })

  it('fails closed when the registry is unavailable and does not cache the failure', async () => {
    let status = 503
    const calls = serve(() => json(overlay()), () => status === 200 ? json(registryDocument) : json({ error: 'unavailable' }, { status }))
    await expect(loadCatalog(config, grant, 'opencode-console')).rejects.toThrow('registry unavailable (503)')
    status = 200
    await expect(loadCatalog(config, grant, 'opencode-console')).resolves.toHaveLength(5)
    expect(calls.registries).toHaveLength(2)
  })

  it('carries advertised reasoning controls from a complete Console catalog and ignores malformed ones', () => {
    const models = projectCatalog({ providers: { opencode: {
      package: '@ai-sdk/openai-compatible', settings: { baseURL: inference },
      models: {
        thinker: { capabilities: { output: ['text'], reasoning: { supported: true, toggle: true, effort: ['low', 'high'], budget: { min: 1024 } } } },
        broken: { capabilities: { reasoning: { supported: 'yes' } } },
        plain: {},
      },
    } } }, 'opencode-console', config)
    expect(models.map(model => model.reasoning)).toEqual([{ supported: true, toggle: true, effort: ['low', 'high'], budget: { min: 1024 } }, undefined, undefined])
  })
})

describe('OpenCode public registry cache', () => {
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms) }

  it('shares one download between concurrent loads and reuses the fresh copy', async () => {
    const gate = Promise.withResolvers<Response>()
    const calls = serve(() => json({}), () => gate.promise)
    const registry = new ModelRegistry()
    const loads = [registry.load(config), registry.load(config)]
    gate.resolve(json(registryDocument))
    const [first, second] = await Promise.all(loads)
    expect(first).toBe(second)
    expect([...first!.keys()]).toEqual(['opencode', 'opencode-go', 'no-endpoint'])
    expect(first!.get('opencode')?.models.has('malformed')).toBe(false)
    await registry.load(config)
    expect(calls.registries).toHaveLength(1)
  })

  it('ends only the cancelled waiter and keeps the shared download alive', async () => {
    const gate = Promise.withResolvers<Response>()
    const calls = serve(() => json({}), () => gate.promise)
    const registry = new ModelRegistry()
    const abort = new AbortController()
    const cancelled = registry.load(config, abort.signal)
    const peer = registry.load(config)
    const rejected = expect(cancelled).rejects.toThrow('waiter stopped')
    abort.abort(new Error('waiter stopped'))
    await rejected
    gate.resolve(json(registryDocument))
    expect((await peer).size).toBe(3)
    expect(calls.registries).toHaveLength(1)
    await expect(registry.load(config, AbortSignal.abort(new Error('already stopped')))).rejects.toThrow('already stopped')
  })

  it('revalidates with ETag and Last-Modified and keeps the copy on 304', async () => {
    let step = 0
    const calls = serve(() => json({}), () => {
      step++
      if (step === 1) return json(registryDocument, { headers: { etag: '"v1"', 'last-modified': 'Sat, 31 Oct 2026 00:00:00 GMT' } })
      if (step === 2) return new Response(null, { status: 304, headers: { etag: '"v2"' } })
      return new Response(null, { status: 304 })
    })
    const registry = new ModelRegistry()
    const first = await registry.load(config)
    advance(config.registryCacheMs)
    expect(await registry.load(config)).toBe(first)
    advance(config.registryCacheMs)
    expect(await registry.load(config)).toBe(first)
    expect(calls.registries[0]?.headers.has('if-none-match')).toBe(false)
    expect([1, 2].map(index => [calls.registries[index]?.headers.get('if-none-match'), calls.registries[index]?.headers.get('if-modified-since')])).toEqual([
      ['"v1"', 'Sat, 31 Oct 2026 00:00:00 GMT'], ['"v2"', 'Sat, 31 Oct 2026 00:00:00 GMT'],
    ])
    expect(calls.registries).toHaveLength(3)
  })

  it('serves the last good copy after a failed refresh, backs off, and gives up when it is too old', async () => {
    let failure: () => Response | Promise<Response> = () => json(registryDocument)
    const calls = serve(() => json({}), () => failure())
    const warn = vi.fn()
    const registry = new ModelRegistry(warn)
    const first = await registry.load(config)
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a non-Error rejection reaches the unknown-error message
    const rejectWithText = () => Promise.reject('plain text')
    for (const reject of [() => new Response('nope', { status: 500 }), () => { throw new TypeError('offline') }, rejectWithText]) {
      failure = reject
      advance(config.registryCacheMs)
      expect(await registry.load(config)).toBe(first)
      // The failed attempt starts a new freshness window, so the next read does not touch the network.
      expect(await registry.load(config)).toBe(first)
    }
    expect(calls.registries).toHaveLength(4)
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
      'OpenCode model registry refresh failed (OpenCode model registry unavailable (500)); using the previous copy',
      'OpenCode model registry refresh failed (offline); using the previous copy',
      'OpenCode model registry refresh failed (unknown error); using the previous copy',
    ])
    advance(config.registryStaleMs)
    await expect(registry.load(config)).rejects.toBe('plain text')
  })

  it.each([
    ['an empty document', () => json({})],
    ['a foreign document', () => json({ models: 7, other: { npm: 5 } })],
    ['a non-object document', () => json([1, 2])],
    ['a response without a body', () => new Response(null, { status: 200 })],
    ['a 304 nobody asked for', () => new Response(null, { status: 304 })],
    ['invalid JSON', () => new Response('{')],
  ])('refuses %s without replacing a good copy', async (_name, bad) => {
    let respond: () => Response = () => json(registryDocument)
    serve(() => json({}), () => respond())
    const registry = new ModelRegistry()
    const first = await registry.load(config)
    respond = bad
    advance(config.registryCacheMs)
    expect(await registry.load(config)).toBe(first)
    const cold = new ModelRegistry()
    await expect(cold.load(config)).rejects.toThrow()
  })

  it('keeps the 32 MiB response cap', async () => {
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    let cancelled = false
    serve(() => json({}), () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) { sent++; controller.enqueue(chunk) },
      cancel() { cancelled = true },
    })))
    await expect(new ModelRegistry().load(config)).rejects.toThrow('exceeded 32 MiB')
    expect(sent).toBeGreaterThanOrEqual(33)
    expect(cancelled).toBe(true)
  })

  it('does not warn without a listener and warns about at most one hundred providers', () => {
    new ModelRegistry().missing('anyone')
    const warn = vi.fn()
    const registry = new ModelRegistry(warn)
    for (let index = 0; index < 105; index++) registry.missing(`provider-${index}`)
    registry.missing('provider-0')
    expect(warn).toHaveBeenCalledTimes(100)
  })
})

describe('OpenCode catalog cache', () => {
  const complete = (name = 'one') => ({ providers: { opencode: { package: '@ai-sdk/openai-compatible', settings: { baseURL: inference }, models: { [name]: {} } } } })
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms) }

  it('reuses a catalog for the same account and organization until it expires, and rebinds the route name', async () => {
    let current = 'one'
    const calls = serve(() => json(complete(current)))
    const cache = new CatalogCache()
    expect(ids(await cache.models(config, grant, 'first-route'))).toEqual(['one'])
    current = 'two'
    const reused = await cache.models(config, { ...grant, access: 'rotated-token' }, 'second-route')
    expect(reused.map(model => [model.model.id, model.model.provider])).toEqual([['one', 'second-route']])
    advance(config.catalogCacheMs - 1)
    expect(ids(await cache.models(config, grant, 'first-route'))).toEqual(['one'])
    advance(1)
    expect(ids(await cache.models(config, grant, 'first-route'))).toEqual(['two'])
    expect(calls.catalogs).toHaveLength(2)
  })

  it('bypasses the cached catalog for user-initiated discovery and for a zero lifetime', async () => {
    let current = 'one'
    const calls = serve(() => json(complete(current)))
    const cache = new CatalogCache()
    await cache.models(config, grant, 'route')
    current = 'two'
    expect(ids(await cache.models(config, grant, 'route', undefined, true))).toEqual(['two'])
    expect(ids(await cache.models(config, grant, 'route'))).toEqual(['two'])
    current = 'three'
    expect(ids(await cache.models({ ...config, catalogCacheMs: 0 }, grant, 'route'))).toEqual(['three'])
    expect(calls.catalogs).toHaveLength(3)
  })

  it('keys catalogs by server, account, and organization', async () => {
    const calls = serve(request => json(complete(request.headers.get('x-org-id') ?? 'none')))
    const cache = new CatalogCache()
    const { orgId: _orgId, orgName: _orgName, ...unscoped } = grant
    expect(ids(await cache.models(config, grant, 'route'))).toEqual(['org-a'])
    expect(ids(await cache.models(config, { ...grant, orgId: 'org-b' }, 'route'))).toEqual(['org-b'])
    expect(ids(await cache.models(config, { ...grant, accountId: 'account-b' }, 'route'))).toEqual(['org-a'])
    expect(ids(await cache.models(config, unscoped, 'route'))).toEqual(['none'])
    expect(ids(await cache.models({ ...config, server: 'https://opencode.ai/other' }, grant, 'route'))).toEqual(['org-a'])
    expect(calls.catalogs).toHaveLength(5)
  })

  it('shares one load between concurrent readers and lets each cancel only its own wait', async () => {
    const gate = Promise.withResolvers<Response>()
    const calls = serve(() => gate.promise)
    const cache = new CatalogCache()
    const abort = new AbortController()
    const cancelled = cache.models(config, grant, 'route', abort.signal)
    const peer = cache.models(config, grant, 'route')
    const fresh = cache.models(config, grant, 'route', undefined, true)
    const rejected = expect(cancelled).rejects.toThrow('reader stopped')
    abort.abort(new Error('reader stopped'))
    await rejected
    gate.resolve(json(complete()))
    expect(ids(await peer)).toEqual(['one'])
    expect(ids(await fresh)).toEqual(['one'])
    expect(calls.catalogs).toHaveLength(1)
    await expect(cache.models(config, grant, 'route', AbortSignal.abort(new Error('already stopped')))).rejects.toThrow('already stopped')
    expect(calls.catalogs).toHaveLength(1)
  })

  it('never answers a failed load with an earlier catalog', async () => {
    let status = 200
    const calls = serve(() => json(status === 200 ? complete() : { error: 'invalid_grant' }, { status }))
    const cache = new CatalogCache()
    await cache.models(config, grant, 'route')
    advance(config.catalogCacheMs)
    status = 401
    await expect(cache.models(config, grant, 'route')).rejects.toThrow('reconnect')
    await expect(cache.models(config, grant, 'route')).rejects.toThrow('reconnect')
    expect(calls.catalogs).toHaveLength(3)
  })

  it('rejects organization policies it cannot evaluate before touching the registry', async () => {
    const calls = serve(() => json({ ...overlay(), experimental: { policies: [{ effect: 'deny' }] } }))
    await expect(new CatalogCache().models(config, grant, 'route')).rejects.toThrow('official OpenCode client')
    expect(calls.registries).toHaveLength(0)
  })

  it('keeps at most eight catalogs, dropping the oldest', async () => {
    const calls = serve(() => json(complete()))
    const cache = new CatalogCache()
    for (let index = 0; index < 9; index++) await cache.models(config, { ...grant, accountId: `account-${index}` }, 'route')
    await cache.models(config, { ...grant, accountId: 'account-8' }, 'route')
    expect(calls.catalogs).toHaveLength(9)
    await cache.models(config, { ...grant, accountId: 'account-0' }, 'route')
    expect(calls.catalogs).toHaveLength(10)
  })
})
