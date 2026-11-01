/** Native tool-result continuation, session reuse, and failure mapping over a real local HTTP/2 server. */
import type { ServerHttp2Stream } from 'node:http2'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { z } from 'zod'
import { CursorTurns } from '../src/native/cursor-turns.ts'
import { decodeProto, frame, nested, str } from '../src/native/subscription-protobuf.ts'
import type { NativeCallContext } from '../src/protocol.ts'
import { checkpointFrame, concat, cursorServer, mcpFrame, mcpResultText, textFrame, tokenFrame, turnEnded } from './harness.ts'
import type { CursorServerOptions } from './harness.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const callFrames = (...ids: number[]) => concat(...ids.map(id => mcpFrame(id, `native-${id}`, {}, 'get_status')), checkpointFrame())
const answerFrames = () => concat(textFrame('FI_TOOL_READY'), turnEnded({ input: 11, output: 3 }))
const grant = (machineId: string) => ({ provider: 'cursor' as const, accessToken: 'fixture', refreshToken: '', expiresAt: '2099-01-01T00:00:00.000Z', subscriptionAuth: { machineId } })
const base: NativeCallContext = {
  account: { token: grant('machine') },
  config: { timeouts: { 'messages-ms': 2000, 'stream-messages-ms': 2000 } },
  body: {},
}
const messages = [{ role: 'user', content: 'Call get_status once' }]
const tools = [{ type: 'function', function: { name: 'get_status', parameters: { type: 'object', properties: {} } } }]
async function harness(handler: (stream: ServerHttp2Stream, data: Buffer) => void, options: CursorServerOptions = {}) {
  const server = await cursorServer(handler, options)
  const transport = new CursorTurns()
  onTestFinished(() => transport.dispose())
  return { ...server, transport }
}
const assistantSchema = z.object({ choices: z.tuple([z.object({ message: z.object({
  role: z.literal('assistant'), content: z.string().nullable(),
  tool_calls: z.array(z.object({ id: z.string(), type: z.literal('function'),
    function: z.object({ name: z.string(), arguments: z.string() }) })),
}) })]), usage: z.unknown().optional() })
async function first(transport: CursorTurns, overrides: Partial<NativeCallContext> = {}) {
  const response = await transport.call({ ...base, ...overrides, body: { model: 'composer-2.5', messages, tools, max_tokens: 128 } })
  return assistantSchema.parse(await response.json()).choices[0].message
}
const toolResult = (id: string, content: string, is_error?: boolean) => ({ role: 'tool', tool_call_id: id, content, ...is_error === undefined ? {} : { is_error } })
const isRun = (data: Buffer) => decodeProto(data.subarray(5)).has(1)

it.each([false, true])('resumes native MCP results without a second Run (stream=%s)', async (streaming) => {
  const results: ReturnType<typeof mcpResultText>[] = []
  const h = await harness((stream, data) => {
    const packet = decodeProto(data.subarray(5))
    if (isRun(data)) stream.write(callFrames(42))
    else {
      results.push(mcpResultText(packet))
      stream.write(answerFrames())
    }
  })
  const controller = new AbortController()
  const assistant = await first(h.transport, { signal: controller.signal })
  controller.abort()
  const call = assistant.tool_calls[0]
  expect(assistant.tool_calls).toHaveLength(1)
  expect(call?.id).toMatch(/^call_/)
  const response = await h.transport.call({ ...base, body: { model: 'composer-2.5', stream: streaming, tools,
    messages: [...messages, assistant, toolResult(call?.id ?? '', 'FI_TOOL_READY', true)] } })
  const text = await response.text()
  expect(text).toContain('FI_TOOL_READY')
  expect(text).toContain('"prompt_tokens":11')
  expect(h.runs()).toBe(1)
  expect(results).toEqual([{ id: 42, execId: 'exec-42', text: 'FI_TOOL_READY', isError: 1 }])
})

it('returns parallel calls of one step together and answers every result on the same Run', async () => {
  const results: ReturnType<typeof mcpResultText>[] = []
  const h = await harness((stream, data) => {
    if (isRun(data)) stream.write(callFrames(42, 43, 44))
    else if (results.push(mcpResultText(decodeProto(data.subarray(5)))) === 3) stream.write(answerFrames())
  })
  const assistant = await first(h.transport)
  expect(assistant.tool_calls).toHaveLength(3)
  expect(new Set(assistant.tool_calls.map(call => call.id)).size).toBe(3)
  const [a, b, c] = assistant.tool_calls.map(call => call.id) as [string, string, string]
  // Results may arrive in any order, and a failure is reported per call.
  const response = await h.transport.call({ ...base, body: { model: 'composer-2.5', tools,
    messages: [...messages, assistant, toolResult(c, 'third'), toolResult(a, 'first', true), toolResult(b, 'second', false)] } })
  expect(await response.text()).toContain('FI_TOOL_READY')
  expect(h.runs()).toBe(1)
  expect(results.map(result => [result?.id, result?.text, result?.isError]).sort()).toEqual([[42, 'first', 1], [43, 'second', 0], [44, 'third', 0]])
})

it('rejects wrong account, model, tools, transcript, partial or foreign results, and a consumed continuation', async () => {
  const h = await harness((stream, data) => { stream.write(isRun(data) ? callFrames(42, 43) : answerFrames()) })
  const assistant = await first(h.transport)
  const [a, b] = assistant.tool_calls.map(call => call.id) as [string, string]
  const body = { model: 'composer-2.5', tools, messages: [...messages, assistant, toolResult(a, 'one'), toolResult(b, 'two')] }
  const functions = assistant.tool_calls.map(call => call.function)
  for (const request of [
    { ...base, account: { token: { ...base.account.token, accessToken: 'different' } }, body },
    { ...base, body: { ...body, model: 'default' } },
    { ...base, body: { ...body, tools: [] } },
    { ...base, body: { ...body, messages: [{ role: 'user', content: 'different' }, ...body.messages.slice(1)] } },
    { ...base, body: { ...body, messages: [messages[0], { ...assistant, content: 'changed assistant' }, ...body.messages.slice(2)] } },
    { ...base, body: { ...body, messages: [messages[0], { ...assistant, tool_calls: [{ ...assistant.tool_calls[0], function: { name: 'get_status', arguments: '{"changed":true}' } }, assistant.tool_calls[1]] }, ...body.messages.slice(2)] } },
    // One of two results, a duplicate, an unknown id, and results with no assistant step before them.
    { ...base, body: { ...body, messages: body.messages.slice(0, 3) } },
    { ...base, body: { ...body, messages: [...body.messages.slice(0, 3), toolResult(a, 'again')] } },
    { ...base, body: { ...body, messages: [...body.messages.slice(0, 3), toolResult('unknown', 'x'), toolResult(b, 'two')] } },
    { ...base, body: { ...body, messages: [...body.messages.slice(0, 3), { role: 'tool', content: 'no id' }, toolResult(b, 'two')] } },
    { ...base, body: { ...body, messages: [messages[0], toolResult(a, 'one'), toolResult(b, 'two')] } },
    { ...base, body: { ...body, messages: [messages[0], { role: 'assistant', content: '' }, toolResult(a, 'one')] } },
    // A call that already lists the id twice cannot be answered once.
    { ...base, body: { ...body, messages: [messages[0], { ...assistant, tool_calls: [assistant.tool_calls[0], assistant.tool_calls[0]] }, toolResult(a, 'one'), toolResult(a, 'one')] } },
  ]) await expect(h.transport.call(request)).rejects.toThrow('does not match')
  void functions
  expect(await (await h.transport.call({ ...base, body })).text()).toContain('FI_TOOL_READY')
  await expect(h.transport.call({ ...base, body })).rejects.toThrow('expired')
  await expect(h.transport.call({ ...base, body: { ...body, messages: [...messages, assistant, { role: 'tool', tool_call_id: a, content: [{ type: 'image_url' }] }, toolResult(b, 'two')] } }))
    .rejects.toThrow('text and function tools only')
  expect(h.runs()).toBe(1)
})

it('expires pending tool continuations by the stream deadline and closes retained streams on disposal', async () => {
  const h = await harness((stream) => { stream.write(callFrames(42)) })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const assistant = await first(h.transport)
  await vi.advanceTimersByTimeAsync(2000)
  vi.useRealTimers()
  await vi.waitFor(() => { expect(h.open()).toBe(0) })
  await expect(h.transport.call({ ...base, body: { model: 'composer-2.5', tools, messages: [...messages, assistant,
    toolResult(assistant.tool_calls[0]?.id ?? '', 'FI_TOOL_READY')] } })).rejects.toThrow('expired')
  await first(h.transport)
  expect(h.open()).toBe(1)
  await h.transport.dispose()
  expect(h.open()).toBe(0)
  await vi.waitFor(() => { expect(h.sessions.size).toBe(0) })
  await expect(first(h.transport)).rejects.toThrow('disposed')
})

it('keeps a retained run answerable until its deadline even if the client stops reading at the finish chunk', async () => {
  const h = await harness((stream, data) => { stream.write(isRun(data) ? callFrames(42) : answerFrames()) })
  const response = await h.transport.call({ ...base, body: { model: 'composer-2.5', stream: true, messages, tools } })
  const reader = response.body?.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  while (!seen.includes('"finish_reason":"tool_calls"')) seen += decoder.decode((await reader?.read())?.value)
  const id = /"id":"(call_[^"]+)"/.exec(seen)?.[1] ?? ''
  const function_ = { name: 'get_status', arguments: '{}' }
  const next = await h.transport.call({ ...base, body: { model: 'composer-2.5', tools, messages: [...messages,
    { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: function_ }] }, toolResult(id, 'ok')] } })
  expect(await next.text()).toContain('FI_TOOL_READY')
  await reader?.cancel()
  expect(h.runs()).toBe(1)
})

it('closes an active native stream on cancellation but keeps the account session for reuse', async () => {
  const h = await harness(() => {})
  const controller = new AbortController()
  const response = await h.transport.call({ ...base, signal: controller.signal, body: { model: 'composer-2.5', stream: true, messages, tools } })
  const read = response.text()
  controller.abort()
  await expect(read).rejects.toThrow()
  await vi.waitFor(() => { expect(h.open()).toBe(0) })
  expect(h.sessions.size).toBe(1)
  await expect(h.transport.call({ ...base, signal: controller.signal, body: { model: 'composer-2.5', messages } })).rejects.toThrow()
})

it('disposal cancels a connection still waiting for response headers', async () => {
  const received = Promise.withResolvers<undefined>()
  const h = await harness(() => { received.resolve(undefined) }, { respond: false })
  const pending = first(h.transport)
  const rejected = expect(pending).rejects.toThrow()
  await received.promise
  await h.transport.dispose()
  await rejected
  await vi.waitFor(() => { expect(h.sessions.size).toBe(0) })
})

it('walks successive tool steps on one Run, charging each step its own usage', async () => {
  let step = 0
  const h = await harness((stream, data) => {
    if (isRun(data)) stream.write(concat(tokenFrame(4), callFrames(42)))
    else if (++step === 1) stream.write(concat(tokenFrame(2), callFrames(43)))
    else stream.write(answerFrames())
  })
  const one = await first(h.transport)
  const two = await h.transport.call({ ...base, body: { model: 'composer-2.5', tools, messages: [...messages, one, toolResult(one.tool_calls[0]?.id ?? '', 'first')] } })
  const second = assistantSchema.parse(await two.json())
  expect(second.usage).toMatchObject({ completion_tokens: 2 })
  const next = second.choices[0].message
  expect(next.tool_calls[0]?.id).not.toBe(one.tool_calls[0]?.id)
  const done = await h.transport.call({ ...base, body: { model: 'composer-2.5', tools, messages: [...messages, one, toolResult(one.tool_calls[0]?.id ?? '', 'first'), next, toolResult(next.tool_calls[0]?.id ?? '', 'second')] } })
  expect(await done.text()).toContain('FI_TOOL_READY')
  expect(h.runs()).toBe(1)
})

it('output-budget truncation closes the native run without retaining an executable call', async () => {
  const h = await harness((stream) => { stream.write(concat(textFrame('many words exceed budget'), callFrames(42))) })
  const response = await h.transport.call({ ...base, body: { model: 'composer-2.5', tools, messages, max_tokens: 1 } })
  const value = await response.text()
  expect(value).toContain('"finish_reason":"length"')
  expect(value).not.toContain('tool_calls')
  await vi.waitFor(() => { expect(h.open()).toBe(0) })
})

it('shares one HTTP/2 session per account across Runs and never between accounts', async () => {
  const h = await harness((stream) => { stream.write(concat(textFrame('hi'), turnEnded())) })
  const run = (machineId: string) => h.transport.call({ ...base, account: { token: grant(machineId) },
    body: { model: 'composer-2.5', messages } }).then(response => response.json())
  await run('machine-a')
  await run('machine-a')
  await Promise.all([run('machine-a'), run('machine-a')])
  expect(h.connects()).toBe(1)
  await run('machine-b')
  expect(h.connects()).toBe(2)
  expect(h.runs()).toBe(5)
  expect(h.sessions.size).toBe(2)
})

it('maps quota and plan refusals to typed JSON responses and other trailer errors to failures', async () => {
  const trailer = (error: unknown) => {
    const out = frame(Buffer.from(JSON.stringify({ error })))
    out[0] = 2
    return out
  }
  const refusal = (title: string) => ({ code: 'resource_exhausted', details: [{ type: 'aiserver.v1.ErrorDetails', debug: { details: { title } } }] })
  let next: Buffer = trailer(refusal('Usage limit reached'))
  const h = await harness((stream) => { stream.write(next) })
  const ask = () => h.transport.call({ ...base, body: { model: 'composer-2.5', messages } })
  const quota = await ask()
  expect(quota.status).toBe(429)
  const typed = await quota.json() as { error: { type: string; code: string; message: string } }
  expect([typed.error.type, typed.error.code]).toEqual(['insufficient_quota', 'cursor_usage_limit'])
  expect(typed.error.message).toContain('quota is exhausted')
  next = trailer(refusal('This model is unavailable'))
  const plan = await ask()
  expect(plan.status).toBe(403)
  expect(await plan.json()).toMatchObject({ error: { type: 'permission_error', code: 'cursor_model_unavailable' } })
  next = trailer({ code: 'internal' })
  await expect(ask()).rejects.toThrow('Connect stream error')
  // Streaming responses carry the typed error through the body.
  next = trailer(refusal('Usage limit reached'))
  await expect((await h.transport.call({ ...base, body: { model: 'composer-2.5', stream: true, messages } })).text()).rejects.toThrow('quota is exhausted')
})

it('reports an unavailable Run', async () => {
  const h = await harness(() => {}, { onStream: (stream) => { stream.respond({ ':status': 503 }); stream.end(); return true } })
  await expect(first(h.transport)).rejects.toThrow('Cursor request unavailable (503)')
})

it('surfaces a request deadline as a TimeoutError and retires the silent connection', async () => {
  const never = await harness(() => {}, { respond: false })
  const timed = { ...base, config: { timeouts: { 'messages-ms': 30, 'stream-messages-ms': 30 } } }
  const error = await never.transport.call({ ...timed, body: { model: 'composer-2.5', messages } }).then(() => undefined, (failure: unknown) => failure)
  expect(error).toMatchObject({ name: 'TimeoutError', message: 'Cursor request timed out' })
  // The silent connection is retired, so the next Run starts a fresh one.
  await expect(never.transport.call({ ...timed, body: { model: 'composer-2.5', messages } })).rejects.toThrow('timed out')
  expect(never.connects()).toBe(2)
  const pre = new AbortController()
  pre.abort()
  await expect(never.transport.call({ ...base, signal: pre.signal, body: { model: 'composer-2.5', messages } })).rejects.toThrow()
  expect(str(nested(decodeProto(Buffer.alloc(0)), 1), 1)).toBe('')
})
