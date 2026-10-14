import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import OllamaService, { OLLAMA_KEY, OllamaAdapter, resolveOllamaGrant } from '../src/index.ts'
import { registerOllamaFlow } from '../src/authorization.ts'
import { cloudFetch, cloudJson, connectUrl, newDeviceKey, publicKeyBlob } from '../src/protocol.ts'
import type { OllamaGrant, OllamaOptions } from '../src/protocol.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const config: OllamaOptions = { deviceName: 'FI Test', requestTimeoutMs: 1000, authTimeoutMs: 1000, pollIntervalMs: 1,
  streamIdleTimeoutMs: 1000, defaultContextWindow: 32_768, defaultMaxTokens: 8192 }
const seed: OllamaGrant = { type: 'device', privateKey: newDeviceKey(), account: 'test-user' }
const dirs: string[] = []
const contexts: Context[] = []
const catalog = { models: [{ model: 'test-model', capabilities: ['completion', 'tools'] }, { model: 'embedding', capabilities: ['embedding'] }] }
const detail = { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'test', 'test.context_length': 65_536 } }
const input = { provider: 'ollama-cloud', model: 'test-model', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }] }

function script(handler: (request: Request) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))))
}

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'fi-ollama-'))
  dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(LlmRuntime)
  return ctx
}

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

function sse() {
  const data = [
    { id: 'test', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
    { id: 'test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } },
  ]
  return new Response(data.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('Ollama device protocol', () => {
  it('encodes an SSH Ed25519 public key and signs the exact timestamped request URI', async () => {
    const url = new URL(connectUrl(seed.privateKey, config.deviceName))
    expect(url.origin + url.pathname).toBe('https://ollama.com/connect')
    expect(url.searchParams.get('name')).toBe('FI Test')
    expect(Buffer.from(url.searchParams.get('key')!, 'base64url').toString()).toBe(`ssh-ed25519 ${publicKeyBlob(seed.privateKey)}`)
    const blob = Buffer.from(publicKeyBlob(seed.privateKey), 'base64')
    expect(blob.readUInt32BE(0)).toBe(11)
    expect(blob.subarray(4, 15).toString()).toBe('ssh-ed25519')
    expect(blob.readUInt32BE(15)).toBe(32)
    expect(blob.subarray(19)).toHaveLength(32)
    script((request) => {
      const signed = new URL(request.url)
      expect(signed.searchParams.get('ts')).toMatch(/^\d+$/)
      const [key, signature] = request.headers.get('authorization')!.split(':')
      expect(key).toBe(publicKeyBlob(seed.privateKey))
      expect(verify(null, Buffer.from(`POST,${signed.pathname}${signed.search}`), createPublicKey(seed.privateKey), Buffer.from(signature!, 'base64'))).toBe(true)
      expect(request.redirect).toBe('error')
      return Response.json({ name: 'test-user' })
    })
    await cloudFetch(seed.privateKey, new Request('https://ollama.com/api/me', { method: 'POST' }))
  })

  it.each(['https://evil.test/api/me', 'http://ollama.com/api/me', 'https://ollama.com/api/me?ts=1', 'https://ollama.com/api/me#x', 'https://ollama.com/other'])('refuses signing %s', async (url) => {
    script(() => { throw new Error('must not fetch') })
    await expect(cloudFetch(seed.privateKey, new Request(url, { method: 'POST' }))).rejects.toThrow('cloud endpoint')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects the wrong method and non-Ed25519 durable keys', async () => {
    await expect(cloudFetch(seed.privateKey, new Request('https://ollama.com/api/me'))).rejects.toThrow('cloud endpoint')
    const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => publicKeyBlob(key)).toThrow('Ed25519')
  })

  it.each([401, 429, 503])('reports cloud HTTP %i without exposing response details', async (status) => {
    script(() => Response.json({ error: 'private details' }, { status }))
    await expect(cloudJson(config, seed, '/api/tags')).rejects.toThrow(status === 401 ? 'sign in again' : `(${status})`)
  })

  it('honors cancellation before dispatch', async () => {
    script(() => { throw new Error('must not fetch') })
    await expect(cloudJson(config, seed, '/api/tags', undefined, AbortSignal.abort())).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('Ollama authorization', () => {
  it('updates dormant routes through Loader, keeps discovery independent, and withdraws contributions', async () => {
    const ctx = await harness()
    const release = vi.fn()
    const configure = vi.fn(() => release)
    ctx.provide('settings', { configure } as never)
    const live = await liveConfig(ctx, OllamaService, { ...config, providers: {} }, 'fi-ollama')
    expect(configure).toHaveBeenCalledWith({ auto: false }, expect.anything())
    expect(ctx.llm.listProviders()).toEqual([])
    await ctx.credentials.modifyRecord(OLLAMA_KEY, async () => ({ kind: 'grant', payload: seed }))
    script(() => Response.json(catalog))
    await live.update({ providers: { 'ollama-cloud': {} } })
    expect((await ctx.llm.listModels('ollama-cloud')).map(model => model.id)).toEqual(['test-model'])
    expect(await ctx.llm.discoverModels('fi-ollama', { baseURL: 'https://ollama.com' })).toEqual([{ id: 'test-model', name: 'test-model' }])
    expect(await ctx.llm.discoverModels('fi-ollama', { provider: 'ollama-cloud' })).toEqual([{ id: 'test-model', name: 'test-model' }])
    await live.update({ providers: { 'ollama-cloud': { models: [], displayName: 'Mine' } } })
    expect(await ctx.llm.listModels('ollama-cloud')).toEqual([])
    expect(ctx.llm.listProviders()).toContainEqual(expect.objectContaining({ name: 'Mine' }))
    expect(ctx.llm.listConfigurableProviders()).toContainEqual(expect.objectContaining({ displayName: 'Mine' }))
    await live.replace({ ...config, providers: {} })
    expect(ctx.llm.listProviders()).toEqual([])
    await live.fiber.dispose()
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
    expect(release).toHaveBeenCalledOnce()
  })

  it('mounts without Loader and rejects an empty configured device name', async () => {
    const ctx = await harness()
    const fiber = ctx.plugin(OllamaService)
    await fiber
    expect(ctx.llm.listConfigurableProviders()).toContainEqual(expect.objectContaining({ settingsNs: 'fi-ollama' }))
    await fiber.dispose()
    await expect(liveConfig(ctx, OllamaService, { deviceName: ' ' }, 'fi-ollama')).rejects.toThrow('must not be empty')
  })

  it('polls approval, persists only after account confirmation, and disposes its flow', async () => {
    const ctx = await harness()
    const fiber = await liveConfig(ctx, OllamaService, { ...config, providers: {} }, 'fi-ollama')
    let count = 0
    let browserKey = ''
    script(async (request) => {
      expect(await ctx.credentials.readRecord(OLLAMA_KEY)).toBeUndefined()
      expect(request.headers.get('authorization')!.split(':')[0]).toBe(browserKey)
      return ++count === 1 ? Response.json({}, { status: 401 }) : Response.json({ name: 'approved' })
    })
    const outcome = await ctx.authorization.begin({ key: OLLAMA_KEY, method: 'device', interaction: {
      notify(notice) { browserKey = Buffer.from(new URL(notice.url!).searchParams.get('key')!, 'base64url').toString().split(' ')[1]! },
      prompt: async () => { throw new Error('unexpected prompt') },
    } })
    expect(outcome).toEqual({ status: 'authorized' })
    expect(count).toBe(2)
    const stored = await resolveOllamaGrant(ctx)
    expect(stored?.account).toBe('approved')
    expect(publicKeyBlob(stored!.privateKey)).toBe(browserKey)
    await fiber.fiber.dispose()
    expect(ctx.authorization.list().some(entry => entry.key === OLLAMA_KEY)).toBe(false)
  })

  it.each(['server', 'invalid-account', 'cancel'])('preserves previous grant on %s', async (failure) => {
    const ctx = await harness()
    await ctx.credentials.modifyRecord(OLLAMA_KEY, async () => ({ kind: 'grant', payload: seed }))
    registerOllamaFlow(ctx, () => config)
    script(() => {
      if (failure === 'cancel') ctx.authorization.cancel(OLLAMA_KEY)
      return Response.json({ name: failure === 'invalid-account' ? '' : 'approved' }, { status: failure === 'server' ? 503 : 200 })
    })
    const attempt = ctx.authorization.begin({ key: OLLAMA_KEY, interaction: { notify() {}, prompt: async () => '' } })
    if (failure === 'cancel') await expect(attempt).resolves.toEqual({ status: 'cancelled' })
    else await expect(attempt).rejects.toThrow()
    expect(await resolveOllamaGrant(ctx)).toEqual(seed)
  })

  it('reads signed-out state and rejects malformed or cancelled stored reads', async () => {
    const ctx = await harness()
    expect(await resolveOllamaGrant(ctx)).toBeUndefined()
    await expect(resolveOllamaGrant(ctx, AbortSignal.abort())).rejects.toThrow()
    await ctx.credentials.modifyRecord(OLLAMA_KEY, async () => ({ kind: 'grant', payload: { type: 'device' } }))
    await expect(resolveOllamaGrant(ctx)).rejects.toThrow()
    await ctx.credentials.modifyRecord(OLLAMA_KEY, async () => ({ kind: 'api-key', key: 'not-a-device' }))
    await expect(resolveOllamaGrant(ctx)).rejects.toThrow('must be a device grant')
  })
})

describe('Ollama inference', () => {
  it('reports revoked device authorization without an API-key diagnosis', async () => {
    script((request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/tags') return Response.json(catalog)
      if (path === '/api/show') return Response.json(detail)
      return Response.json({ error: { message: 'private account detail' } }, { status: 401 })
    })
    const adapter = new OllamaAdapter(() => config, async () => seed, () => undefined)
    expect((await collect(adapter.stream(input))).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: {
      code: 'CREDENTIAL_REVOKED', status: 401, message: 'Ollama Cloud authorization expired or was revoked; sign in again',
    } } })
  })
  it('aborts an idle request and reports the owned stream timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const reached = Promise.withResolvers<undefined>()
    script((request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/tags') return Response.json(catalog)
      if (path === '/api/show') return Response.json(detail)
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => { reject(new Error('cancelled')) }, { once: true })
        reached.resolve(undefined)
      })
    })
    const adapter = new OllamaAdapter(() => config, async () => seed, () => undefined)
    const result = expect(collect(adapter.stream({ ...input, signal: new AbortController().signal }))).rejects.toMatchObject({ code: 'TIMEOUT' })
    await reached.promise
    await vi.advanceTimersByTimeAsync(config.streamIdleTimeoutMs)
    await result
  })

  it('round-trips a streamed tool call through the signed cloud transport', async () => {
    let requests = 0
    script(async (request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/tags') return Response.json(catalog)
      if (path === '/api/show') return Response.json(detail)
      const body = z.record(z.string(), z.unknown()).parse(await request.json())
      expect(body['tools']).toMatchObject([{ function: { name: 'get_status' } }])
      if (++requests === 2) {
        expect(body['messages']).toContainEqual(expect.objectContaining({ role: 'tool', content: 'READY' }))
        return sse()
      }
      const chunk = { id: 'tool-response', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'get_status', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    const adapter = new OllamaAdapter(() => config, async () => seed, () => undefined)
    const options = { ...input, tools: [{ name: 'get_status', description: 'Read status', parameters: { type: 'object', properties: {} } }] }
    const assembler = new BlockAssembler()
    for await (const chunk of adapter.stream(options)) assembler.push(chunk)
    const assistant = assembler.message({ provider: input.provider, model: input.model, replayState: assembler.replayState })
    const call = assistant.content.find(block => block.type === 'tool-call')
    expect(call).toMatchObject({ name: 'get_status' })
    if (call?.type !== 'tool-call') throw new Error('missing tool call')
    const result = createToolResultMessage({ callId: call.id, isError: false, content: [{ type: 'text', text: 'READY' }] })
    expect(await collect(adapter.stream({ ...options, messages: [...options.messages, assistant, result] })))
      .toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Hello' }))
    expect(requests).toBe(2)
  })
  it('discovers cloud completion models, applies picker selection, and preserves model capacity', async () => {
    script(request => Response.json(new URL(request.url).pathname === '/api/tags' ? catalog : detail))
    const adapter = new OllamaAdapter(() => config, async () => seed, () => ({ displayName: 'Mine', models: [] }))
    expect(adapter.providerInfo('ollama-cloud').name).toBe('Mine')
    expect(await adapter.listModels('ollama-cloud')).toEqual([])
    expect(await adapter.discoverModels('ollama-cloud')).toEqual([{ provider: 'ollama-cloud', id: 'test-model', name: 'test-model', inputModalities: ['text'] }])
    expect(await adapter.resolveModel('ollama-cloud', 'test-model')).toMatchObject({ context: { contextWindow: 65_536 } })
    await expect(adapter.resolveModel('ollama-cloud', 'missing')).rejects.toThrow('not advertised')
  })

  it('returns no models while signed out and refuses inference', async () => {
    const adapter = new OllamaAdapter(() => config, async () => undefined, () => undefined)
    expect(adapter.providerInfo('ollama-cloud').name).toBe('Ollama Cloud')
    expect(await adapter.listModels('ollama-cloud')).toEqual([])
    await expect(collect(adapter.stream(input))).rejects.toThrow('not signed in')
  })

  it('streams text and usage with a frozen device identity after account changes', async () => {
    let current = seed
    script((request) => {
      const path = new URL(request.url).pathname
      if (path === '/api/tags') return Response.json(catalog)
      if (path === '/api/show') return Response.json(detail)
      expect(request.headers.get('authorization')!.split(':')[0]).toBe(publicKeyBlob(seed.privateKey))
      return sse()
    })
    const adapter = new OllamaAdapter(() => config, async () => current, () => undefined)
    const prepared = await adapter.prepareCall(input.provider, input.model)
    current = { ...seed, privateKey: newDeviceKey() }
    const chunks = await collect(prepared.stream({ ...input, temperature: 0.1, maxTokens: 30 }))
    expect(chunks).toContainEqual({ type: 'text-delta', index: 0, text: 'Hello' })
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'finish', reason: { kind: 'stop' } }))
    await expect(collect(prepared.stream({ ...input, model: 'other' }))).rejects.toThrow('identity changed')
  })

  it('uses configured missing capacities and rejects unsupported options or tools', async () => {
    script(request => Response.json(new URL(request.url).pathname === '/api/tags' ? catalog : { capabilities: ['completion'], model_info: {} }))
    const adapter = new OllamaAdapter(() => config, async () => seed, () => undefined)
    expect(await adapter.resolveModel(input.provider, input.model))
      .toMatchObject({ context: { contextWindow: config.defaultContextWindow } })
    await expect(collect(adapter.stream({ ...input, stop: ['END'] }))).rejects.toThrow('not supported')
    await expect(collect(adapter.stream({ ...input, tools: [{ name: 'read', description: 'Read', parameters: {} }] }))).rejects.toThrow('does not support tools')
  })
})
