/** Native wire regression fixtures adapted from auth2api. */
import { z } from 'zod'
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { gzipSync } from 'node:zlib'
import { crc32, decodeKiroFrame, kiroEvents, kiroRequest } from '../src/native/kiro-api.ts'
import { cursorEvents, cursorRequest } from '../src/native/cursor-api.ts'
import { CursorTurns } from '../src/native/cursor-turns.ts'
import {
  bytes,
  decodeProto,
  decodeValue,
  encodeValue,
  frame,
  nested,
  pb,
  str,
} from '../src/native/subscription-protobuf.ts'
import { MAX_NATIVE_FRAME, nativeChatResponse } from '../src/native/subscription-stream.ts'
import type { SubscriptionGrant } from '../src/protocol.ts'
const responseSchema = z.object({
  choices: z.tuple([
    z.object({
      finish_reason: z.string(),
      message: z.object({
        content: z.string().nullable(),
        tool_calls: z.array(z.object({ function: z.object({ name: z.string(), arguments: z.string() }) })).optional(),
      }),
    }),
  ]),
})
const token: SubscriptionGrant = {
  provider: 'kiro',
  accessToken: 'access-secret',
  refreshToken: 'refresh-secret',
  expiresAt: '2099-01-01T00:00:00.000Z',
}
const config = { timeouts: { 'messages-ms': 1000, 'stream-messages-ms': 1000 } }
const concat = (...values: Uint8Array[]) => Buffer.concat(values)
const tool = {
  type: 'function' as const,
  function: { name: 'weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
}
function awsFrame(type: string, payload: unknown, messageType = 'event') {
  const headers = concat(
    ...Object.entries({
      ':event-type': type,
      ':message-type': messageType,
    }).map(([name, value]) => {
      const key = Buffer.from(name)
      const val = Buffer.from(value)
      const length = Buffer.alloc(2)
      length.writeUInt16BE(val.length)
      return concat(Buffer.from([key.length]), key, Buffer.from([7]), length, val)
    }),
  )
  const data = Buffer.from(JSON.stringify(payload))
  const prelude = Buffer.alloc(12)
  prelude.writeUInt32BE(16 + headers.length + data.length)
  prelude.writeUInt32BE(headers.length, 4)
  prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8)
  const out = concat(prelude, headers, data, Buffer.alloc(4))
  out.writeUInt32BE(crc32(out.subarray(0, -4)), out.length - 4)
  return out
}
function chunks(data: Buffer, size = 3): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset === data.length) {
        controller.close()
        return
      }
      const end = Math.min(data.length, offset + size)
      controller.enqueue(data.subarray(offset, end))
      offset = end
    },
  })
}
async function* iterable(data: Buffer, size = 2) {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size)
}
const textFrame = (text: string) => frame(pb(1, pb(1, pb(1, text))))
const doneFrame = () => frame(pb(1, pb(14, Buffer.alloc(0))))

test('Kiro request preserves system, alternating history, tool results, schema, and inference limits', () => {
  const body = {
    model: 'kiro/claude-example',
    max_tokens: 100,
    temperature: 0,
    tools: [tool],
    messages: [
      { role: 'system', content: 'system instructions' },
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'sunny' },
    ],
  }
  const payload = kiroRequest(body, token)
  assert.match(payload.conversationState.history[0]?.userInputMessage?.content ?? '', /system instructions/)
  assert.deepEqual(payload.conversationState.history[1]?.assistantResponseMessage?.toolUses?.[0]?.input, {
    city: 'Paris',
  })
  assert.equal(
    payload.conversationState.currentMessage.userInputMessage?.userInputMessageContext?.toolResults?.[0]?.toolUseId,
    'call-1',
  )
  assert.deepEqual(payload.inferenceConfig, { maxTokens: 100, temperature: 0 })
  assert.throws(
    () =>
      kiroRequest(
        {
          ...body,
          messages: [{ role: 'tool', tool_call_id: 'orphan', content: 'bad' }],
        },
        token,
      ),
    /no matching/,
  )
})

test('Kiro parser handles fragmented frames, tools and terminal evidence', async () => {
  const data = concat(
    awsFrame('assistantResponseEvent', { content: 'Hello' }),
    awsFrame('toolUseEvent', {
      toolUseId: 'id',
      name: 'weather',
      input: '{"city":',
    }),
    awsFrame('toolUseEvent', {
      toolUseId: 'id',
      input: '"Paris"}',
      stop: true,
    }),
    awsFrame('messageStopEvent', { stopReason: 'tool_use' }),
  )
  const result = await (await nativeChatResponse(kiroEvents(chunks(data)), 'kiro/test', false))
    .json()
    .then(value => responseSchema.parse(value))
  assert.equal(result.choices[0].message.content, 'Hello')
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.choices[0].message.tool_calls?.at(0)?.function.arguments, '{"city":"Paris"}')
  const sse = await (await nativeChatResponse(kiroEvents(chunks(data)), 'kiro/test', true)).text()
  assert.match(sse, /"tool_calls"/)
  assert.match(sse, /data: \[DONE\]/)
})

test('Kiro live empty-argument tools complete without per-tool stop', async () => {
  const input = concat(
    awsFrame('toolUseEvent', { toolUseId: 'id', name: 'weather' }),
    awsFrame('toolUseEvent', { toolUseId: 'id', name: 'weather', input: '' }),
    awsFrame('contextUsageEvent', { contextUsagePercentage: 2 }),
    awsFrame('meteringEvent', { usage: 0.004 }),
  )
  const result = await (await nativeChatResponse(kiroEvents(chunks(input), new Set(['weather'])), 'kiro/test', false))
    .json()
    .then(value => responseSchema.parse(value))
  assert.equal(result.choices[0].finish_reason, 'tool_calls')
  assert.equal(result.choices[0].message.tool_calls?.at(0)?.function.arguments, '{}')
  await assert.rejects(async () => {
    for await (const _ of kiroEvents(
      chunks(
        concat(
          awsFrame('toolUseEvent', {
            toolUseId: 'id',
            name: 'weather',
            input: '{"incomplete":',
          }),
          awsFrame('contextUsageEvent', {}),
          awsFrame('meteringEvent', {}),
        ),
      ),
    )) {
      /* consume */
    }
  })
})

test('Kiro parser rejects corrupted, oversized, truncated and nonterminal responses', async () => {
  const valid = awsFrame('assistantResponseEvent', { content: 'hello' })
  const corrupt = Buffer.from(valid)
  corrupt[12] = corrupt.readUInt8(12) ^ 1
  assert.throws(() => decodeKiroFrame(corrupt), /checksum/)
  for (const data of [corrupt, valid, valid.subarray(0, -1), awsFrame('error', {}, 'exception')]) {
    await assert.rejects(async () => {
      for await (const _ of kiroEvents(chunks(data))) {
        /* drain */
      }
    })
  }
  const huge = Buffer.alloc(12)
  huge.writeUInt32BE(MAX_NATIVE_FRAME + 1)
  await assert.rejects(async () => {
    for await (const _ of kiroEvents(chunks(huge))) {
      /* drain */
    }
  }, /bounds/)
})

test('protobuf preserves structured values and rejects malformed lengths', () => {
  const input = { value: [null, true, 1.25, 'text'], nested: { a: 2 } }
  assert.equal(JSON.stringify(decodeValue(encodeValue(input))), JSON.stringify(input))
  assert.throws(() => decodeProto(Buffer.from([10, 255])), /Truncated/)
  assert.throws(() => decodeProto(Buffer.from([10, 10, 0])), /length/)
  const proto: unknown = JSON.parse('{"__proto__":{"polluted":true}}')
  const decoded = decodeValue(encodeValue(proto))
  assert.equal(Object.getPrototypeOf(decoded), null)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
})

test('Cursor request uses AgentService protobuf and retains trailing tool-result history', () => {
  const encoded = cursorRequest({
    model: 'cursor/model',
    tools: [tool],
    messages: [
      { role: 'system', content: 'instructions' },
      { role: 'user', content: 'question' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'one', function: { name: 'weather', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'one', content: 'sunny' },
    ],
  })
  assert.equal(encoded.readUInt32BE(1), encoded.length - 5)
  const run = nested(decodeProto(encoded.subarray(5)), 1)
  assert.equal(str(nested(run, 9), 1), 'model')
  assert.ok(run.has(4))
  const action = nested(nested(run, 2), 1)
  const user = nested(action, 1)
  assert.match(str(user, 1), /instructions/)
  assert.match(str(user, 1), /sunny/)
  assert.match(str(user, 1), /Completed tool call one/)
  assert.match(str(user, 1), /tool_call id=one name=weather/)
  assert.match(str(user, 1), /user: question/)
  assert.equal(action.has(7), false)
})

test('native adapters reject unsupported controls instead of silently changing requests', async () => {
  const body = {
    model: 'cursor/test',
    messages: [{ role: 'user', content: 'hi' }],
  }
  for (const field of ['temperature', 'top_p', 'response_format']) {
    assert.throws(() => cursorRequest({ ...body, [field]: 1 }), new RegExp(field))
  }
  assert.throws(() => kiroRequest({ ...body, model: 'kiro/test', reasoning_effort: 'high' }, token), /reasoning_effort/)
  assert.throws(() => kiroRequest({ ...body, model: 'kiro/test', tool_choice: 'required' }, token), /tool_choice/)
  const cursor = new CursorTurns()
  await assert.rejects(cursor.call({
    body: { ...body, max_tokens: 0 },
    account: { token },
    config,
  }), /positive safe integer/)
  for (const field of ['max_tokens', 'max_completion_tokens']) {
    assert.doesNotThrow(() => cursorRequest({ ...body, [field]: 1024 }))
    for (const value of [null, 0, -1, 1.5, '100', Infinity, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => cursorRequest({ ...body, [field]: value }), /positive safe integer/)
  }
})

test('Cursor accepts bounded gzip frames and rejects trailer errors and oversized frames', async () => {
  const compressed = frame(gzipSync(pb(1, pb(1, pb(1, 'compressed')))))
  compressed[0] = 1
  const response = await nativeChatResponse(
    cursorEvents(iterable(concat(compressed, doneFrame())), () => {}),
    'cursor/test',
    false,
  )
  assert.equal(
    (await response.json().then(value => responseSchema.parse(value))).choices[0].message.content,
    'compressed',
  )
  const trailer = frame(Buffer.from('{"error":{"code":"permission_denied"}}'))
  trailer[0] = 2
  await assert.rejects(
    nativeChatResponse(
      cursorEvents(iterable(trailer), () => {}),
      'cursor/test',
      false,
    ),
    /Connect stream error/,
  )
  const huge = Buffer.alloc(5)
  huge.writeUInt32BE(MAX_NATIVE_FRAME + 1, 1)
  await assert.rejects(
    nativeChatResponse(
      cursorEvents(iterable(huge), () => {}),
      'cursor/test',
      false,
    ),
    /Invalid Cursor/,
  )
})

test('Cursor MCP state advertises caller tools and ignores tracing metadata', async () => {
  const replies: Buffer[] = []
  const input = concat(
    frame(pb(2, concat(pb(1, 7), pb(15, 'state'), pb(19, Buffer.alloc(0)), pb(36, Buffer.alloc(0))))),
    frame(pb(2, concat(pb(1, 8), pb(15, 'builtin'), pb(19, Buffer.alloc(0)), pb(55, 1), pb(7, Buffer.alloc(0))))),
    textFrame('hello'),
    doneFrame(),
  )
  await nativeChatResponse(
    cursorEvents(
      iterable(input),
      (reply) => {
        replies.push(reply)
      },
      'cursor/test',
      new Set(['weather']),
      [tool],
    ),
    'cursor/test',
    false,
  )
  assert.equal(replies.length, 2)
  const state = nested(decodeProto(replies.at(0)?.subarray(5) ?? Buffer.alloc(0)), 2)
  assert.equal(str(state, 15), 'state')
  const server = nested(nested(nested(state, 36), 1), 1)
  assert.equal(str(server, 2), 'fi')
  assert.equal(str(nested(server, 5), 1), 'weather')
  assert.deepEqual(JSON.parse(JSON.stringify(decodeValue(bytes(nested(server, 5), 3)))), tool.function.parameters)
  const rejected = nested(decodeProto(replies.at(1)?.subarray(5) ?? Buffer.alloc(0)), 2)
  assert.equal(str(rejected, 15), 'builtin')
  assert.ok(rejected.has(7))
})

test('Cursor Composer answer after thinking remains visible across split deltas', async () => {
  const thinking = (value: string) => frame(pb(1, pb(4, pb(1, value))))
  const data = concat(thinking('private</thi'), thinking('nk> Answer'), thinking(' here'), doneFrame())
  const reply = await nativeChatResponse(
    cursorEvents(iterable(data), () => {}, 'cursor/composer-test'),
    'cursor/composer-test',
    false,
  )
  assert.equal(
    (await reply.json().then(value => responseSchema.parse(value))).choices[0].message.content,
    'Answer here',
  )
})

test('Kiro incomplete tools and unknown terminal reasons fail closed', async () => {
  for (const data of [
    concat(
      awsFrame('toolUseEvent', {
        toolUseId: 'id',
        name: 'weather',
        input: '{',
      }),
      awsFrame('messageStopEvent', { stopReason: 'tool_use' }),
    ),
    concat(
      awsFrame('assistantResponseEvent', { content: 'partial' }),
      awsFrame('messageStopEvent', { stopReason: 'guardrail_intervened' }),
    ),
  ])
    await assert.rejects(nativeChatResponse(kiroEvents(chunks(data)), 'kiro/test', false))
})

test('Cursor handles context/KV requests, fragmented text, errors and tool values', async () => {
  const replies: Buffer[] = []
  const data = concat(
    frame(pb(2, concat(pb(1, 7), pb(15, 'exec'), pb(10, Buffer.alloc(0))))),
    frame(pb(4, concat(pb(1, 8), pb(2, Buffer.alloc(0))))),
    textFrame('hello'),
    doneFrame(),
  )
  const response = await nativeChatResponse(
    cursorEvents(iterable(data), b => replies.push(b)),
    'cursor/test',
    false,
  )
  assert.equal((await response.json().then(value => responseSchema.parse(value))).choices[0].message.content, 'hello')
  assert.equal(replies.length, 2)
  const mcp = concat(
    pb(1, 'weather'),
    pb(2, concat(pb(1, 'city'), pb(2, encodeValue('Paris')))),
    pb(3, 'call-1'),
    pb(5, 'weather'),
  )
  const call = frame(pb(2, pb(11, mcp)))
  const result = await (
    await nativeChatResponse(
      cursorEvents(iterable(call), () => {}),
      'cursor/test',
      false,
    )
  )
    .json()
    .then(value => responseSchema.parse(value))
  assert.equal(result.choices[0].message.tool_calls?.at(0)?.function.arguments, '{"city":"Paris"}')
  await assert.rejects(
    nativeChatResponse(
      cursorEvents(iterable(call), () => {}, 'test', new Set()),
      'test',
      false,
    ),
    /undeclared/,
  )
  await assert.rejects(
    nativeChatResponse(
      cursorEvents(iterable(textFrame('unfinished')), () => {}),
      'test',
      false,
    ),
    /complete turn/,
  )
})

test('Cursor declines streamed shell requests and continues JSON and SSE', async () => {
  for (const stream of [false, true]) {
    const replies: Buffer[] = []
    async function* source() {
      yield frame(pb(2, concat(pb(1, 42), pb(15, 'shell-exec'), pb(14, pb(1, 'echo forbidden')))))
      assert.equal(replies.length, 2)
      const result = nested(decodeProto(replies.at(0)?.subarray(5) ?? Buffer.alloc(0)), 2)
      assert.equal(Number(result.get(1)?.[0]), 42)
      assert.equal(str(result, 15), 'shell-exec')
      const rejected = nested(nested(result, 14), 5)
      assert.match(str(rejected, 3), /unavailable/i)
      assert.equal(str(rejected, 1), '')
      const close = nested(nested(decodeProto(replies.at(1)?.subarray(5) ?? Buffer.alloc(0)), 5), 1)
      assert.equal(Number(close.get(1)?.[0]), 42)
      yield textFrame('OK')
      yield doneFrame()
    }
    const response = await nativeChatResponse(
      cursorEvents(source(), data => replies.push(data)),
      'cursor/test',
      stream,
    )
    if (stream) {
      const body = await response.text()
      assert.match(body, /"content":"OK"/)
      assert.match(body, /"finish_reason":"stop"/)
      assert.match(body, /data: \[DONE\]/)
    } else {
      const body = await response.json().then(value => responseSchema.parse(value))
      assert.equal(body.choices[0].message.content, 'OK')
      assert.equal(body.choices[0].finish_reason, 'stop')
    }
  }
})
