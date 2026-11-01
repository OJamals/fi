/** CursorRun batching, answering, usage, and error mapping over scripted byte sources. */
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import { cursorEvents } from '../src/native/cursor-api.ts'
import { cursorToolDefinition } from '../src/native/cursor-wire.ts'
import { limitNativeOutput } from '../src/native/cursor-budget.ts'
import { CursorModelUnavailableError, CursorQuotaError, cursorConnectError } from '../src/native/cursor-errors.ts'
import { BATCH_QUIET_MS, CursorRun } from '../src/native/cursor-run.ts'
import { decodeProto, frame, pb } from '../src/native/subscription-protobuf.ts'
import { MAX_NATIVE_FRAME, nativeChatResponse } from '../src/native/subscription-stream.ts'
import {
  checkpointFrame,
  collect,
  concat,
  decoded,
  Feed,
  mcpFrame,
  mcpResultText,
  textFrame,
  tokenFrame,
  turnEnded,
} from './harness.ts'

afterEach(() => { vi.useRealTimers() })
const tool = { type: 'function' as const, function: { name: 'weather' } }
const newRun = (feed: Feed, written: Buffer[] = [], model = 'cursor/test') =>
  new CursorRun(feed, data => written.push(data), model, new Set(['weather']), [tool])
const answers = (entries: [string, string][], isError = false) =>
  new Map(entries.map(([id, content]) => [id, { content, isError }]))

it('returns parallel MCP calls of one step together and answers them on the same run', async () => {
  const feed = new Feed()
  const written: Buffer[] = []
  const run = newRun(feed, written)
  feed.push(
    mcpFrame(2, 'native-a', { city: 'Paris' }),
    mcpFrame(3, 'native-b', { city: 'Berlin' }),
    mcpFrame(4, 'native-c', { city: 'Madrid' }),
    checkpointFrame(),
    // Read ahead of the step boundary: must survive for the next response.
    textFrame('kept'),
  )
  const first = await collect(run.events())
  const calls = first[0]?.delta?.tool_calls ?? []
  expect(calls.map(call => [call.index, call.function.arguments])).toEqual([
    [0, '{"city":"Paris"}'], [1, '{"city":"Berlin"}'], [2, '{"city":"Madrid"}'],
  ])
  // Caller-visible ids are local and unique, not Cursor's own tool_call_id.
  expect(new Set(calls.map(call => call.id)).size).toBe(3)
  expect(calls.every(call => call.id.startsWith('call_') && !call.id.includes('native'))).toBe(true)
  expect(first).toHaveLength(2)
  expect(first[1]?.finish).toBe('tool_calls')
  expect(run.suspended).toBe(true)
  expect(written).toHaveLength(0)

  const [a, b, c] = calls.map(call => call.id) as [string, string, string]
  expect(() => { run.answer(answers([[a, 'only one']])) }).toThrow('result missing')
  expect(run.calls).toHaveLength(3)
  run.answer(new Map([
    [c, { content: 'Madrid sunny', isError: false }],
    [a, { content: 'Paris rain', isError: true }],
    [b, { content: 'Berlin fog', isError: false }],
  ]))
  expect(decoded(written).map(message => mcpResultText(message))).toEqual([
    { id: 2, execId: 'exec-2', text: 'Paris rain', isError: 1 },
    { id: 3, execId: 'exec-3', text: 'Berlin fog', isError: 0 },
    { id: 4, execId: 'exec-4', text: 'Madrid sunny', isError: 0 },
  ])
  expect(run.suspended).toBe(false)

  feed.push(textFrame('done'), turnEnded({ input: 10, output: 2 }))
  const second = await collect(run.events())
  expect(second.map(event => event.delta?.content ?? event.finish)).toEqual(['kept', 'done', 'stop'])
})

it('ends a tool-call batch on a quiet stream when no checkpoint arrives', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const feed = new Feed()
  const run = newRun(feed)
  feed.push(mcpFrame(2, 'call-a', { city: 'Paris' }))
  const events = collect(run.events())
  await vi.advanceTimersByTimeAsync(BATCH_QUIET_MS - 1)
  expect(run.suspended).toBe(false)
  feed.push(mcpFrame(3, 'call-b', { city: 'Berlin' }))
  await vi.advanceTimersByTimeAsync(BATCH_QUIET_MS)
  const out = await events
  expect(out[0]?.delta?.tool_calls).toHaveLength(2)
  expect(out[1]?.finish).toBe('tool_calls')
  expect(run.suspended).toBe(true)
})

it('reads a step again after a quiet cut and surfaces a source failure that arrived meanwhile', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const feed = new Feed()
  const run = newRun(feed)
  feed.push(mcpFrame(2, 'call-a', {}))
  const first = collect(run.events())
  await vi.advanceTimersByTimeAsync(BATCH_QUIET_MS)
  const delivered = await first
  run.answer(answers([[delivered[0]?.delta?.tool_calls?.[0]?.id ?? '', 'ok']]))
  // The read that lost the race to the timer is still pending; the source dies under it.
  feed.fail(new Error('stream destroyed'))
  await vi.advanceTimersByTimeAsync(1)
  await expect(collect(run.events())).rejects.toThrow('stream destroyed')
})

it('releases the source when a response ends, tolerating a failing iterator return', async () => {
  const returned = vi.fn(() => Promise.reject(new Error('return failed')))
  const source: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ value: concat(textFrame('x'), turnEnded()), done: false }),
      return: returned,
    }),
  }
  expect((await collect(new CursorRun(source, () => {}).events())).at(-1)?.finish).toBe('stop')
  expect(returned).toHaveBeenCalledOnce()
  const feed = new Feed()
  feed.push(mcpFrame(2, 'call-a', {}), checkpointFrame())
  const suspended = newRun(feed)
  await collect(suspended.events())
  // A suspended run keeps its source readable for the results.
  expect(suspended.suspended).toBe(true)
})

it('delivers calls from a stream that ends after them but cannot resume it', async () => {
  const feed = new Feed()
  const run = newRun(feed)
  feed.push(mcpFrame(2, 'call-a', { city: 'Paris' }))
  feed.end()
  const out = await collect(run.events())
  expect(out[1]?.finish).toBe('tool_calls')
  expect(run.suspended).toBe(false)
})

it('ends a turn that stops while calls are pending as a tool-call step', async () => {
  const feed = new Feed()
  const run = newRun(feed)
  feed.push(mcpFrame(2, 'call-a', {}), turnEnded({ input: 3, output: 1 }))
  const out = await collect(run.events())
  // Only the streamed TokenDelta count is reported mid-turn, and there was none.
  expect(out[1]).toEqual({ finish: 'tool_calls' })
  expect(run.suspended).toBe(true)
})

it('rejects an undeclared tool, a nameless tool, and an empty turn', async () => {
  const feed = new Feed()
  feed.push(mcpFrame(2, 'call-a', {}, 'shell'))
  await expect(collect(newRun(feed).events())).rejects.toThrow('undeclared tool')
  const nameless = new Feed()
  nameless.push(frame(pb(2, concat(pb(1, 2), pb(15, 'exec'), pb(11, pb(3, 'native'))))))
  await expect(collect(newRun(nameless).events())).rejects.toThrow('missing name')
  expect(() => cursorToolDefinition({ type: 'function', function: { name: '' } })).toThrow('function tools only')
  // An exec without ids is still answered as id 0.
  const anonymous = new Feed()
  anonymous.push(frame(pb(2, pb(11, concat(pb(1, 'weather'))))), checkpointFrame())
  const call = (await collect(newRun(anonymous).events()))[0]?.delta?.tool_calls?.[0]
  expect(call?.function).toEqual({ name: 'weather', arguments: '{}' })
  const empty = new Feed()
  empty.push(turnEnded())
  await expect(collect(newRun(empty).events())).rejects.toThrow('empty turn')
})

it('reports turn-end usage as provider usage with cache and reasoning detail', async () => {
  const feed = new Feed()
  feed.push(tokenFrame(5), textFrame('ok'), turnEnded({ input: 12379, output: 24, cacheRead: 12288, cacheWrite: 7, reasoning: 22 }))
  expect((await collect(cursorEvents(feed, () => {}))).at(-1)).toEqual({
    finish: 'stop',
    usage: {
      prompt_tokens: 12379,
      completion_tokens: 24,
      total_tokens: 12403,
      prompt_tokens_details: { cached_tokens: 12288, cache_write_tokens: 7 },
      completion_tokens_details: { reasoning_tokens: 22 },
    },
  })
  const again = new Feed()
  again.push(textFrame('ok'), turnEnded({ input: 100, output: 4, cacheRead: 64 }))
  const response = await nativeChatResponse(cursorEvents(again, () => {}), 'cursor/test', false)
  expect(((await response.json()) as { usage: unknown }).usage).toEqual({
    prompt_tokens: 100, completion_tokens: 4, total_tokens: 104, prompt_tokens_details: { cached_tokens: 64 },
  })
})

it('reports a tool step\'s streamed TokenDelta and charges the resumed turn only the rest', async () => {
  const feed = new Feed()
  const run = newRun(feed)
  feed.push(tokenFrame(5), tokenFrame(7), mcpFrame(2, 'call-a', { city: 'Paris' }), checkpointFrame())
  const first = await collect(run.events())
  // Cursor sends no turn totals mid-turn: the streamed count is all there is.
  expect(first.at(-1)?.usage).toEqual({ prompt_tokens: 0, completion_tokens: 12, total_tokens: 12 })
  run.answer(answers([[first[0]?.delta?.tool_calls?.[0]?.id ?? '', 'sunny']]))
  feed.push(tokenFrame(3), textFrame('done'), turnEnded({ input: 900, output: 30, reasoning: 40 }))
  // Cumulative output 30 minus the 12 already reported; reasoning never exceeds it.
  expect((await collect(run.events())).at(-1)?.usage).toEqual({
    prompt_tokens: 900,
    completion_tokens: 18,
    total_tokens: 918,
    completion_tokens_details: { reasoning_tokens: 18 },
  })
})

it('invents no usage when Cursor reports none, and the local budget is never provider usage', async () => {
  const none = new Feed()
  none.push(textFrame('ok'), turnEnded())
  expect('usage' in ((await collect(cursorEvents(none, () => {}))).at(-1) ?? {})).toBe(false)
  const run = (limit: number) => {
    const feed = new Feed()
    feed.push(tokenFrame(40), textFrame('one two three four five six seven eight nine ten'), turnEnded({ input: 500, output: 40 }))
    return collect(limitNativeOutput(cursorEvents(feed, () => {}), limit, () => {}))
  }
  // Cut by the local o200k budget: Cursor's totals are unknown, so none are claimed.
  const cut = await run(3)
  expect(cut.at(-1)?.finish).toBe('length')
  expect(cut.some(event => event.usage)).toBe(false)
  // Within budget the provider's own numbers pass through untouched.
  expect((await run(1000)).at(-1)?.usage).toEqual({ prompt_tokens: 500, completion_tokens: 40, total_tokens: 540 })
})

it('answers context, shell, and built-in requests locally and keeps tool definitions', async () => {
  const written: Buffer[] = []
  const feed = new Feed()
  feed.push(
    // Frames without ids answer id 0.
    frame(pb(4, pb(2, Buffer.alloc(0)))),
    frame(pb(2, concat(pb(15, 'anonymous-shell'), pb(14, pb(1, 'echo'))))),
    tokenFrame(0),
    textFrame(''),
    frame(pb(2, concat(pb(1, 7), pb(15, 'context'), pb(10, Buffer.alloc(0))))),
    frame(pb(2, concat(pb(1, 8), pb(15, 'state'), pb(36, Buffer.alloc(0))))),
    frame(pb(2, concat(pb(1, 9), pb(15, 'shell'), pb(14, pb(1, 'echo'))))),
    frame(pb(2, concat(pb(1, 10), pb(15, 'read'), pb(2, Buffer.alloc(0))))),
    frame(pb(2, concat(pb(1, 11), pb(15, 'ls'), pb(9, Buffer.alloc(0))))),
    frame(pb(4, concat(pb(1, 3), pb(2, Buffer.alloc(0))))),
    frame(pb(4, concat(pb(1, 4), pb(3, Buffer.alloc(0)), pb(4, 'ctx')))),
    textFrame('hi'),
    turnEnded(),
  )
  expect((await collect(newRun(feed, written).events())).map(event => event.delta?.content ?? event.finish)).toEqual(['hi', 'stop'])
  // anonymous KV, anonymous shell reject + close, context, state, shell reject + close, read, ls, two KV answers
  expect(written).toHaveLength(11)
  const unsupportedKv = new Feed()
  unsupportedKv.push(frame(pb(4, pb(1, 3))))
  await expect(collect(newRun(unsupportedKv).events())).rejects.toThrow('Unsupported Cursor KV request')
  const unknown = new Feed()
  unknown.push(frame(pb(2, concat(pb(1, 1), pb(15, 'x'), pb(99, Buffer.alloc(0))))))
  await expect(collect(newRun(unknown).events())).rejects.toThrow('Unsupported Cursor IDE tool request (99)')
  const bare = new Feed()
  bare.push(frame(pb(2, concat(pb(1, 1), pb(15, 'x')))))
  await expect(collect(newRun(bare).events())).rejects.toThrow('request (missing)')
})

it('advertises only caller tools in the MCP state answer', async () => {
  const written: Buffer[] = []
  const feed = new Feed()
  feed.push(frame(pb(2, concat(pb(1, 8), pb(15, 'state'), pb(36, Buffer.alloc(0))))), textFrame('x'), turnEnded())
  await collect(new CursorRun(feed, data => written.push(data), 'cursor/test').events())
  // No tools: the server list is empty.
  expect(decoded(written)[0]?.has(2)).toBe(true)
  expect(written[0]?.length).toBeLessThan(40)
})

it('strips composer thinking and exposes the answer across split deltas', async () => {
  const thinking = (value: string) => frame(pb(1, pb(4, pb(1, value))))
  const feed = new Feed()
  feed.push(thinking('private</thi'), thinking('nk> Answer'), thinking(' here'), thinking(''), turnEnded())
  const out = await collect(cursorEvents(feed, () => {}, 'cursor/composer-test'))
  expect(out.flatMap(event => event.delta?.content ?? [])).toEqual(['Answer', ' here'])
  const plain = new Feed()
  plain.push(thinking('plan'), thinking(''), textFrame('answer'), turnEnded())
  expect((await collect(cursorEvents(plain, () => {}, 'cursor/gpt'))).flatMap(event => event.delta?.reasoning_content ?? [])).toEqual(['plan'])
  const huge = new Feed()
  huge.push(thinking('x'.repeat(MAX_NATIVE_FRAME - 100)), thinking('y'.repeat(200)))
  await expect(collect(cursorEvents(huge, () => {}, 'composer'))).rejects.toThrow('thinking exceeds bounds')
})

it('accepts gzip frames and maps trailer errors, malformed frames, and truncated streams', async () => {
  const gz = frame(gzipSync(pb(1, pb(1, pb(1, 'compressed')))))
  gz[0] = 1
  const ok = new Feed()
  ok.push(gz, turnEnded())
  expect((await collect(cursorEvents(ok, () => {}))).flatMap(event => event.delta?.content ?? [])).toEqual(['compressed'])

  const trailer = (body: unknown) => {
    const out = frame(Buffer.from(JSON.stringify(body)))
    out[0] = 2
    return out
  }
  const generic = new Feed()
  generic.push(trailer({ error: { code: 'permission_denied' } }))
  await expect(collect(cursorEvents(generic, () => {}))).rejects.toThrow('Connect stream error')
  const clean = new Feed()
  clean.push(trailer({}), textFrame('after'), turnEnded())
  expect((await collect(cursorEvents(clean, () => {}))).at(-1)?.finish).toBe('stop')
  const quota = new Feed()
  quota.push(trailer({ error: { code: 'resource_exhausted', details: [{
    type: 'aiserver.v1.ErrorDetails', debug: { details: { additionalInfo: { limitType: 'included_usage' } } },
  }] } }))
  await expect(collect(cursorEvents(quota, () => {}))).rejects.toBeInstanceOf(CursorQuotaError)

  const huge = Buffer.alloc(5)
  huge.writeUInt32BE(MAX_NATIVE_FRAME + 1, 1)
  const oversized = new Feed()
  oversized.push(huge)
  await expect(collect(cursorEvents(oversized, () => {}))).rejects.toThrow('Invalid Cursor Connect frame')
  const partial = new Feed()
  partial.push(Buffer.from([0, 0, 0, 0, 9, 1]), Buffer.alloc(0))
  partial.end()
  await expect(collect(cursorEvents(partial, () => {}))).rejects.toThrow('complete turn')
  const truncated = new Feed()
  truncated.push(textFrame('unfinished'))
  truncated.end()
  await expect(collect(cursorEvents(truncated, () => {}))).rejects.toThrow('complete turn')
})

it('maps Connect quota and plan refusals to typed errors without exposing upstream text', () => {
  const detail = (title: string, extra: Record<string, unknown> = {}) => ({
    code: 'resource_exhausted',
    details: [{ type: 'aiserver.v1.ErrorDetails', debug: { details: { title, ...extra } } }],
  })
  expect(cursorConnectError(detail('You have hit your usage limit'))).toBeInstanceOf(CursorQuotaError)
  expect(cursorConnectError(detail('x', { additionalInfo: { spendLimitHit: 'true' } }))).toBeInstanceOf(CursorQuotaError)
  const plan = cursorConnectError(detail('This model is not available on your plan'))
  expect(plan).toBeInstanceOf(CursorModelUnavailableError)
  expect(plan).toMatchObject({ status: 403, code: 'cursor_model_unavailable', type: 'permission_error', accountFailure: false })
  expect(new CursorQuotaError()).toMatchObject({ status: 429, code: 'cursor_usage_limit', name: 'CursorQuotaError' })
  // The encoded detail value wins over the debug title; malformed values fall back to it.
  const encoded = Buffer.from(pb(2, pb(1, 'Spending limit reached'))).toString('base64')
  expect(cursorConnectError({ code: 'resource_exhausted', details: [{
    type: 'aiserver.v1.ErrorDetails', value: encoded, debug: { details: { title: 'neutral' } },
  }] })).toBeInstanceOf(CursorQuotaError)
  expect(cursorConnectError({ code: 'resource_exhausted', details: [{
    type: 'aiserver.v1.ErrorDetails', value: '!!', debug: { details: { title: 'model unavailable' } },
  }] })).toBeInstanceOf(CursorModelUnavailableError)
  expect(cursorConnectError({ code: 'resource_exhausted', details: [{
    type: 'aiserver.v1.ErrorDetails', value: Buffer.from([255, 255]).toString('base64'),
  }] }).message).toBe('Cursor returned a Connect stream error')
  for (const error of [
    detail('something else'), { code: 'resource_exhausted' }, { code: 'resource_exhausted', details: [{ type: 'other' }] },
    { code: 'internal' }, 'string', null,
  ])
    expect(cursorConnectError(error).message).toBe('Cursor returned a Connect stream error')
  expect(decodeProto(Buffer.alloc(0)).size).toBe(0)
})
