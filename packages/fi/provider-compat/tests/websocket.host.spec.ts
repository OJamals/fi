import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { connect as connectTcp } from 'node:net'
import { WebSocketServer } from 'ws'
import { createModels, type Credential } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { closeOpenAICodexWebSocketConnector, closeOpenAICodexWebSocketSessions, getOpenAICodexWebSocketDebugStats, resetOpenAICodexWebSocketDebugStats } from '@earendil-works/pi-ai/api/openai-codex-responses'
import { PiAiAdapter, type PiAiAdapterOptions, type PiAiRequestTransport } from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveProfiles } from '@deepseek-ai/dsh-llm-pi-ai/src/config.ts'
import { Config, subscriptionFetch, subscriptionWebSocket, subscriptionWebSocketConnector, providerSettingsFor } from '../src/index.ts'

type Factory = NonNullable<PiAiRequestTransport['websocketFactory']>
type Connector = ReturnType<Factory>['connect']
const sessions: string[] = []
const cleanups: (() => Promise<void>)[] = []
const URL = 'wss://chatgpt.com/backend-api/codex/responses'
const UA = 'deepseek-harness/test'

function grant(nonce = 'first'): Credential {
  return {
    type: 'oauth',
    access: `header.${Buffer.from(JSON.stringify({ nonce, 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account' } })).toString('base64url')}.signature`,
    refresh: 'fixture-refresh',
    expires: Date.now() + 3_600_000,
  }
}

function auth(): PiAiAdapterOptions['auth'] & { set: (value: Credential | undefined) => void } {
  let current: Credential | undefined = grant()
  return {
    set: (value) => { current = value },
    credentials: {
      read: () => Promise.resolve(current),
      list: () => Promise.resolve([]),
      modify: async (_provider, mutate) => { current = await mutate(current); return current },
      delete: () => { current = undefined; return Promise.resolve() },
    },
    authContext: { env: () => Promise.resolve(undefined), fileExists: () => Promise.resolve(false) },
  }
}

function events() {
  return [
    { type: 'response.created', response: { id: 'response-fixture' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'message-fixture', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'message-fixture', role: 'assistant', content: [{ type: 'output_text', text: 'OK', annotations: [] }] } },
    { type: 'response.completed', response: { id: 'response-fixture', status: 'completed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]
}

async function server(maxPayloadBytes = 100 * 1024 * 1024) {
  const handshakes: IncomingMessage[] = []
  const httpRequests: IncomingMessage[] = []
  const state = { reject: false, redirect: false, stall: false, hold: false, oversized: false, onUpgrade: () => {} }
  const http = createServer((request, response) => {
    httpRequests.push(request)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(events().map(event => `data: ${JSON.stringify(event)}\n\n`).join(''))
  })
  const ws = new WebSocketServer({ noServer: true })
  http.on('upgrade', (request, socket, head) => {
    handshakes.push(request)
    state.onUpgrade()
    if (state.hold) return
    if (state.redirect) { socket.end(`HTTP/1.1 302 Found\r\nLocation: ws://${request.headers.host}/redirected\r\nContent-Length: 0\r\n\r\n`); return }
    if (state.reject) { socket.end('HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\n\r\n'); return }
    ws.handleUpgrade(request, socket, head, (connection) => {
      connection.on('message', () => {
        if (state.oversized) { connection.send('X'.repeat(maxPayloadBytes + 1)); return }
        if (!state.stall) for (const event of events()) connection.send(JSON.stringify(event))
      })
    })
  })
  http.listen(0, '127.0.0.1')
  await once(http, 'listening')
  const address = http.address()
  if (address === null || typeof address === 'string') throw new Error('fixture lacks TCP address')
  const endpoint = `127.0.0.1:${address.port}`
  const constructor = subscriptionWebSocketConnector(maxPayloadBytes)
  const pending = new Set<import('node:net').Socket>()
  http.on('connection', (socket) => { pending.add(socket); socket.once('close', () => { pending.delete(socket) }) })
  cleanups.push(async () => {
    closeOpenAICodexWebSocketConnector(connect)
    await constructor.dispose()
    for (const socket of pending) socket.destroy()
    for (const client of ws.clients) client.terminate()
    await new Promise<void>((resolve) => { ws.close(() => { resolve() }) })
    await new Promise<void>((resolve) => { http.close(() => { resolve() }) })
  })
  const connect: Connector = (url, headers) => {
    expect(url).toBe(URL)
    return constructor(`ws://${endpoint}/codex/responses`, headers)
  }
  const fetch: typeof globalThis.fetch = (_input, init) => globalThis.fetch(`http://${endpoint}/codex/responses`, init)
  return { handshakes, httpRequests, state, connect, fetch, constructor, endpoint }
}

function adapter(
  fixture: Awaited<ReturnType<typeof server>>,
  credentials = auth(),
  transport?: 'auto' | 'sse' | 'websocket' | 'websocket-cached',
  mutate?: (prepared: ReturnType<Factory>) => ReturnType<Factory>,
) {
  const prepare = vi.fn((...args: Parameters<Factory>) => args)
  const adapter = new PiAiAdapter({
    profiles: () => resolveProfiles({ 'openai-codex': { ...transport === undefined ? {} : { transport } } }),
    resolveApiKey: () => Promise.resolve(undefined),
    auth: credentials,
    resolveRequestTransport: request => Promise.resolve({
      websocketFactory: (url, headers, env) => {
        prepare(url, headers, env)
        const prepared = subscriptionWebSocket(request, fixture.connect)(url, headers, env)
        return mutate === undefined ? prepared : mutate(prepared)
      },
      fetch: subscriptionFetch({ ...request, provider: 'openai-codex' }, fixture.fetch),
    }),
  })
  return { adapter, prepare }
}

async function run(adapter: PiAiAdapter, sessionId: string, signal?: AbortSignal) {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: 'openai-codex', model: 'gpt-5.5', messages: [], sessionId: sessionId as never,
    ...signal === undefined ? {} : { signal },
  })) chunks.push(chunk)
  return chunks
}

function session() { const id = randomUUID(); sessions.push(id); return id }

afterEach(async () => {
  for (const id of sessions.splice(0)) { closeOpenAICodexWebSocketSessions(id); resetOpenAICodexWebSocketDebugStats(id) }
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

describe('Codex subscription WebSocket wire', () => {
  it.each([undefined, 'auto', 'websocket', 'websocket-cached'] as const)('sends canonical handshake metadata over %s', async (transport) => {
    const fixture = await server()
    const { adapter: client } = adapter(fixture, auth(), transport)
    const id = session()
    const chunks = await run(client, id)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(fixture.httpRequests).toHaveLength(0)
    expect(fixture.handshakes).toHaveLength(1)
    expect(getOpenAICodexWebSocketDebugStats(id)?.cachedContextRequests).toBe(transport === 'websocket' ? 0 : 1)
    const headers = fixture.handshakes[0]?.headers
    const settings = providerSettingsFor('codexCli')
    expect(headers?.originator).toBe(settings.originator)
    expect(headers?.version).toBe(settings.version)
    expect(headers?.['user-agent']).toContain(`${settings.originator}/${settings.version}`)
    expect(headers?.['chatgpt-account-id']).toBe('fixture-account')
    expect(headers?.['openai-beta']).toBe(settings.responsesWebsocketBeta)
    expect(headers?.['session-id']).toBe(id)
    expect(headers?.['x-client-request-id']).toBe(id)
    expect(headers?.['x-deepseek-harness-user-agent']).toMatch(/^deepseek-harness\//)
    expect(headers?.authorization).toMatch(/^Bearer header\./)
  })

  it('validates every call while reusing sockets only for the same credential and metadata', async () => {
    const fixture = await server()
    const credentials = auth()
    let metadata = 'first'
    const { adapter: client, prepare } = adapter(fixture, credentials, undefined, prepared => ({ ...prepared, headers: { ...prepared.headers, 'x-fi-test': metadata } }))
    const id = session()
    await run(client, id)
    await run(client, id)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(fixture.handshakes).toHaveLength(1)
    credentials.set(grant('replacement'))
    await run(client, id)
    expect(fixture.handshakes).toHaveLength(2)
    metadata = 'changed'
    await run(client, id)
    expect(fixture.handshakes).toHaveLength(3)
  })

  it('uses authenticated SSE on handshake failure and isolates fallback after credential replacement', async () => {
    const fixture = await server()
    fixture.state.reject = true
    const credentials = auth()
    const { adapter: client, prepare } = adapter(fixture, credentials, 'auto')
    const id = session()
    expect((await run(client, id)).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    await run(client, id)
    expect(fixture.handshakes).toHaveLength(1)
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(fixture.httpRequests).toHaveLength(2)
    expect(fixture.httpRequests[0]?.headers.originator).toBe(providerSettingsFor('codexCli').originator)
    fixture.state.reject = false
    credentials.set(grant('replacement'))
    await run(client, id)
    expect(fixture.handshakes).toHaveLength(2)
    expect(fixture.httpRequests).toHaveLength(2)
  })

  it('keeps explicit SSE and never prepares a WebSocket', async () => {
    const fixture = await server()
    const { adapter: client, prepare } = adapter(fixture, auth(), 'sse')
    expect((await run(client, session())).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(prepare).not.toHaveBeenCalled()
    expect(fixture.handshakes).toHaveLength(0)
    expect(fixture.httpRequests).toHaveLength(1)
  })

  it('rejects changed authorization before a cached socket or HTTP fallback can send', async () => {
    const fixture = await server()
    let corrupt = false
    const { adapter: client } = adapter(fixture, auth(), 'auto', prepared => corrupt
      ? { ...prepared, headers: { ...prepared.headers, authorization: 'Bearer replacement' } }
      : prepared)
    const id = session()
    await run(client, id)
    corrupt = true
    expect((await run(client, id)).at(-1)).toMatchObject({ reason: { kind: 'error' } })
    expect(fixture.handshakes).toHaveLength(1)
    expect(fixture.httpRequests).toHaveLength(0)
  })

  it('rejects noncanonical endpoints and missing request identity before constructing a socket', () => {
    const factory = subscriptionWebSocket({ provider: 'openai-codex', model: 'gpt-5.5', timeoutMs: 60000, harnessUserAgent: UA }, () => { throw new Error('unexpected connection') })
    expect(() => factory('wss://example.test/codex/responses', {})).toThrow('canonical endpoint')
    expect(() => factory(`${URL}?redirect=true`, {})).toThrow('canonical endpoint')
    expect(() => factory(URL, {})).toThrow('request identity')
  })

  it('cancels an active WebSocket without HTTP fallback', async () => {
    const fixture = await server()
    fixture.state.stall = true
    const controller = new AbortController()
    const originalConnect = fixture.connect
    fixture.connect = (url, headers) => {
      const socket = originalConnect(url, headers)
      socket.addEventListener('open', () => { controller.abort('fixture cancellation') })
      return socket
    }
    const { adapter: client } = adapter(fixture)
    expect((await run(client, session(), controller.signal)).at(-1)).toMatchObject({ reason: { kind: 'aborted' } })
    expect(fixture.httpRequests).toHaveLength(0)
  })

  it('cancels a pending handshake without unhandled ws errors or SSE fallback', async () => {
    const fixture = await server()
    fixture.state.hold = true
    const controller = new AbortController()
    fixture.state.onUpgrade = () => { controller.abort() }
    const { adapter: client } = adapter(fixture)
    expect((await run(client, session(), controller.signal)).at(-1)).toMatchObject({ reason: { kind: 'aborted' } })
    await fixture.constructor.dispose()
    expect(fixture.httpRequests).toHaveLength(0)
  })

  it('rejects unbounded payload configuration and enforces the selected wire limit', async () => {
    for (const value of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => Config({ websocketMaxPayloadBytes: value })).toThrow()
    }
    expect(Config({}).websocketMaxPayloadBytes).toBe(100 * 1024 * 1024)
    const fixture = await server(1024)
    fixture.state.oversized = true
    const { adapter: client } = adapter(fixture)
    await run(client, session())
    expect(fixture.handshakes).toHaveLength(1)
    expect(fixture.httpRequests).toHaveLength(1)
  })

  it('retains the validated snapshot when a listener mutates its original record asynchronously', async () => {
    const fixture = await server()
    const { adapter: client } = adapter(fixture, auth(), 'auto', (prepared) => {
      queueMicrotask(() => { prepared.headers.authorization = 'Bearer later-replacement' })
      return prepared
    })
    expect((await run(client, session())).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(fixture.handshakes[0]?.headers.authorization).toMatch(/^Bearer header\./)
    expect(fixture.httpRequests).toHaveLength(0)
  })

  it('retires only the selected connector and refuses later reuse or fallback', async () => {
    const first = await server()
    const second = await server()
    const a = adapter(first)
    const b = adapter(second)
    const id = session()
    await run(a.adapter, id)
    await run(b.adapter, id)
    closeOpenAICodexWebSocketConnector(first.connect)
    await first.constructor.dispose()
    expect((await run(a.adapter, id)).at(-1)).toMatchObject({ reason: { kind: 'error' } })
    expect(first.httpRequests).toHaveLength(0)
    expect((await run(b.adapter, id)).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(second.handshakes).toHaveLength(1)
  })

  it('does not populate fallback after connector disposal during a pending handshake', async () => {
    const fixture = await server()
    fixture.state.hold = true
    fixture.state.onUpgrade = () => {
      closeOpenAICodexWebSocketConnector(fixture.connect)
      void fixture.constructor.dispose()
    }
    const { adapter: client } = adapter(fixture)
    const id = session()
    expect((await run(client, id)).at(-1)).toMatchObject({ reason: { kind: 'error' } })
    expect(getOpenAICodexWebSocketDebugStats(id)?.sseFallbacks ?? 0).toBe(0)
    expect(fixture.httpRequests).toHaveLength(0)
  })

  it.each([false, true])('clears owned state after session cleanup during a pending handshake (success=%s)', async (success) => {
    const fixture = await server()
    const id = session()
    fixture.state.reject = !success
    fixture.state.onUpgrade = () => { closeOpenAICodexWebSocketSessions(id) }
    const { adapter: client } = adapter(fixture)
    expect((await run(client, id)).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(fixture.httpRequests).toHaveLength(success ? 0 : 1)
    if (!success) expect(getOpenAICodexWebSocketDebugStats(id)?.websocketFallbackActive).toBe(true)
    closeOpenAICodexWebSocketConnector(fixture.connect)
    expect(getOpenAICodexWebSocketDebugStats(id)?.websocketFallbackActive).toBe(false)
    expect((await run(client, id)).at(-1)).toMatchObject({ reason: { kind: 'error' } })
    expect(fixture.httpRequests).toHaveLength(success ? 0 : 1)
  })

  it('forwards resolved provider proxy overrides through the adapter and isolates proxy changes', async () => {
    const prototype = Object.getPrototypeOf(createModels()) as ReturnType<typeof createModels>
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getAuth') as TypedPropertyDescriptor<typeof prototype.getAuth>
    const original = descriptor.value
    if (original === undefined) throw new Error('Models prototype lacks getAuth')
    let env = { HTTPS_PROXY: 'http://proxy.fixture:3128', NO_PROXY: '' }
    const spy = vi.spyOn(prototype, 'getAuth').mockImplementation(async function (this: ReturnType<typeof createModels>, ...args) {
      const result = await original.apply(this, args)
      return result === undefined ? undefined : { ...result, env }
    })
    try {
      const fixture = await server()
      const connect = vi.fn(fixture.connect)
      fixture.connect = connect
      const { adapter: client } = adapter(fixture)
      const id = session()
      await run(client, id)
      await run(client, id)
      expect(connect.mock.calls[0]?.[2]).toBe('http://proxy.fixture:3128/')
      expect(connect).toHaveBeenCalledOnce()
      env = { HTTPS_PROXY: 'http://proxy.fixture:3129', NO_PROXY: '' }
      await run(client, id)
      expect(connect.mock.calls[1]?.[2]).toBe('http://proxy.fixture:3129/')
      env = { HTTPS_PROXY: 'http://proxy.fixture:3129', NO_PROXY: 'chatgpt.com' }
      await run(client, id)
      expect(connect.mock.calls[2]?.[2]).toBeUndefined()
      expect(fixture.handshakes).toHaveLength(3)
    } finally { spy.mockRestore() }
  })

  it('tunnels the maintained connector through an HTTP CONNECT proxy', async () => {
    const fixture = await server()
    const proxy = createServer()
    const requests: string[] = []
    proxy.on('connect', (request, downstream, head) => {
      requests.push(request.url ?? '')
      const port = Number(fixture.endpoint.split(':')[1])
      const upstream = connectTcp(port, '127.0.0.1', () => {
        downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        upstream.pipe(downstream)
        downstream.pipe(upstream)
      })
      downstream.on('close', () => { upstream.destroy() })
      upstream.on('error', () => { downstream.destroy() })
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const address = proxy.address()
    if (address === null || typeof address === 'string') throw new Error('proxy fixture lacks TCP port')
    const connector = subscriptionWebSocketConnector(1024)
    try {
      const socket = connector('ws://fixture.invalid/codex/responses', { 'x-proxy-fixture': 'yes' }, `http://127.0.0.1:${address.port}`)
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => { resolve() })
        socket.addEventListener('error', () => { reject(new Error('fixture proxy handshake failed')) })
      })
      expect(requests).toEqual(['fixture.invalid:80'])
      expect(fixture.handshakes[0]?.headers['x-proxy-fixture']).toBe('yes')
    } finally {
      await connector.dispose()
      await new Promise<void>((resolve) => { proxy.close(() => { resolve() }) })
    }
  })

  it('refuses WebSocket redirects and retains authenticated HTTP fallback', async () => {
    const fixture = await server()
    fixture.state.redirect = true
    const { adapter: client } = adapter(fixture)
    expect((await run(client, session())).at(-1)).toMatchObject({ reason: { kind: 'stop' } })
    expect(fixture.handshakes).toHaveLength(1)
    expect(fixture.httpRequests).toHaveLength(1)
  })

  it('handles SDK connection timeout while CONNECTING without an unhandled ws error', async () => {
    const fixture = await server()
    fixture.state.hold = true
    const models = createModels(auth())
    for (const provider of builtinProviders()) models.setProvider(provider)
    const model = models.getModel('openai-codex', 'gpt-5.5')
    if (model === undefined) throw new Error('fixture model missing')
    const request = { provider: 'openai-codex' as const, model: model.id, harnessUserAgent: UA, timeoutMs: 60000 }
    const result = await models.streamSimple(model, { messages: [] }, {
      transport: 'auto', sessionId: session(), websocketConnectTimeoutMs: 100,
      websocketFactory: subscriptionWebSocket(request, fixture.connect),
      fetch: subscriptionFetch(request, fixture.fetch),
    }).result()
    expect(result.stopReason).toBe('stop')
    expect(fixture.httpRequests).toHaveLength(1)
    await fixture.constructor.dispose()
  })
})
