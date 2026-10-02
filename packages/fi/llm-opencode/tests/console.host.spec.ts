import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import LlmRuntime, { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { OpenCodeAdapter, OPENCODE_KEY, resolveConsoleGrant } from '../src/index.ts'
import OpenCodeService from '../src/index.ts'
import { registerConsoleFlow } from '../src/oauth.ts'
import { projectCatalog } from '../src/catalog.ts'
import { consoleJson, consoleUrl } from '../src/protocol.ts'
import type { ConsoleGrant, ConsoleOptions } from '../src/protocol.ts'
import { liveConfig } from '../../../settings/settings/tests/live-config.ts'

const sleeps = vi.hoisted(() => [] as number[])
vi.mock('node:timers/promises', () => ({ setTimeout: (ms: number, _value: undefined, opts: { signal: AbortSignal }) => {
  opts.signal.throwIfAborted()
  sleeps.push(ms)
  return Promise.resolve()
} }))

const config: ConsoleOptions = {
  server: 'https://opencode.ai/console', clientId: 'opencode-cli', userAgent: 'opencode/latest/2.0.20/cli',
  requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000, refreshMarginMs: 120_000,
  defaultContextWindow: 128_000, defaultMaxTokens: 8192,
}
const seed: ConsoleGrant = {
  type: 'oauth', server: config.server, access: 'test-access', refresh: 'test-refresh',
  expires: Date.now() + 3_600_000, email: 'test@example.test', accountId: 'test-account', orgId: 'org-z', orgName: 'Z',
}
const dirs: string[] = []
const contexts: Context[] = []
const json = (value: unknown, status = 200): Response => Response.json(value, { status })

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'fi-opencode-'))
  dirs.push(dir)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, 'credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(LlmRuntime)
  return ctx
}

function catalog(packageName = '@ai-sdk/openai-compatible') {
  return { providers: { opencode: { package: packageName, settings: { baseURL: 'https://opencode.ai/zen/v1' },
    models: { friendly: { modelID: 'wire-model', name: 'Friendly', capabilities: { input: ['text'], output: ['text'] },
      limit: { context: 64_000, output: 2048 } } } } } }
}

function script(handler: (request: Request) => Response | Promise<Response>) {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => handler(new Request(input, init))))
}

afterEach(async () => {
  vi.unstubAllGlobals()
  sleeps.length = 0
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('OpenCode Console login and refresh', () => {
  it('polls pending and slow-down, stores the browser-selected organization', async () => {
    const ctx = await harness()
    let polls = 0
    script(async (request) => {
      if (request.url.endsWith('/device/code')) {
        expect(await request.json()).toEqual({ client_id: 'opencode-cli', supports_org_scope: true })
        return json({ device_code: 'device', user_code: 'ABCD', verification_uri_complete: '/console/authorize?code=ABCD', expires_in: 60, interval: 1 })
      }
      if (request.url.endsWith('/device/token')) {
        polls++
        if (polls === 1) return json({ error: 'authorization_pending' }, 400)
        if (polls === 2) return json({ error: 'slow_down' }, 400)
        return json({ access_token: seed.access, refresh_token: seed.refresh, expires_in: 3600, org_id: 'org-z' })
      }
      expect(request.headers.get('authorization')).toBe('Bearer test-access')
      if (request.url.endsWith('/user')) return json({ id: seed.accountId, email: seed.email })
      return json([{ id: 'org-a', name: 'A' }, { id: 'org-z', name: 'Z' }])
    })
    registerConsoleFlow(ctx, () => config)
    const notices: unknown[] = []
    await ctx.authorization.begin({ key: OPENCODE_KEY, interaction: { notify: (notice) => { notices.push(notice) }, prompt: () => Promise.reject(new Error('unexpected prompt')) } })
    expect(sleeps).toEqual([1000, 1000, 6000])
    expect(notices).toEqual([{ message: 'Open this page and authorize your OpenCode Console organization.', url: 'https://opencode.ai/console/authorize?code=ABCD', code: 'ABCD' }])
    expect(await ctx.credentials.readRecord(OPENCODE_KEY)).toMatchObject({ kind: 'grant', payload: { orgId: 'org-z', orgName: 'Z', access: seed.access } })
  })

  it.each(['https://evil.example/authorize', 'https://opencode.ai@evil.example/authorize', 'http://opencode.ai/authorize'])('refuses unsafe verification URL %s before polling', async (url) => {
    const ctx = await harness()
    script(() => json({ device_code: 'd', user_code: 'C', verification_uri_complete: url, expires_in: 60, interval: 1 }))
    registerConsoleFlow(ctx, () => config)
    await expect(ctx.authorization.begin({ key: OPENCODE_KEY, interaction: { notify: () => {}, prompt: () => Promise.reject(new Error('unexpected prompt')) } })).rejects.toThrow()
    expect(await ctx.credentials.readRecord(OPENCODE_KEY)).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('cancellation during account discovery leaves no grant', async () => {
    const ctx = await harness()
    script((request) => {
      if (request.url.endsWith('/code')) return json({ device_code: 'd', user_code: 'C', verification_uri_complete: '/authorize', expires_in: 60, interval: 1 })
      if (request.url.endsWith('/token')) return json({ access_token: 'a', refresh_token: 'r', expires_in: 3600 })
      ctx.authorization.cancel(OPENCODE_KEY)
      return request.url.endsWith('/user') ? json({ id: 'u', email: 'e' }) : json([])
    })
    registerConsoleFlow(ctx, () => config)
    await expect(ctx.authorization.begin({ key: OPENCODE_KEY, interaction: { notify: () => {}, prompt: () => Promise.reject(new Error('unexpected prompt')) } })).resolves.toEqual({ status: 'cancelled' })
    expect(await ctx.credentials.readRecord(OPENCODE_KEY)).toBeUndefined()
  })

  it('serializes concurrent refresh and persists changed token organization', async () => {
    const ctx = await harness()
    await ctx.credentials.modifyRecord(OPENCODE_KEY, async () => ({ kind: 'grant', payload: { ...seed, expires: 0 } }))
    script(async (request) => {
      expect(await request.json()).toEqual({ client_id: config.clientId, grant_type: 'refresh_token', refresh_token: seed.refresh })
      return json({ access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 3600, org_id: 'org-new' })
    })
    const grants = await Promise.all([resolveConsoleGrant(ctx, config), resolveConsoleGrant(ctx, config)])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(grants).toEqual([expect.objectContaining({ access: 'rotated', orgId: 'org-new', orgName: 'org-new', accountId: seed.accountId }), expect.objectContaining({ access: 'rotated' })])
  })

  it('persists a completed rotation when the caller cancels during refresh', async () => {
    const ctx = await harness()
    const payload = { ...seed, expires: 0 }
    await ctx.credentials.modifyRecord(OPENCODE_KEY, async () => ({ kind: 'grant', payload }))
    const abort = new AbortController()
    script(() => { abort.abort(); return json({ access_token: 'rotated', refresh_token: 'r', expires_in: 3600 }) })
    await expect(resolveConsoleGrant(ctx, config, abort.signal)).rejects.toThrow()
    await resolveConsoleGrant(ctx, config)
    expect(await ctx.credentials.readRecord(OPENCODE_KEY)).toMatchObject({ kind: 'grant', payload: { access: 'rotated', refresh: 'r' } })
  })

  it('cancels a refresh waiter promptly while a shared rotation commits', async () => {
    const ctx = await harness()
    await ctx.credentials.modifyRecord(OPENCODE_KEY, async () => ({ kind: 'grant', payload: { ...seed, expires: 0 } }))
    const started = Promise.withResolvers<undefined>()
    const response = Promise.withResolvers<Response>()
    const abort = new AbortController()
    script(() => { started.resolve(undefined); return response.promise })
    const first = resolveConsoleGrant(ctx, config, abort.signal)
    const rejected = expect(first).rejects.toThrow()
    await started.promise
    abort.abort()
    await rejected
    const second = resolveConsoleGrant(ctx, config)
    response.resolve(json({ access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 3600 }))
    await expect(second).resolves.toMatchObject({ access: 'rotated', refresh: 'rotated-refresh' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('OpenCode model routing', () => {
  it('retains provider-qualified IDs and strips credential and model-input overrides', () => {
    const data = catalog()
    const source = data.providers.opencode
    const extended = { providers: { a: { ...source, headers: { authorization: 'evil', 'x-org-id': 'evil', 'x-safe': 'yes' },
      body: { messages: ['evil'], tools: ['hidden'], apiKey: 'evil', temperature: 0.4 } }, b: source } }
    const models = projectCatalog(extended, 'opencode-console', config)
    expect(models.map(entry => entry.model.id)).toEqual(['a/friendly', 'b/friendly'])
    expect(models[0]).toMatchObject({ wireId: 'wire-model', headers: { 'x-safe': 'yes' }, body: { temperature: 0.4 } })
    expect(() => projectCatalog({ providers: { opencode: { ...source, settings: { baseURL: 'https://evil.example' } } } }, 'opencode-console', config)).toThrow()
    expect(() => consoleUrl('https://opencode.ai/?url=evil')).toThrow()
  })

  it('excludes disabled, nontext input/output, deprecated, and unsupported protocol models', () => {
    const source = catalog().providers.opencode
    const data = { providers: { opencode: { ...source, models: {
      ...source.models, disabled: { disabled: true }, deprecated: { status: 'deprecated' },
      image: { capabilities: { output: ['image'] } }, imageInput: { capabilities: { input: ['image'], output: ['text'] } },
      emptyInput: { capabilities: { input: [], output: ['text'] } }, unsupported: { package: '@ai-sdk/google' },
    } } } }
    expect(projectCatalog(data, 'opencode-console', config).map(entry => entry.model.id)).toEqual(['friendly'])
  })

  it('mounts dormant routes, discovers the signed-in account, and disposes registrations', async () => {
    const ctx = await harness()
    const live = await liveConfig(ctx, OpenCodeService, {}, 'fi-opencode')
    expect(ctx.authorization.list().find(flow => flow.key === OPENCODE_KEY)?.label).toBe('OpenCode Console')
    expect(ctx.llm.listConfigurableProviders()).toContainEqual(expect.objectContaining({ provider: 'opencode-console', settingsNs: 'fi-opencode' }))
    expect(ctx.llm.listProviders()).toEqual([])
    await live.update({ providers: { 'opencode-console': {} } })
    expect(ctx.llm.listProviders()).toContainEqual(expect.objectContaining({ id: 'opencode-console' }))
    await ctx.credentials.modifyRecord(OPENCODE_KEY, async () => ({ kind: 'grant', payload: seed }))
    script((request) => { expect(request.headers.get('x-org-id')).toBe(seed.orgId); return json(catalog()) })
    expect(await ctx.llm.discoverModels('fi-opencode', { provider: 'opencode-console' })).toEqual([{ id: 'friendly', name: 'Friendly' }])
    await live.replace({ providers: {} })
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('freezes catalog, credentials, and wire ID at preparation; streams actual chat SSE', async () => {
    let current = seed
    const adapter = new OpenCodeAdapter(() => config, () => Promise.resolve(current))
    const bodies: unknown[] = []
    script(async (request) => {
      if (request.method === 'GET') return json(catalog())
      expect(request.url).toBe('https://opencode.ai/zen/v1/chat/completions')
      expect(request.headers.get('authorization')).toBe(`Bearer ${seed.access}`)
      expect(request.headers.get('x-org-id')).toBe(seed.orgId)
      expect(request.headers.get('x-opencode-session')).toMatch(/^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$/)
      bodies.push(await request.json())
      return new Response('data: {"id":"r","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: {"id":"r","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    const prepared = await adapter.prepareCall('opencode-console', 'friendly')
    current = { ...seed, access: 'other-account', orgId: 'other-org' }
    const chunks = []
    for await (const chunk of prepared.stream({ provider: 'opencode-console', model: 'friendly', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }] })) chunks.push(chunk)
    expect(bodies).toEqual([expect.objectContaining({ model: 'wire-model', stream: true })])
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'Hello' }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('surfaces SSO and revoked-grant instructions without leaking provider response fields', async () => {
    script(() => json({ _tag: 'SsoRequired', secret: 'should-not-leak' }, 403))
    await expect(consoleJson(config, '/api/v2/config', {})).rejects.toThrow('requires SSO')
    script(() => json({ error: 'invalid_grant', secret: 'should-not-leak' }, 400))
    await expect(consoleJson(config, '/auth/device/token', {})).rejects.toThrow('reconnect')
  })

  it.each(['@ai-sdk/openai-compatible', '@ai-sdk/openai', '@ai-sdk/anthropic'])(
    'preserves safe policy and SSO recovery through %s while retaining genuine authentication errors', async (packageName) => {
      const adapter = new OpenCodeAdapter(() => config, () => Promise.resolve(seed))
      for (const { body, status, code, message } of [
        { body: { error: { type: 'FreeTierError', message: 'should-not-leak' } }, status: 403, code: 'POLICY_REJECTED', message: 'OpenCode free-tier policy rejected this request; select another Console model or use the official OpenCode client' },
        { body: { _tag: 'SsoRequired', secret: 'should-not-leak' }, status: 403, code: 'SSO_REQUIRED', message: 'OpenCode organization requires SSO; reconnect OpenCode Console' },
        { body: { error: { type: 'SsoRequired', message: 'should-not-leak' } }, status: 403, code: 'SSO_REQUIRED', message: 'OpenCode organization requires SSO; reconnect OpenCode Console' },
        { body: { error: { type: 'AuthenticationError', message: 'Invalid token' } }, status: 401, code: 'AUTH', message: undefined },
      ]) {
        let requests = 0
        script((request) => {
          if (request.method === 'GET') return json(catalog(packageName))
          requests++
          return json(body, status)
        })
        const chunks = []
        for await (const chunk of adapter.stream({ provider: 'opencode-console', model: 'friendly', messages: [] })) chunks.push(chunk)
        const finish = chunks.at(-1)
        expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code, ...message === undefined ? {} : { message, status } } } })
        if (message !== undefined) expect(JSON.stringify(finish)).not.toContain('should-not-leak')
        expect(requests).toBe(1)
      }
    },
  )

  it.each([
    { body: '{invalid JSON', status: 403, code: 'AUTH' },
    { body: JSON.stringify({ error: { type: 'FreeTierError' } }), status: 500, code: 'SERVER' },
    { body: JSON.stringify({ error: { type: 'OtherError', message: 'FreeTierError' } }), status: 403, code: 'AUTH' },
  ])('retains shared error mapping for unrecognized responses: $status $body', async ({ body, status, code }) => {
    const adapter = new OpenCodeAdapter(() => config, () => Promise.resolve(seed))
    script(request => request.method === 'GET' ? json(catalog()) : new Response(body, { status }))
    const chunks = []
    for await (const chunk of adapter.stream({ provider: 'opencode-console', model: 'friendly', messages: [] })) chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code } } })
  })

  it('continues a tool turn with recorded schemas and the selected replay model', async () => {
    const adapter = new OpenCodeAdapter(() => config, () => Promise.resolve(seed))
    let calls = 0
    script(async (request) => {
      if (request.method === 'GET') return json(catalog())
      const body = z.object({
        model: z.string(), tools: z.array(z.object({ function: z.object({ name: z.string() }) })), messages: z.array(z.unknown()),
      }).parse(await request.json())
      expect(body.tools.map((tool: { function: { name: string } }) => tool.function.name)).toEqual(['lookup'])
      calls++
      if (calls === 1) return new Response('data: {"id":"r1","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{\\"key\\":\\"a\\"}"}}]},"finish_reason":null}]}\n\ndata: {"id":"r1","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
      expect(body.model).toBe('wire-model')
      expect(body.messages).toContainEqual(expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ id: 'call-1', function: { name: 'lookup', arguments: '{"key":"a"}' } })] }))
      expect(body.messages).toContainEqual(expect.objectContaining({ role: 'tool', tool_call_id: 'call-1', content: 'found a' }))
      return new Response('data: {"id":"r2","choices":[{"index":0,"delta":{"content":"Done"},"finish_reason":null}]}\n\ndata: {"id":"r2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
    })
    const options: import('@deepseek-ai/dsh-llm').GenerateOptions = {
      provider: 'opencode-console', model: 'friendly', messages: [{ role: 'user', content: [{ type: 'text', text: 'Look up a' }] }],
      tools: [{ name: 'lookup', description: 'Look up a key', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } }],
    }
    const first = new BlockAssembler()
    for await (const chunk of adapter.stream(options)) first.push(chunk)
    expect(first.finish).toEqual({ kind: 'tool-calls' })
    const assistant = first.message({ provider: options.provider, model: options.model, replayState: first.replayState })
    const call = assistant.content.find(block => block.type === 'tool-call')
    if (call?.type !== 'tool-call') throw new Error('missing scripted tool call')
    const second = new BlockAssembler()
    for await (const chunk of adapter.stream({ ...options, messages: [...options.messages, assistant, createToolResultMessage({ callId: call.id, content: [{ type: 'text', text: 'found a' }], isError: false })] })) second.push(chunk)
    expect(second.message({ provider: options.provider, model: options.model }).content).toEqual([{ type: 'text', text: 'Done' }])
    expect(second.replayState).toMatchObject({ response: { provider: 'opencode-console', model: 'friendly' } })
    expect(calls).toBe(2)
  })

  it('aborts the SDK request when the stream consumer stops early', async () => {
    const adapter = new OpenCodeAdapter(() => config, () => Promise.resolve(seed))
    let transportSignal: AbortSignal | undefined
    script((request) => {
      if (request.method === 'GET') return json(catalog())
      transportSignal = request.signal
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"id":"r","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'))
        request.signal.addEventListener('abort', () => { controller.close() }, { once: true })
      } })
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    })
    const iterator = adapter.stream({ provider: 'opencode-console', model: 'friendly', messages: [] })[Symbol.asyncIterator]()
    expect((await iterator.next()).done).toBe(false)
    await iterator.return?.()
    expect(transportSignal?.aborted).toBe(true)
  })

  it('rejects organization policies it cannot evaluate', () => {
    expect(() => projectCatalog({ ...catalog(), experimental: { policies: [{ effect: 'deny' }] } }, 'opencode-console', config)).toThrow('official OpenCode client')
  })

  it('rejects stop sequences before issuing inference', async () => {
    const adapter = new OpenCodeAdapter(() => config, () => Promise.resolve(seed))
    script(() => json(catalog()))
    const stream = adapter.stream({ provider: 'opencode-console', model: 'friendly', messages: [], stop: ['END'] })[Symbol.asyncIterator]()
    await expect(stream.next()).rejects.toThrow('stop sequences are unsupported')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(['@ai-sdk/anthropic', '@ai-sdk/openai'])('streams %s without sending Console credentials to another host', async (packageName) => {
    const adapter = new OpenCodeAdapter(() => config, () => Promise.resolve(seed))
    script(async (request) => {
      if (request.method === 'GET') return json(catalog(packageName))
      expect(z.object({ model: z.string() }).parse(await request.json()).model).toBe('wire-model')
      if (packageName === '@ai-sdk/anthropic') {
        expect(new URL(request.url).pathname).toBe('/zen/v1/messages')
        expect(request.headers.get('x-api-key')).toBe(seed.access)
        const events = [
          { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'wire-model', content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'PONG' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' },
        ]
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
      expect(request.url).toBe('https://opencode.ai/zen/v1/responses')
      expect(request.headers.get('authorization')).toBe(`Bearer ${seed.access}`)
      const item = { type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'PONG', annotations: [] }] }
      const events = [
        { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'PONG' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6 } } },
      ]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    })
    const chunks: import('@deepseek-ai/dsh-llm').StreamChunk[] = []
    for await (const chunk of adapter.stream({ provider: 'opencode-console', model: 'friendly', messages: [{ role: 'user', content: [{ type: 'text', text: 'PONG' }] }] })) chunks.push(chunk)
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', text: 'PONG' }))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' }, replayState: { response: { provider: 'opencode-console', model: 'friendly' } } })
  })
})
