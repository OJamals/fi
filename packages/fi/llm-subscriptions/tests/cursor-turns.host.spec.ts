/** Native tool-result continuation over a real local HTTP/2 stream. */
import http2 from 'node:http2'
import type { ServerHttp2Stream, ServerHttp2Session } from 'node:http2'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CursorTurns } from '../src/native/cursor-turns.ts'
import { decodeProto, frame, nested, pb, str } from '../src/native/subscription-protobuf.ts'
import type { NativeCallContext } from '../src/protocol.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks()
})
const concat = (...values: Uint8Array[]) => Buffer.concat(values)
const callFrame = () => frame(pb(2, concat(pb(1, 42), pb(15, 'exec-42'), pb(11, concat(pb(1, 'get_status'), pb(3, 'native-id'), pb(5, 'get_status'))))))
const answerFrames = () => concat(frame(pb(1, pb(1, pb(1, 'FI_TOOL_READY')))), frame(pb(1, pb(14, Buffer.alloc(0)))))
const base: NativeCallContext = {
  account: { token: { provider: 'cursor', accessToken: 'fixture', refreshToken: '', expiresAt: '2099-01-01T00:00:00.000Z', subscriptionAuth: { machineId: 'machine' } } },
  config: { timeouts: { 'messages-ms': 2000, 'stream-messages-ms': 2000 } },
  body: {},
}
const messages = [{ role: 'user', content: 'Call get_status once' }]
const tools = [{ type: 'function', function: { name: 'get_status', parameters: { type: 'object', properties: {} } } }]
async function harness(handler: (stream: ServerHttp2Stream, data: Buffer) => void, respond = true) {
  const server = http2.createServer()
  const sessions = new Set<ServerHttp2Session>()
  const transport = new CursorTurns()
  cleanup.push(async () => {
    await transport.dispose()
    for (const session of sessions) session.destroy()
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  })
  server.on('session', (session) => { sessions.add(session); session.on('close', () => sessions.delete(session)) })
  let runs = 0
  server.on('stream', (stream) => {
    runs++
    stream.on('error', () => { /* Cancellation closes this fixture stream. */ })
    if (respond) stream.respond({ ':status': 200 })
    let pending = Buffer.alloc(0)
    stream.on('data', (data: Buffer) => {
      pending = Buffer.concat([pending, data])
      while (pending.length >= 5 && pending.length >= 5 + pending.readUInt32BE(1)) {
        const end = 5 + pending.readUInt32BE(1)
        const packet = pending.subarray(0, end)
        pending = pending.subarray(end)
        handler(stream, packet)
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  const connect = http2.connect
  vi.spyOn(http2, 'connect').mockImplementation(() => connect(`http://127.0.0.1:${address.port}`))
  return { transport, runs: () => runs, sessions }
}
async function first(transport: CursorTurns, overrides: Partial<NativeCallContext> = {}) {
  const response = await transport.call({ ...base, ...overrides, body: { model: 'composer-2.5', messages, tools, max_tokens: 128 } })
  const json = z.object({ choices: z.tuple([z.object({ message: z.object({
    role: z.literal('assistant'), content: z.string().nullable(),
    tool_calls: z.tuple([z.object({ id: z.string(), type: z.literal('function'),
      function: z.object({ name: z.string(), arguments: z.string() }) })]),
  }) })]) }).parse(await response.json())
  return json.choices[0].message
}

it.each([false, true])('resumes native MCP results without a second Run (stream=%s)', async (streaming) => {
  let nativeResults = 0
  const h = await harness((stream, data) => {
    const packet = decodeProto(data.subarray(5))
    if (packet.has(1)) stream.write(callFrame())
    else {
      nativeResults++
      const exec = nested(packet, 2)
      expect(Number(exec.get(1)?.[0])).toBe(42)
      expect(str(exec, 15)).toBe('exec-42')
      const result = nested(nested(exec, 11), 1)
      expect(str(nested(nested(result, 1), 1), 1)).toBe('FI_TOOL_READY')
      expect(Number(result.get(2)?.[0])).toBe(1)
      stream.write(answerFrames())
    }
  })
  const controller = new AbortController()
  const assistant = await first(h.transport, { signal: controller.signal })
  controller.abort()
  const response = await h.transport.call({ ...base, body: { model: 'composer-2.5', stream: streaming, tools,
    messages: [...messages, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'FI_TOOL_READY', is_error: true }] } })
  expect(await response.text()).toContain('FI_TOOL_READY')
  expect(h.runs()).toBe(1)
  expect(nativeResults).toBe(1)
})

it('rejects wrong account, model, tools, transcript, and consumed continuation', async () => {
  const h = await harness((stream, data) => { stream.write(decodeProto(data.subarray(5)).has(1) ? callFrame() : answerFrames()) })
  const assistant = await first(h.transport)
  const body = { model: 'composer-2.5', tools, messages: [...messages, assistant,
    { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'FI_TOOL_READY' }] }
  for (const request of [
    { ...base, account: { token: { ...base.account.token, accessToken: 'different' } }, body },
    { ...base, body: { ...body, model: 'default' } },
    { ...base, body: { ...body, tools: [] } },
    { ...base, body: { ...body, messages: [{ role: 'user', content: 'different' }, ...body.messages.slice(1)] } },
    { ...base, body: { ...body, messages: [messages[0], { ...assistant, content: 'changed assistant' }, body.messages[2]] } },
    { ...base, body: { ...body, messages: [messages[0], { ...assistant, tool_calls: [{ ...assistant.tool_calls[0],
      function: { name: 'get_status', arguments: '{"changed":true}' } }] }, body.messages[2]] } },
  ]) await expect(h.transport.call(request)).rejects.toThrow('does not match')
  expect(await (await h.transport.call({ ...base, body })).text()).toContain('FI_TOOL_READY')
  await expect(h.transport.call({ ...base, body })).rejects.toThrow('expired')
  expect(h.runs()).toBe(1)
})

it('expires pending tool continuations and disposes retained streams', async () => {
  const h = await harness((stream) => { stream.write(callFrame()) })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const assistant = await first(h.transport)
  await vi.advanceTimersByTimeAsync(2000)
  vi.useRealTimers()
  await vi.waitFor(() =>{  expect(h.sessions.size).toBe(0) })
  await expect(h.transport.call({ ...base, body: { model: 'composer-2.5', tools, messages: [...messages, assistant,
    { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'FI_TOOL_READY' }] } })).rejects.toThrow('expired')
  await first(h.transport)
  await h.transport.dispose()
  await vi.waitFor(() =>{  expect(h.sessions.size).toBe(0) })
})

it('closes an active native stream on cancellation', async () => {
  const h = await harness(() => {})
  const controller = new AbortController()
  const response = await h.transport.call({ ...base, signal: controller.signal, body: { model: 'composer-2.5', stream: true, messages, tools } })
  const read = response.text()
  controller.abort()
  await expect(read).rejects.toThrow()
  await vi.waitFor(() =>{  expect(h.sessions.size).toBe(0) })
})

it('disposal cancels a connection still waiting for response headers', async () => {
  const received = Promise.withResolvers<undefined>()
  const h = await harness(() => { received.resolve(undefined) }, false)
  const pending = first(h.transport)
  const rejected = expect(pending).rejects.toThrow()
  await received.promise
  await h.transport.dispose()
  await rejected
  await vi.waitFor(() => { expect(h.sessions.size).toBe(0) })
})

it('preserves a buffered second exec and consumes both tool results on one Run', async () => {
  let results = 0
  const h = await harness((stream, data) => {
    if (decodeProto(data.subarray(5)).has(1)) stream.write(concat(callFrame(), callFrame()))
    else if (++results === 2) stream.write(answerFrames())
  })
  const assistant = await first(h.transport)
  const history = [...messages, assistant, { role: 'tool', tool_call_id: assistant.tool_calls[0].id, content: 'first' }]
  const next = await h.transport.call({ ...base, body: { model: 'composer-2.5', tools, messages: history } })
  const value = z.object({ choices: z.tuple([z.object({ message: z.object({
    role: z.literal('assistant'), tool_calls: z.tuple([z.object({ id: z.string(), type: z.literal('function'),
      function: z.object({ name: z.string(), arguments: z.string() }) })]),
  }).loose() })]) }).parse(await next.json())
  const second = value.choices[0].message
  expect(second.tool_calls[0].id).not.toBe(assistant.tool_calls[0].id)
  const response = await h.transport.call({ ...base, body: { model: 'composer-2.5', tools,
    messages: [...history, second, { role: 'tool', tool_call_id: second.tool_calls[0].id, content: 'second' }] } })
  expect(await response.text()).toContain('FI_TOOL_READY')
  expect(h.runs()).toBe(1)
  expect(results).toBe(2)
})

it('output-budget truncation closes the native run without retaining an executable call', async () => {
  const h = await harness((stream) => { stream.write(concat(frame(pb(1, pb(1, pb(1, 'many words exceed budget')))), callFrame())) })
  const response = await h.transport.call({ ...base, body: { model: 'composer-2.5', tools, messages, max_tokens: 1 } })
  const value = await response.text()
  expect(value).toContain('"finish_reason":"length"')
  expect(value).not.toContain('tool_calls')
  await vi.waitFor(() => { expect(h.sessions.size).toBe(0) })
})
