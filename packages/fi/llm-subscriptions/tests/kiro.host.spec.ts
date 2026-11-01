/** Kiro identity, thinking, usage, quota, and local output-limit behavior. */
import { afterEach, expect, it, vi } from 'vitest'
import {
  annotateKiroFailure,
  callKiro,
  kiroEvents,
  kiroHeaders,
  kiroRequest,
  kiroThinkingBudget,
  kiroThinks,
} from '../src/native/kiro-api.ts'
import { NativeProtocolError, validateNativeControls } from '../src/native/subscription-stream.ts'
import type { NativeEvent } from '../src/native/subscription-stream.ts'
import type { SubscriptionGrant } from '../src/protocol.ts'
import { awsFrame, awsHeader, awsRaw, chunks, collect, concat } from './harness.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const grant: SubscriptionGrant = {
  provider: 'kiro',
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  expiresAt: '2099-01-01T00:00:00.000Z',
  subscriptionAuth: { clientId: 'client-a', clientSecret: 'client-secret' },
}
const withProfile: SubscriptionGrant = { ...grant, subscriptionAuth: { ...grant.subscriptionAuth, profileArn: 'arn:aws:codewhisperer:us-east-1:1:profile/X' } }
const stop = awsFrame('messageStopEvent', { stopReason: 'end_turn' })
const text = (content: string) => awsFrame('assistantResponseEvent', { content })
const reasoning = (value: string) => awsFrame('reasoningContentEvent', { text: value })
const run = (frames: Buffer[], options?: { inlineThinking?: boolean }, tools?: Set<string>, size = 7) =>
  collect(kiroEvents(chunks(concat(...frames), size), tools, options))
const deltas = (events: NativeEvent[], key: 'content' | 'reasoning_content') => events.flatMap(event => event.delta?.[key] ?? [])
const user = { role: 'user', content: 'hello' }
const tools = [{ type: 'function', function: { name: 'read', description: '', parameters: { type: 'object' } } }]

it('presents the AWS SDK identity, adding the IDE token only for accounts with a profile', () => {
  const plain = kiroHeaders(grant)
  expect(plain['User-Agent']).toMatch(/^aws-sdk-js\/1\.0\.27 ua\/2\.1 os\/\S+#\S+ lang\/js md\/nodejs#\S+ api\/codewhispererstreaming#1\.0\.27 m\/E$/)
  expect(plain['User-Agent']).not.toContain('KiroIDE')
  expect(plain['X-Amz-User-Agent']).toMatch(/^aws-sdk-js\/1\.0\.27 KiroIDE-1\.4\.62-[0-9a-f]{64}$/)
  expect(plain['x-amzn-kiro-agent-mode']).toBe('vibe')
  expect(plain['amz-sdk-request']).toBe('attempt=1; max=3')
  expect(plain).not.toHaveProperty('x-amzn-codewhisperer-profile-arn')
  const profile = kiroHeaders(withProfile, 'runtime')
  expect(profile['User-Agent']).toMatch(/api\/codewhispererruntime#1\.0\.0 m\/N,E KiroIDE-1\.4\.62-[0-9a-f]{64}$/)
  expect(profile['x-amzn-codewhisperer-profile-arn']).toContain('profile/X')
  // The machine token is stable per sign-in, differs between sign-ins, and never carries a secret.
  expect(kiroHeaders(grant)['X-Amz-User-Agent']).toBe(plain['X-Amz-User-Agent'])
  expect(kiroHeaders({ ...grant, subscriptionAuth: { clientId: 'client-b' } })['X-Amz-User-Agent']).not.toBe(plain['X-Amz-User-Agent'])
  expect(kiroHeaders({ ...grant, subscriptionAuth: { profileArn: 'p' } })['X-Amz-User-Agent']).toMatch(/KiroIDE/)
  expect(kiroHeaders({ ...grant, subscriptionAuth: undefined })['X-Amz-User-Agent']).toMatch(/KiroIDE/)
  expect(JSON.stringify(plain)).not.toContain('client-secret')
})

it('turns an effort into the thinking tag for thinking models only', () => {
  const body = { model: 'kiro/claude-sonnet-4.5', messages: [{ role: 'system', content: 'be brief' }, user] }
  for (const [effort, budget] of [['minimal', 1024], ['low', 4096], ['MEDIUM', 8192], ['high', 16000], ['xhigh', 32000], ['max', 32000]] as const) {
    const request = kiroRequest({ ...body, reasoning_effort: effort }, grant)
    expect(request.conversationState.currentMessage.userInputMessage?.content)
      .toBe(`<thinking_mode>enabled</thinking_mode>\n<max_thinking_length>${budget}</max_thinking_length>\n\nbe brief\n\nhello`)
  }
  const plain = kiroRequest(body, grant)
  expect(plain.conversationState.currentMessage.userInputMessage?.content).toBe('be brief\n\nhello')
  // Unknown efforts and models that would answer the tag as text keep the request unchanged.
  const stable = (request: ReturnType<typeof kiroRequest>) => ({ ...request, conversationState: { ...request.conversationState, conversationId: '' } })
  expect(stable(kiroRequest({ ...body, reasoning_effort: 'none' }, grant))).toEqual(stable(plain))
  expect(kiroRequest({ ...body, model: 'kiro/deepseek-3.2', reasoning_effort: 'high' }, grant).conversationState.currentMessage.userInputMessage?.content).toBe('be brief\n\nhello')
  expect(kiroRequest({ ...body, model: 'kiro/auto', reasoning_effort: 'low' }, grant).conversationState.currentMessage.userInputMessage?.content).toContain('4096')
  expect(kiroThinkingBudget({ ...body, reasoning_effort: 'constructor', tools: [] })).toBeUndefined()
  expect(kiroThinks('claude-opus-4.5')).toBe(true)
  expect(kiroThinks('auto')).toBe(true)
  expect(kiroThinks('auto-pro')).toBe(false)
})

it('marks failed tool results, fills empty user turns, and sends no output-limit block', () => {
  const request = kiroRequest({
    model: 'kiro/claude-sonnet-4.5',
    max_tokens: 50,
    temperature: 0.2,
    top_p: 0.9,
    tools: [{ type: 'function', function: { name: 'read' } }],
    messages: [
      user,
      { role: 'assistant', content: '', tool_calls: [
        { id: 'one', function: { name: 'read', arguments: '{}' } }, { id: 'two', function: { name: 'read', arguments: '{}' } },
      ] },
      { role: 'tool', tool_call_id: 'one', content: 'failed', is_error: true },
      { role: 'tool', tool_call_id: 'two', content: 'fine', is_error: false },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: '' },
    ],
  }, grant)
  expect(request).not.toHaveProperty('inferenceConfig')
  const history = request.conversationState.history
  // The tool-result turn has no text of its own.
  expect(history[2]?.userInputMessage?.content).toBe('Tool results provided.')
  expect(history[2]?.userInputMessage?.userInputMessageContext?.toolResults?.map(result => result.status)).toEqual(['error', 'success'])
  expect(request.conversationState.currentMessage.userInputMessage?.content).toBe('Continue.')
  expect(request.conversationState.currentMessage.userInputMessage?.userInputMessageContext?.tools).toHaveLength(1)
})

it('requires positive safe integer output limits for Kiro and leaves sampling controls inert', () => {
  const body = { model: 'kiro/claude-sonnet-4.5', messages: [user] }
  for (const field of ['max_tokens', 'max_completion_tokens']) {
    expect(() => { validateNativeControls('kiro', { ...body, [field]: 1024 }) }).not.toThrow()
    for (const value of [0, -1, 1.5, '100', Number.MAX_SAFE_INTEGER + 1, null])
      expect(() => { validateNativeControls('kiro', { ...body, [field]: value }) }, `${field}=${String(value)}`)
        .toThrow(value === null ? 'must be a positive safe integer' : /positive safe integer/)
  }
  expect(() => { validateNativeControls('kiro', { ...body, temperature: 0.1, top_p: 0.5, reasoning_effort: 'high' }) }).not.toThrow()
  expect(() => { validateNativeControls('cursor', { ...body, temperature: 0.1 }) }).toThrow('temperature')
})

it('emits reasoning events, and splits an inline thinking block only when thinking was requested', async () => {
  const events = await run([reasoning('First '), reasoning('thought'), text('Answer'), stop])
  expect(deltas(events, 'reasoning_content').join('')).toBe('First thought')
  expect(deltas(events, 'content').join('')).toBe('Answer')
  const inline = ['<thin', 'king>plan the ', 'work \n</thi', 'nking>\n\nThe ', 'answer']
  const frames = [...inline.map(text), stop]
  const split = await run(frames, { inlineThinking: true })
  expect(deltas(split, 'reasoning_content').join('')).toBe('plan the work')
  expect(deltas(split, 'content').join('')).toBe('The answer')
  // Without the request flag the same bytes stay literal text.
  expect(deltas(await run(frames), 'content').join('')).toBe(inline.join(''))
  // Tags later in a reply that did not open with one are text.
  const later = await run([text('  Fine. <thinking>'), text('no</thinking>'), stop], { inlineThinking: true })
  expect(deltas(later, 'content').join('')).toBe('  Fine. <thinking>no</thinking>')
  expect(deltas(later, 'reasoning_content')).toEqual([])
  // A close tag split across events, and a gap that is only whitespace.
  const tagged = await run([text('<thinking>abc</thinking>'), text('\n'), text('  '), text('done'), stop], { inlineThinking: true })
  expect(deltas(tagged, 'reasoning_content')).toEqual(['abc'])
  expect(deltas(tagged, 'content')).toEqual(['done'])
  // A partial tag at the start is flushed as text when the reply ends; leading blanks are kept.
  const partial = await run([text('<think'), stop], { inlineThinking: true })
  expect(deltas(partial, 'content')).toEqual(['<think'])
  const whitespace = await run([text('  '), text('ok'), stop], { inlineThinking: true })
  expect(deltas(whitespace, 'content').join('')).toBe('  ok')
  // A thinking block that never closes ends the reply with only reasoning, which is an empty response.
  await expect(run([text('<thinking>unfinished <'), stop], { inlineThinking: true })).rejects.toThrow('empty response')
  // Nothing buffered at the end adds nothing.
  const closed = await run([text('<thinking>x</thinking>'), text('y'), stop], { inlineThinking: true })
  expect(deltas(closed, 'content')).toEqual(['y'])
})

it('reports token usage and summed credits, ignoring unusable counts', async () => {
  const metering = awsFrame('meteringEvent', { usage: 0.25 })
  const last = (events: NativeEvent[]) => events.at(-1)
  const uncached = await run([text('x'), awsFrame('metadataEvent', { tokenUsage: {
    outputTokens: 10, uncachedInputTokens: 100, cacheReadInputTokens: 40, cacheWriteInputTokens: 5, totalTokens: 155,
  } }), metering, awsFrame('meteringEvent', { usage: 0.5 }), stop])
  expect(last(uncached)).toEqual({ finish: 'stop', usage: {
    prompt_tokens: 145,
    completion_tokens: 10,
    total_tokens: 155,
    prompt_tokens_details: { cached_tokens: 40, cache_write_tokens: 5 },
    compute_units: 0.75,
  } })
  const total = await run([text('x'), awsFrame('MetadataEvent', { token_usage: { outputTokens: 4, totalTokens: 24, cacheWriteInputTokens: 2 } }), stop])
  expect(last(total)).toEqual({ finish: 'stop', usage: {
    prompt_tokens: 20, completion_tokens: 4, total_tokens: 24, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2 },
  } })
  const bare = await run([text('x'), awsFrame('metadataEvent', { tokenUsage: { outputTokens: 3, uncachedInputTokens: 7 } }), stop])
  expect(last(bare)?.usage).toEqual({ prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 })
  // Credits alone are exact; a token block without output, malformed counts, or a negative credit add nothing.
  expect(last(await run([text('x'), metering, stop]))?.usage).toEqual({ compute_units: 0.25 })
  expect(last(await run([text('x'), awsFrame('metadataEvent', { tokenUsage: { totalTokens: 9 } }), stop]))).toEqual({ finish: 'stop' })
  expect(last(await run([text('x'), awsFrame('metadataEvent', { tokenUsage: { outputTokens: -1, totalTokens: 'many' } }), awsFrame('meteringEvent', { usage: -1 }), stop]))).toEqual({ finish: 'stop' })
  expect(last(await run([text('x'), awsFrame('metadataEvent', { tokenUsage: 'bad' }), stop]))).toEqual({ finish: 'stop' })
  expect(last(await run([text('x'), awsFrame('metadataEvent', { stopReason: 'end_turn' })]))).toEqual({ finish: 'stop' })
})

it('reports validation failures of a complete reply as non-retryable protocol errors', async () => {
  const cases: [Buffer[], string, Set<string>?][] = [
    [[awsFrame('toolUseEvent', { name: 'weather', input: '{}' }), stop], 'missing id'],
    [[awsFrame('toolUseEvent', { toolUseId: 'a', name: 'weather', input: '{}', stop: true }), awsFrame('toolUseEvent', { toolUseId: 'a', input: '{}' }), stop], 'after stop'],
    [[awsFrame('toolUseEvent', { toolUseId: 'a', name: 'weather', input: 'x'.repeat(5 * 1024 * 1024) }), awsFrame('toolUseEvent', { toolUseId: 'a', input: 'x'.repeat(5 * 1024 * 1024) }), stop], 'arguments exceed bounds'],
    [[text('x'), awsFrame('messageStopEvent', { stopReason: 'guardrail' })], 'unsupported stop reason'],
    [[awsFrame('toolUseEvent', { toolUseId: 'a', input: '{}' }), stop], 'Incomplete'],
    [[awsFrame('toolUseEvent', { toolUseId: 'a', name: 'shell', input: '{}' }), stop], 'undeclared', new Set(['weather'])],
    [[awsFrame('toolUseEvent', { toolUseId: 'a', name: 'weather', input: '{"city":' }), stop], 'Invalid Kiro tool arguments'],
    [[awsFrame('toolUseEvent', { toolUseId: 'a', name: 'weather', input: '[1]' }), stop], 'Invalid Kiro tool arguments'],
    [[stop], 'empty response'],
  ]
  for (const [frames, message, allowed] of cases) {
    const error = await run(frames, undefined, allowed, 1 << 20).then(() => undefined, (failure: unknown) => failure)
    expect(error, message).toBeInstanceOf(NativeProtocolError)
    expect(error).toMatchObject({ retryable: false, name: 'NativeProtocolError' })
    expect((error as Error).message).toContain(message)
  }
  const many = Array.from({ length: 129 }, (_, index) => awsFrame('toolUseEvent', { toolUseId: `t${index}`, name: 'weather', input: '{}' }))
  await expect(run([...many, stop])).rejects.toThrow('count exceeds')
  // Transport-level damage is not a protocol validation failure.
  await expect(run([text('x')])).rejects.not.toBeInstanceOf(NativeProtocolError)
})

const monthly = { message: 'out of credits', reason: 'MONTHLY_REQUEST_COUNT' }
const failure = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, statusText: 'Throttled', headers })
const now = Date.parse('2026-11-10T12:00:00Z')

it('turns monthly credit exhaustion into a 429 whose Retry-After is the real reset', async () => {
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    seen.push(url)
    expect(new Headers(init.headers).get('user-agent')).toContain('codewhispererruntime')
    expect(new Headers(init.headers).get('accept')).toBe('application/json')
    return Promise.resolve(Response.json({ nextDateReset: (now + 5 * 86_400_000) / 1000 }))
  }))
  for (const status of [429, 402]) {
    const annotated = await annotateKiroFailure(failure(status, monthly), withProfile, undefined, now)
    expect(annotated.status).toBe(429)
    expect(annotated.headers.get('retry-after')).toBe(String(5 * 86_400))
    expect(await annotated.json()).toEqual(monthly)
  }
  const url = new URL(seen[0] ?? '')
  expect(url.pathname).toBe('/getUsageLimits')
  expect(url.searchParams.get('resourceType')).toBe('AGENTIC_REQUEST')
  expect(url.searchParams.get('profileArn')).toContain('profile/X')
  // An upstream Retry-After always wins, so no lookup is made.
  seen.length = 0
  const kept = await annotateKiroFailure(failure(429, monthly, { 'retry-after': '77' }), grant, undefined, now)
  expect(kept.headers.get('retry-after')).toBe('77')
  expect(seen).toEqual([])
})

it('falls back to the next UTC month when the usage lookup fails, and leaves other failures alone', async () => {
  const nextMonth = Math.ceil((Date.UTC(2026, 11, 1) - now) / 1000)
  for (const lookup of [
    () => Promise.resolve(new Response('no', { status: 500 })),
    () => Promise.reject(new Error('offline')),
    () => Promise.resolve(Response.json({ nextDateReset: (now - 1000) / 1000 })),
    () => Promise.resolve(Response.json({ nextDateReset: 'soon' })),
  ]) {
    vi.stubGlobal('fetch', vi.fn(lookup))
    expect((await annotateKiroFailure(failure(429, monthly), grant, undefined, now)).headers.get('retry-after')).toBe(String(nextMonth))
  }
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('no lookup for other failures') }))
  const capacity = await annotateKiroFailure(failure(429, { reason: 'INSUFFICIENT_MODEL_CAPACITY' }, { 'x-test': '1' }), grant, undefined, now)
  expect(capacity.status).toBe(429)
  expect(capacity.statusText).toBe('Throttled')
  expect(capacity.headers.get('retry-after')).toBeNull()
  expect(capacity.headers.get('x-test')).toBe('1')
  expect(await capacity.json()).toEqual({ reason: 'INSUFFICIENT_MODEL_CAPACITY' })
  expect((await annotateKiroFailure(failure(429, 'not json'), grant, undefined, now)).headers.get('retry-after')).toBeNull()
  expect((await annotateKiroFailure(failure(429, '[]'), grant, undefined, now)).headers.get('retry-after')).toBeNull()
  const server = failure(503, monthly)
  expect(await annotateKiroFailure(server, grant, undefined, now)).toBe(server)
})

it('rejects invalid requests, routes failures, and enforces the client output limit locally', async () => {
  const context = (body: unknown, stream = false) => ({
    body: { stream, ...(body as object) },
    account: { token: withProfile },
    config: { timeouts: { 'messages-ms': 1000, 'stream-messages-ms': 1000 } },
  })
  const bad = await callKiro(context({ model: 'kiro/claude-sonnet-4.5', messages: [user], max_tokens: 0 }))
  expect(bad.status).toBe(400)
  const invalid = await bad.json() as { error: { type: string; message: string } }
  expect(invalid.error.type).toBe('invalid_request_error')
  expect(invalid.error.message).toContain('max_tokens')

  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(failure(429, monthly, { 'retry-after': '9' }))))
  const limited = await callKiro(context({ model: 'kiro/claude-sonnet-4.5', messages: [user] }))
  expect(limited.status).toBe(429)
  expect(limited.headers.get('retry-after')).toBe('9')

  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 200 }))))
  expect((await callKiro(context({ model: 'kiro/claude-sonnet-4.5', messages: [user] }))).body).toBeNull()

  let aborted = false
  const sent: { conversationState: { currentMessage: { userInputMessage: { content: string } } }; profileArn: string }[] = []
  const long = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    expect(url).toBe('https://q.us-east-1.amazonaws.com/generateAssistantResponse')
    init.signal?.addEventListener('abort', () => { aborted = true })
    sent.push(JSON.parse(init.body as string) as (typeof sent)[number])
    return Promise.resolve(new Response(chunks(concat(text(long), stop), 11), { status: 200 }))
  }))
  const capped = await callKiro(context({ model: 'kiro/claude-sonnet-4.5', messages: [user], max_tokens: 3, reasoning_effort: 'low', tools }))
  const json = await capped.json() as { choices: { finish_reason: string; message: { content: string } }[] }
  expect(json.choices[0]?.finish_reason).toBe('length')
  expect(long.startsWith(json.choices[0]?.message.content ?? 'x')).toBe(true)
  expect((json.choices[0]?.message.content.length ?? 99)).toBeLessThan(long.length)
  expect(aborted).toBe(true)
  expect(sent[0]?.conversationState.currentMessage.userInputMessage.content).toContain('<max_thinking_length>4096</max_thinking_length>')
  expect(sent[0]?.profileArn).toContain('profile/X')

  // The consumer's cancellation reaches the upstream request.
  aborted = false
  const streaming = await callKiro(context({ model: 'kiro/claude-sonnet-4.5', messages: [user] }, true))
  await streaming.body?.cancel()
  expect(aborted).toBe(true)
  const external = new AbortController()
  const cancelled = await callKiro({ ...context({ model: 'kiro/claude-sonnet-4.5', messages: [user] }), signal: external.signal })
  external.abort()
  await cancelled.body?.cancel()
})

const call = (id: string, args = '{}') => ({ id, function: { name: 'read', arguments: args } })
const model = 'kiro/claude-sonnet-4.5'

it('merges consecutive turns and keeps every tool result with its call', () => {
  const request = kiroRequest({
    model,
    tools: [{ type: 'function', function: { name: 'bare' } }, ...tools],
    messages: [
      { role: 'developer', content: 'rules' },
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'a' },
      { role: 'assistant', content: 'b', tool_calls: [call('one'), call('two', '')] },
      { role: 'tool', tool_call_id: 'one', content: 'r1' },
      { role: 'tool', tool_call_id: 'two', content: 'r2' },
      { role: 'user', content: '' },
      { role: 'assistant', content: 'last' },
      { role: 'assistant', content: 'again' },
    ],
  }, grant)
  const [opening, assistant, results, last] = request.conversationState.history
  expect(opening?.userInputMessage?.content).toBe('rules\n\nfirst\n\nsecond')
  expect(assistant?.assistantResponseMessage?.content).toBe('a\n\nb')
  expect(assistant?.assistantResponseMessage?.toolUses?.map(use => use.toolUseId)).toEqual(['one', 'two'])
  expect(results?.userInputMessage?.content).toBe('Tool results provided.')
  expect(results?.userInputMessage?.userInputMessageContext?.toolResults?.map(result => result.toolUseId)).toEqual(['one', 'two'])
  expect(last?.assistantResponseMessage?.content).toBe('last\n\nagain')
  expect(last?.assistantResponseMessage?.toolUses).toBeUndefined()
  // The conversation ended on an assistant turn, so Kiro gets a user turn to answer.
  expect(request.conversationState.currentMessage.userInputMessage?.content).toBe('Continue.')
  const declared = request.conversationState.currentMessage.userInputMessage?.userInputMessageContext?.tools
  expect(declared?.map(entry => [entry.toolSpecification.name, entry.toolSpecification.description])).toEqual([['bare', 'bare'], ['read', 'read']])
  expect(declared?.[0]?.toolSpecification.inputSchema.json).toEqual({ type: 'object', properties: {} })
  // An assistant message that opens the conversation gets a user turn before it.
  expect(kiroRequest({ model, messages: [{ role: 'user', content: '' }] }, grant).conversationState.currentMessage.userInputMessage?.content).toBe('Continue.')
  const opened = kiroRequest({ model, messages: [{ role: 'assistant', content: 'hi' }, user] }, grant)
  expect(opened.conversationState.history.map(turn => turn.userInputMessage?.content ?? turn.assistantResponseMessage?.content)).toEqual(['Continue.', 'hi'])
})

it('rejects conversations Kiro cannot represent', () => {
  const messages = (...rest: unknown[]) => ({ model, tools, messages: rest })
  const assistantCall = { role: 'assistant', content: '', tool_calls: [call('one')] }
  for (const [body, message] of [
    [{ model, tools: [{ type: 'function', function: { name: 'bad name' } }], messages: [user] }, 'tool names'],
    [{ model, tools: [{ type: 'function', function: { name: '' } }], messages: [user] }, 'tool names'],
    [messages(user, assistantCall, user), 'unresolved'],
    [messages(user, assistantCall, assistantCall), 'unresolved'],
    [messages(user, assistantCall), 'unresolved'],
    [messages(user, { role: 'assistant', content: '', tool_calls: [call('one'), call('one')] }), 'unique id'],
    [messages(user, { role: 'assistant', content: '', tool_calls: [{ id: '', function: { name: 'read', arguments: '{}' } }] }), 'unique id'],
    [messages(user, { role: 'assistant', content: '', tool_calls: [call('one', '[]')] }), 'must be an object'],
    [messages(user, { role: 'assistant', content: '', tool_calls: [call('one', 'null')] }), 'must be an object'],
    [messages(user, { role: 'assistant', content: '', tool_calls: [call('one', '3')] }), 'must be an object'],
    [messages({ role: 'function', content: '' }), 'Unsupported Kiro message role'],
    [messages({ role: 'tool', content: 'x' }), 'no matching tool call'],
  ] as const)
    expect(() => kiroRequest(body, grant), message).toThrow(message)
  expect(() => kiroRequest(messages(user, { role: 'assistant', content: '', tool_calls: [call('one', '{')] }), grant)).toThrow(SyntaxError)
})

it('parses event frames with absent, malformed, and unsupported headers', async () => {
  const typeless = await run([awsFrame(undefined, { content: 'ignored' }), text('kept'), stop])
  expect(deltas(typeless, 'content')).toEqual(['kept'])
  const badHeaders = [
    awsRaw(Buffer.from([0, 0, 0]), Buffer.from('{}')),
    awsRaw(Buffer.concat([Buffer.from([4]), Buffer.from('name'), Buffer.from([6, 0, 1, 120])]), Buffer.from('{}')),
    awsRaw(Buffer.concat([Buffer.from([4]), Buffer.from('name'), Buffer.from([7, 0, 9, 120])]), Buffer.from('{}')),
  ]
  const headerFailure = /Invalid Kiro EventStream header|Unsupported Kiro EventStream header type|Truncated Kiro EventStream header/
  for (const frame of badHeaders) await expect(run([frame, stop])).rejects.toThrow(headerFailure)
  await expect(run([awsRaw(awsHeader(':message-type', 'event'), Buffer.from('[]')), stop])).rejects.toThrow()
})

it('maps stop reasons, object tool input, and sparse usage fields', async () => {
  expect((await run([text('x'), awsFrame('messageStopEvent', { stopReason: 'max_tokens' })])).at(-1)?.finish).toBe('length')
  expect((await run([text('x'), awsFrame('messageStopEvent', { stop_reason: 'stop' })])).at(-1)?.finish).toBe('stop')
  expect((await run([text('x'), awsFrame('messageStopEvent', {})])).at(-1)?.finish).toBe('stop')
  const object = await run([awsFrame('toolUseEvent', { toolUseId: 'a', name: 'read', input: { path: '/tmp' } }), stop], undefined, new Set(['read']))
  expect(object.flatMap(event => event.delta?.tool_calls ?? []).map(entry => entry.function.arguments)).toEqual(['{"path":"/tmp"}'])
  expect(object.at(-1)?.finish).toBe('tool_calls')
  const outputOnly = await run([text('x'), awsFrame('metadataEvent', { tokenUsage: { outputTokens: 3 } }), stop])
  expect(outputOnly.at(-1)).toEqual({ finish: 'stop' })
  const cacheRead = await run([text('x'), awsFrame('metadataEvent', { tokenUsage: { outputTokens: 3, uncachedInputTokens: 1, cacheReadInputTokens: 2 } }), stop])
  expect(cacheRead.at(-1)?.usage).toEqual({
    prompt_tokens: 3, completion_tokens: 3, total_tokens: 6, prompt_tokens_details: { cached_tokens: 2 },
  })
  const failing = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('socket reset')) } })
  await expect(collect(kiroEvents(failing))).rejects.toThrow('socket reset')
  const empty = await run([awsFrame('assistantResponseEvent', { content: '<thinking></thinking>' }), text('go'), stop], { inlineThinking: true })
  expect(deltas(empty, 'reasoning_content')).toEqual([])
  expect(deltas(empty, 'content')).toEqual(['go'])
  const blank = await run([text(''), text('<thinking>'), text('a</thinking>b'), text('plain'), text(''), stop], { inlineThinking: true })
  expect(deltas(blank, 'content')).toEqual(['b', 'plain'])
  expect(deltas(blank, 'reasoning_content')).toEqual(['a'])
})
