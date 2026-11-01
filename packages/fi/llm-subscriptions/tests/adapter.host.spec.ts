/** The subscription adapter over scripted provider endpoints: catalogs, Kiro thinking, quota hints, and Cursor rounds. */
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { BlockAssembler, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SubscriptionAdapter } from '../src/adapter.ts'
import type { SubscriptionGrant, SubscriptionOptions } from '../src/protocol.ts'
import { awsFrame, checkpointFrame, chunks, collect, concat, cursorServer, mcpFrame, mcpResultText, textFrame, turnEnded } from './harness.ts'
import { decodeProto } from '../src/native/subscription-protobuf.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const options: SubscriptionOptions = {
  requestTimeoutMs: 2000,
  streamIdleTimeoutMs: 2000,
  authTimeoutMs: 2000,
  pollIntervalMs: 1,
  refreshMarginMs: 60_000,
  defaultContextWindow: 32768,
  defaultMaxTokens: 1024,
  kiroRegion: 'us-east-1',
  geminiProjectId: '',
  geminiClientId: 'client',
  geminiClientSecret: 'secret',
  geminiCallbackPort: 45289,
}
const grantOf = (provider: SubscriptionGrant['provider'], extra: Partial<SubscriptionGrant> = {}): SubscriptionGrant => ({
  provider, accessToken: `${provider}-token`, refreshToken: '', expiresAt: '2099-01-01T00:00:00.000Z', ...extra,
})
type Profiles = Record<string, { displayName?: string; models?: string[] }>
function adapterFor(grant: SubscriptionGrant | undefined, profile: Profiles = {}, config = options) {
  const adapter = new SubscriptionAdapter(() => config, () => Promise.resolve(grant), provider => profile[provider])
  onTestFinished(() => adapter.dispose())
  return adapter
}
type Handler = (request: Request, signal: AbortSignal) => Response | Promise<Response>
function script(handler: Handler) {
  const seen: Request[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    seen.push(request.clone())
    return handler(request, init?.signal ?? request.signal)
  }))
  return seen
}
const user = (text: string): GenerateOptions['messages'][number] => ({ role: 'user', content: [{ type: 'text', text }] })
const run = (adapter: SubscriptionAdapter, provider: string, model: string, extra: Partial<GenerateOptions> = {}) =>
  collect(adapter.stream({ provider, model, maxTokens: 256, messages: [user('ping')], ...extra }))
const sse = (...events: unknown[]) => new Response(`${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
const chat = (content: string) => sse({ choices: [{ index: 0, delta: { content }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
const kiroModels = { models: [{ modelId: 'claude-sonnet-4.5' }, { modelId: 'deepseek-3.2' }, { modelId: 'auto' }] }
const awsResponse = (...frames: Buffer[]) => new Response(chunks(concat(...frames), 64), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } })
const kiroReply = (...frames: Buffer[]) => awsResponse(...frames, awsFrame('messageStopEvent', { stopReason: 'end_turn' }))
const text = (chunk: StreamChunk[]) => chunk.flatMap(entry => entry.type === 'text-delta' ? [entry.text] : []).join('')
const finish = (chunk: StreamChunk[]) => chunk.at(-1)

it('names routes, filters the picker, resolves models, and refuses unknown routes and models', async () => {
  const claude = grantOf('cline')
  script(() => Response.json({ free: [{ id: 'cline-free/a' }, { id: 'cline-free/b' }], clinePass: [] }))
  const adapter = adapterFor(claude, { cline: { displayName: 'My Cline', models: ['cline-free/b'] }, kiro: {} })
  expect(adapter.providerInfo('cline')).toEqual({ id: 'cline', name: 'My Cline' })
  expect(adapter.providerInfo('kiro')).toEqual({ id: 'kiro', name: 'kiro' })
  expect((await adapter.listModels('cline')).map(model => model.id)).toEqual(['cline-free/b'])
  expect((await adapter.discoverModels('cline')).map(model => model.id)).toEqual(['cline-free/a', 'cline-free/b'])
  expect((await adapterFor(undefined).discoverModels('cline'))).toEqual([])
  expect((await adapterFor(undefined).listModels('cline'))).toEqual([])
  expect(() => adapter.providerInfo('nope')).toThrow('Unknown subscription provider')
  expect(() => adapter.resolveModel('nope', 'm')).toThrow('Unknown subscription provider')
  await expect(adapter.prepareCall('cline', 'cline-free/missing')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  await expect(adapterFor(undefined).prepareCall('cline', 'cline-free/a')).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
  await expect(adapterFor(undefined).prepareCall('cline', 'cline-free/a')).rejects.toThrow('Settings')
  const aborted = new AbortController()
  aborted.abort()
  expect(() => adapter.resolveModel('cline', 'cline-free/a', aborted.signal)).toThrow()
  expect(await adapter.resolveModel('cline', 'cline-free/a')).toEqual({
    provider: 'cline', id: 'cline-free/a', name: 'cline-free/a', inputModalities: ['text'], context: { contextWindow: 32768 },
  })
  const prepared = await adapter.prepareCall('cline', 'cline-free/a')
  expect(prepared.model).toMatchObject({ id: 'cline-free/a' })
  // A prepared call is bound to its model.
  await expect(collect(prepared.stream({ provider: 'cline', model: 'cline-free/b', messages: [user('x')] }))).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
})

it('offers reasoning efforts only for Kiro thinking models', async () => {
  const adapter = adapterFor(grantOf('kiro'))
  script(() => Response.json(kiroModels))
  const efforts = (id: string) => adapter.resolveModel('kiro', id).then(model => model.reasoning?.efforts.map(effort => effort.id))
  expect(await efforts('claude-sonnet-4.5')).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  expect(await efforts('auto')).toHaveLength(6)
  expect(await efforts('deepseek-3.2')).toBeUndefined()
  expect((await adapter.prepareCall('kiro', 'claude-sonnet-4.5')).model.reasoning?.efforts[0]).toEqual({ id: 'minimal', name: 'Minimal' })
  expect((await adapter.prepareCall('kiro', 'deepseek-3.2')).model.reasoning).toBeUndefined()
  expect((await adapterFor(grantOf('cline')).resolveModel('cline', 'claude-sonnet-4.5')).reasoning).toBeUndefined()
})

it('streams Kiro reasoning and text, sends the thinking tag for a chosen effort, and rejects unsupported controls', async () => {
  const bodies: string[] = []
  const seen = script(async (request) => {
    if (request.url.includes('ListAvailableModels')) return Response.json(kiroModels)
    bodies.push(await request.text())
    return kiroReply(
      awsFrame('reasoningContentEvent', { text: 'plan' }),
      awsFrame('assistantResponseEvent', { content: 'FI_READY' }),
      awsFrame('metadataEvent', { tokenUsage: { outputTokens: 4, uncachedInputTokens: 6, cacheReadInputTokens: 2 } }),
    )
  })
  const adapter = adapterFor(grantOf('kiro', { subscriptionAuth: { clientId: 'client' } }))
  const chunks = await run(adapter, 'kiro', 'claude-sonnet-4.5', {
    reasoningEffort: 'high' as NonNullable<GenerateOptions['reasoningEffort']>, temperature: 0.2, signal: AbortSignal.timeout(10_000),
  })
  expect(text(chunks)).toBe('FI_READY')
  expect(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'plan')).toBe(true)
  expect(finish(chunks)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  expect(JSON.stringify(chunks)).toContain('"outputTokens":4')
  expect(bodies[0]).toContain('<thinking_mode>enabled</thinking_mode>')
  expect(bodies[0]).toContain('<max_thinking_length>16000</max_thinking_length>')
  const generate = seen.find(request => request.url.endsWith('generateAssistantResponse'))
  expect(generate?.headers.get('user-agent')).toContain('codewhispererstreaming')
  const plain = await run(adapter, 'kiro', 'claude-sonnet-4.5')
  expect(text(plain)).toBe('FI_READY')
  expect(bodies[1]).not.toContain('thinking_mode')
  for (const [model, extra] of [
    ['deepseek-3.2', { reasoningEffort: 'high' }],
    ['claude-sonnet-4.5', { reasoningEffort: 'extreme' }],
    ['claude-sonnet-4.5', { stop: ['x'] }],
  ] as const)
    await expect(run(adapter, 'kiro', model, extra as unknown as Partial<GenerateOptions>)).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
  const cline = adapterFor(grantOf('cline'))
  script(() => Response.json({ free: [{ id: 'cline-free/a' }], clinePass: [] }))
  await expect(run(cline, 'cline', 'cline-free/a', { reasoningEffort: 'high' as NonNullable<GenerateOptions['reasoningEffort']> })).rejects.toMatchObject({ code: 'UNSUPPORTED_OPTION' })
})

it('reports a failed Kiro tool result as an error to the service', async () => {
  interface Sent {
    conversationState: { currentMessage: { userInputMessage: { userInputMessageContext?: { toolResults?: { status: string }[] } } } }
  }
  const bodies: Sent[] = []
  let turn = 0
  script(async (request) => {
    if (request.url.includes('ListAvailableModels')) return Response.json(kiroModels)
    bodies.push(JSON.parse(await request.text()) as (typeof bodies)[number])
    return ++turn === 1
      ? kiroReply(awsFrame('toolUseEvent', { toolUseId: 'tool-1', name: 'get_status', input: '{}' }))
      : kiroReply(awsFrame('assistantResponseEvent', { content: 'done' }))
  })
  const adapter = adapterFor(grantOf('kiro'))
  const tools = [{ name: 'get_status', description: 'Read status', parameters: { type: 'object', properties: {} } }]
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream({ provider: 'kiro', model: 'claude-sonnet-4.5', messages: [user('go')], tools })) assembler.push(chunk)
  const assistant = assembler.message({ provider: 'kiro', model: 'claude-sonnet-4.5', replayState: assembler.replayState })
  const call = assistant.content.find(block => block.type === 'tool-call')
  if (call?.type !== 'tool-call') throw new Error('Kiro returned no tool call')
  const result = createToolResultMessage({ callId: call.id, isError: true, content: [{ type: 'text', text: 'boom' }] })
  const second = await collect(adapter.stream({ provider: 'kiro', model: 'claude-sonnet-4.5', messages: [user('go'), assistant, result], tools }))
  expect(text(second)).toBe('done')
  expect(bodies[1]?.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.map(entry => entry.status)).toEqual(['error'])
  // A result that does not say it failed, and one that says it did not, are successes.
  turn = 0
  for (const isError of [undefined, false]) {
    const { isError: _flag, ...unflagged } = createToolResultMessage({ callId: call.id, isError: false, content: [{ type: 'text', text: 'fine' }] })
    const message = isError === undefined ? unflagged : { ...unflagged, isError }
    turn = 1
    await collect(adapter.stream({ provider: 'kiro', model: 'claude-sonnet-4.5', messages: [user('go'), assistant, message], tools }))
  }
  expect(bodies.slice(2).map(body => body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults?.map(entry => entry.status))).toEqual([['success'], ['success']])
})

it('carries provider reset hints on rate-limit failures and reports revoked credentials', async () => {
  const adapter = adapterFor(grantOf('cline'))
  const respond = (status: number, headers: Record<string, string> = {}) => script((request) => {
    if (request.url.endsWith('recommended-models')) return Response.json({ free: [{ id: 'cline-free/a' }], clinePass: [] })
    return new Response('{"error":{"message":"nope"}}', { status, headers: { 'content-type': 'application/json', ...headers } })
  })
  const failure = async () => (finish(await run(adapter, 'cline', 'cline-free/a')) as unknown as { reason: { kind: string; failure: Record<string, unknown> } }).reason.failure
  respond(429, { 'retry-after': '7' })
  expect(await failure()).toMatchObject({ code: 'RATE_LIMIT', status: 429, providerRetryAfterMs: 7000 })
  respond(429, { 'retry-after': new Date(Date.now() + 90_000).toUTCString() })
  expect(((await failure()).providerRetryAfterMs as number)).toBeGreaterThan(60_000)
  respond(429)
  expect(await failure()).not.toHaveProperty('providerRetryAfterMs')
  respond(429, { 'retry-after': 'soon' })
  expect(await failure()).not.toHaveProperty('providerRetryAfterMs')
  respond(503, { 'retry-after': '5' })
  expect(await failure()).toMatchObject({ code: 'SERVER', status: 503, providerRetryAfterMs: 5000 })
  respond(500)
  expect(await failure()).not.toHaveProperty('providerRetryAfterMs')
  respond(401)
  expect(await failure()).toMatchObject({ code: 'CREDENTIAL_REVOKED', status: 401 })
})

it('streams Copilot with conversation identity and turns premium quota exhaustion into a retry hint', async () => {
  const github = grantOf('copilot', { refreshToken: 'github-token', subscriptionAuth: { apiBase: 'https://api.individual.githubcopilot.com' } })
  const reset = new Date(Date.now() + 2 * 86_400_000).toISOString()
  let exhausted = false
  let calling = false
  const seen = script((request) => {
    if (request.url.endsWith('/models')) return Response.json({ data: [
      { id: 'gpt-4.1', capabilities: { type: 'chat' } },
      { id: 'hidden', capabilities: { type: 'chat' }, policy: { state: 'disabled' } },
    ] })
    return exhausted
      ? new Response('{"error":{"code":"quota_exceeded"}}', { status: 402, headers: { 'x-quota-snapshot-premium_interactions': `rem=0&ent=300&rst=${encodeURIComponent(reset)}` } })
      : calling
        ? sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_status', arguments: '{}' } }] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        : chat('PONG')
  })
  const adapter = adapterFor(github)
  expect((await adapter.discoverModels('copilot')).map(model => model.id)).toEqual(['gpt-4.1'])
  await expect(run(adapter, 'copilot', 'hidden')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  const sessionId = 'session-1' as NonNullable<GenerateOptions['sessionId']>
  const first = await run(adapter, 'copilot', 'gpt-4.1', { sessionId })
  expect(text(first)).toBe('PONG')
  const completion = seen.find(request => request.url.endsWith('/chat/completions'))
  expect(completion?.headers.get('x-initiator')).toBe('user')
  expect(completion?.headers.get('x-interaction-id')).toMatch(/^[0-9a-f-]{36}$/)
  expect(completion?.headers.get('editor-version')).toBe('vscode/1.144.0')
  // A tool round continues the agent turn rather than starting a user one.
  calling = true
  const tools = [{ name: 'get_status', description: 'Read status', parameters: { type: 'object', properties: {} } }]
  const assembler = new BlockAssembler()
  for await (const chunk of adapter.stream({ provider: 'copilot', model: 'gpt-4.1', messages: [user('go')], tools })) assembler.push(chunk)
  const assistant = assembler.message({ provider: 'copilot', model: 'gpt-4.1', replayState: assembler.replayState })
  const call = assistant.content.find(block => block.type === 'tool-call')
  if (call?.type !== 'tool-call') throw new Error('Copilot returned no tool call')
  calling = false
  const result = createToolResultMessage({ callId: call.id, isError: false, content: [{ type: 'text', text: 'ok' }] })
  expect(text(await collect(adapter.stream({ provider: 'copilot', model: 'gpt-4.1', messages: [user('go'), assistant, result], tools })))).toBe('PONG')
  expect(seen.filter(request => request.url.endsWith('/chat/completions')).at(-1)?.headers.get('x-initiator')).toBe('agent')
  exhausted = true
  const quota = (finish(await run(adapter, 'copilot', 'gpt-4.1')) as { reason: { failure: { providerRetryAfterMs: number; status: number } } }).reason.failure
  expect(quota.status).toBe(429)
  expect(quota.providerRetryAfterMs).toBeGreaterThan(2 * 86_400_000 - 10_000)
  expect(quota.providerRetryAfterMs).toBeLessThanOrEqual(2 * 86_400_000)
})

it('fails a stream that stalls past the idle deadline', async () => {
  script((request, signal) => request.url.endsWith('recommended-models')
    ? Response.json({ free: [{ id: 'cline-free/a' }], clinePass: [] })
    : new Promise<Response>((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason as Error) }) }))
  const adapter = adapterFor(grantOf('cline'), {}, { ...options, streamIdleTimeoutMs: 50, requestTimeoutMs: 5000 })
  await expect(run(adapter, 'cline', 'cline-free/a')).rejects.toMatchObject({ code: 'TIMEOUT' })
})

it('answers a Cursor tool round on one native Run and reports the failed result', async () => {
  const results: ReturnType<typeof mcpResultText>[] = []
  await cursorServer((stream, data) => {
    const packet = decodeProto(data.subarray(5))
    if (packet.has(1)) stream.write(concat(textFrame('looking'), mcpFrame(7, 'native', {}, 'get_status'), checkpointFrame()))
    else {
      results.push(mcpResultText(packet))
      stream.write(concat(textFrame('FI_READY'), turnEnded({ input: 5, output: 2 })))
    }
  }, { onStream: (stream, headers) => {
    if (!String(headers[':path']).endsWith('GetUsableModels')) return undefined
    stream.respond({ ':status': 200 })
    stream.end(Buffer.from('\n\u0009\n\u0007default'))
    return true
  } })
  const adapter = adapterFor(grantOf('cursor', { subscriptionAuth: { machineId: 'machine' } }))
  const tools = [{ name: 'get_status', description: 'Read status', parameters: { type: 'object', properties: {} } }]
  const assembler = new BlockAssembler()
  const first: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider: 'cursor', model: 'default', messages: [user('go')], tools, maxTokens: 256 })) {
    first.push(chunk)
    assembler.push(chunk)
  }
  const assistant = assembler.message({ provider: 'cursor', model: 'default', replayState: assembler.replayState })
  const call = assistant.content.find(block => block.type === 'tool-call')
  if (call?.type !== 'tool-call') throw new Error('Cursor returned no tool call')
  const result = createToolResultMessage({ callId: call.id, isError: true, content: [{ type: 'text', text: 'it broke' }] })
  const second = await collect(adapter.stream({ provider: 'cursor', model: 'default', messages: [user('go'), assistant, result], tools, maxTokens: 256 }))
  expect(text(second)).toBe('FI_READY')
  expect(results).toEqual([{ id: 7, execId: 'exec-7', text: 'it broke', isError: 1 }])
  expect(JSON.stringify(finish(second))).toContain('"stop"')
})
